"""AirSensor's temperature-source selection — which thermometer wins, and when.

The whole point of this class is not publishing the onboard chip's self-heated
temperature as air temperature, so the fallback rules are worth pinning down.
"""

import logging

import pytest

from weatherstation.sensors import air, ds18b20
from weatherstation.sensors.air import AirSensor


class _FakeBMP:
    def __init__(self, temp_c=27.9, pressure=1012.0):
        self.temp_c, self.pressure = temp_c, pressure

    def read(self):
        return self.temp_c, self.pressure


class _FakeHTU:
    def __init__(self, temp_c=27.3, rh=40.0):
        self.temp_c, self.rh = temp_c, rh

    def read_temp_rh(self):
        return self.temp_c, self.rh


class _FakeProbe:
    def __init__(self, temp_c=17.0):
        self.temp_c = temp_c
        self.device_path = "/sys/bus/w1/devices/28-fake/w1_slave"

    def read_c(self):
        return self.temp_c


def _build(monkeypatch, source="auto", *, present, probe=None, bmp=None, htu=None):
    """AirSensor with the 1-Wire bus faked to hold a probe (or not)."""
    monkeypatch.setattr(ds18b20, "available", lambda: present)
    monkeypatch.setattr(ds18b20, "DS18B20Sensor", lambda *a, **k: probe or _FakeProbe())
    return AirSensor(source, bmp=bmp or _FakeBMP(), htu=htu or _FakeHTU())


def test_probe_temperature_wins_over_the_self_heated_onboard_chip(monkeypatch):
    sensor = _build(monkeypatch, present=True, probe=_FakeProbe(17.0))
    temp_c, rh, pressure = sensor.read()
    assert sensor.temp_source == "ds18b20"
    assert temp_c == 17.0
    assert pressure == 1012.0
    # RH measured at the hot chip is re-expressed at the true air temperature,
    # so it rises well above the 40% the chip reported.
    assert rh > 70.0


def test_falls_back_to_onboard_when_no_probe_and_says_so(monkeypatch, caplog):
    with caplog.at_level(logging.WARNING):
        sensor = _build(monkeypatch, present=False)
    assert sensor.temp_source == "onboard"
    assert sensor.read()[0] == 27.9
    # A silent fallback is the bug this warning exists to prevent.
    assert "no DS18B20 found" in caplog.text


def test_auto_picks_up_a_probe_that_appears_after_startup(monkeypatch):
    """The w1 bus can enumerate after the collector starts; don't latch at boot."""
    sensor = _build(monkeypatch, present=False)
    assert sensor.temp_source == "onboard"

    monkeypatch.setattr(ds18b20, "available", lambda: True)
    monkeypatch.setattr(air, "_REDETECT_INTERVAL_S", 0.0)
    sensor._next_redetect = 0.0

    assert sensor.read()[0] == 17.0
    assert sensor.temp_source == "ds18b20"


def test_onboard_mode_never_looks_for_a_probe(monkeypatch):
    sensor = _build(monkeypatch, "onboard", present=True)
    assert sensor.temp_source == "onboard"
    assert sensor.read()[0] == 27.9


def test_ds18b20_mode_fails_loudly_when_the_probe_is_missing(monkeypatch):
    def _raise(*a, **k):
        raise RuntimeError("no DS18B20 found")

    monkeypatch.setattr(ds18b20, "available", lambda: False)
    monkeypatch.setattr(ds18b20, "DS18B20Sensor", _raise)
    with pytest.raises(RuntimeError):
        AirSensor("ds18b20", bmp=_FakeBMP(), htu=_FakeHTU())


def test_a_failed_probe_read_falls_back_for_that_cycle_only(monkeypatch, caplog):
    probe = _FakeProbe(17.0)
    sensor = _build(monkeypatch, present=True, probe=probe)

    probe.temp_c = None
    with caplog.at_level(logging.WARNING):
        temp_c, rh, _ = sensor.read()
    assert temp_c == 27.9
    assert rh == 40.0  # no probe temperature to re-express RH against
    assert "DS18B20 read failed" in caplog.text

    probe.temp_c = 17.0
    assert sensor.read()[0] == 17.0


def test_unknown_source_is_rejected():
    with pytest.raises(ValueError):
        AirSensor("bme280", bmp=_FakeBMP(), htu=_FakeHTU())
