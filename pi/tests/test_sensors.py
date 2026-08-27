import pytest

from weatherstation.core import units
from weatherstation.sensors.air_quality import AirQualitySensor
from weatherstation.sensors.ds18b20 import DS18B20Sensor
from weatherstation.sensors.mcp342x import MCP342X


def test_rh_from_dewpoint_inverts_dewpoint():
    dp = units.dewpoint_c(27.0, 40.0)
    # same temperature -> same RH we started from
    assert abs(units.rh_from_dewpoint(27.0, dp) - 40.0) < 0.5
    # cooler air at the same dewpoint -> higher RH
    assert units.rh_from_dewpoint(18.0, dp) > 55.0


def _write(p, body):
    p.write_text(body)
    return DS18B20Sensor(str(p))


def test_ds18b20_parses_good_reading(tmp_path):
    s = _write(
        tmp_path / "w1_slave",
        "2e 01 4b 46 7f ff 02 10 38 : crc=38 YES\n2e 01 4b 46 7f ff 02 10 38 t=18875\n",
    )
    assert s.read_c() == 18.875


def test_ds18b20_rejects_bad_crc_and_reset_sentinel(tmp_path):
    bad_crc = _write(
        tmp_path / "a",
        "2e 01 4b 46 7f ff 02 10 38 : crc=38 NO\n2e 01 4b 46 7f ff 02 10 38 t=18875\n",
    )
    assert bad_crc.read_c() is None

    reset = _write(
        tmp_path / "b",
        "ff 05 4b 46 7f ff 0c 10 21 : crc=21 YES\nff 05 4b 46 7f ff 0c 10 21 t=85000\n",
    )
    assert reset.read_c() is None


class _FakeADC:
    def __init__(self, value):
        self.value = value

    def read(self, channel=0):
        return self.value


def test_air_quality_index_scales_adc_inversely():
    # divider pulled to the rail -> maximum "contaminants" index
    assert AirQualitySensor(warmup_s=0, adc=_FakeADC(0)).read_index() == 100.0
    # full-scale ADC -> zero index
    full_scale = AirQualitySensor(warmup_s=0, adc=_FakeADC(round(MCP342X.MAX))).read_index()
    assert full_scale == pytest.approx(0.0, abs=1e-6)
    # midpoint -> ~50
    mid = AirQualitySensor(warmup_s=0, adc=_FakeADC(round(MCP342X.MAX / 2))).read_index()
    assert mid == pytest.approx(50.0, abs=0.1)


def test_air_quality_suppresses_reading_during_warmup():
    assert AirQualitySensor(warmup_s=999, adc=_FakeADC(0)).read_index() is None


def test_air_quality_passes_through_not_ready_adc_sample():
    assert AirQualitySensor(warmup_s=0, adc=_FakeADC(None)).read_index() is None
