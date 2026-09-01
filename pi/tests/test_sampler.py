"""Sampler wind aggregation — the arithmetic that turned a breeze into 250 km/h.

On 2026-09-01 the station published a 70.6 m/s (254 km/h) gust. The archive
record before it was 185 s old against a 66 s median: an upload had stalled the
sampling loop for two minutes while the anemometer's interrupt handler kept
counting. The next sample divided ~125 s of pulses by the nominal 5 s window and
read 25x high. These tests pin down that a sample is measured against real
elapsed time, and that anything still absurd is dropped rather than published.
"""

from __future__ import annotations

import pytest

from weatherstation.core import sampler as sampler_mod
from weatherstation.core.sampler import MAX_PLAUSIBLE_WIND_MS, Sampler
from weatherstation.sensors.anemometer import Anemometer

RADIUS_CM = 9.0
ADJUSTMENT = 2.36


class _FakeConfig(dict):
    """cfg.<key> access, matching the real Config."""

    def __getattr__(self, key):
        val = self[key]
        return _FakeConfig(val) if isinstance(val, dict) else val


class _Clock:
    """Monotonic clock the test advances by hand; sleep() just moves it."""

    def __init__(self):
        self.t = 1000.0

    def monotonic(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


class _ScriptedAnemometer:
    """Returns a scripted pulse count per read, and stalls the clock on cue.

    `stalls` maps a read index to extra seconds burnt *before* that read, standing
    in for an upload that blocked the loop.
    """

    def __init__(self, clock, pulses, stalls=None):
        self.clock = clock
        self.pulses = list(pulses)
        self.stalls = stalls or {}
        self.reads = 0

    def read_and_reset(self):
        self.clock.advance(self.stalls.get(self.reads, 0.0))
        p = self.pulses[self.reads]
        self.reads += 1
        return p

    @staticmethod
    def speed_ms(pulses, seconds, radius_cm, adjustment):
        return Anemometer.speed_ms(pulses, seconds, radius_cm, adjustment)


class _StubVane:
    def read_deg(self):
        return 315


class _StubRain:
    def read_and_reset(self):
        return 0


class _StubAir:
    def read(self):
        return (12.0, 80.0, 1013.0)


class _StubBuffer:
    def __init__(self):
        self.records = []

    def append(self, record):
        self.records.append(record)


def _pulses_for(speed_ms, seconds):
    """Pulse count that a genuine `speed_ms` wind produces over `seconds`.

    Rounded to a whole pulse, so short windows quantise: 5 m/s over 5 s is 37.5
    pulses, and 37 of them read back as 4.94 m/s. Hence the 0.1 tolerances below.
    """
    per_pulse = Anemometer.speed_ms(1, 1.0, RADIUS_CM, ADJUSTMENT)
    return round(speed_ms * seconds / per_pulse)


def _run_one_archive(monkeypatch, pulses, stalls=None, wind_dt=5, archive_dt=60):
    """Drive run_forever through exactly one archive cycle and return the record."""
    clock = _Clock()
    anemo = _ScriptedAnemometer(clock, pulses, stalls)
    buffer = _StubBuffer()

    monkeypatch.setattr(sampler_mod.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(sampler_mod.time, "sleep", lambda s: clock.advance(s))

    cfg = _FakeConfig(
        sampling={"wind_sample_s": wind_dt, "archive_interval_s": archive_dt},
        calibration={
            "anemometer_radius_cm": RADIUS_CM,
            "anemometer_adjustment": ADJUSTMENT,
            "rain_bucket_mm": 0.2794,
        },
        station={"elevation_m": 20},
    )
    s = Sampler(cfg, _StubAir(), anemo, _StubRain(), _StubVane(), buffer, uploaders=[])

    # run_forever loops forever; stop it once the first record is stored.
    def _stop(record):
        buffer.records.append(record)
        raise KeyboardInterrupt

    buffer.append = _stop
    with pytest.raises(KeyboardInterrupt):
        s.run_forever()
    return buffer.records[0]


def test_steady_wind_reads_back_at_its_true_speed(monkeypatch):
    """12 undisturbed samples of a 5 m/s wind archive as 5 m/s, mean and gust."""
    pulses = [_pulses_for(5.0, 5.0)] * 12
    rec = _run_one_archive(monkeypatch, pulses)
    assert rec.wind_speed_ms == pytest.approx(5.0, abs=0.1)
    assert rec.wind_gust_ms == pytest.approx(5.0, abs=0.1)


def test_stalled_upload_does_not_inflate_the_gust(monkeypatch):
    """The regression: a stall before the first read must not read as a gust.

    A 25 s stall means the first sample legitimately covers 30 s of pulses.
    Against real elapsed time that is still 5 m/s; against the nominal 5 s window
    it is 30 m/s. The stall is sized so the inflated figure lands *below*
    MAX_PLAUSIBLE_WIND_MS — otherwise the ceiling would discard it and this test
    would pass on the old arithmetic too, testing nothing.
    """
    pulses = [_pulses_for(5.0, 30.0)] + [_pulses_for(5.0, 5.0)] * 11
    rec = _run_one_archive(monkeypatch, pulses, stalls={0: 25.0})

    assert rec.wind_gust_ms == pytest.approx(5.0, abs=0.1)
    assert rec.wind_speed_ms == pytest.approx(5.0, abs=0.1)


def test_ceiling_catches_a_stall_too_large_for_the_timing_fix_to_matter(monkeypatch):
    """Belt and braces: the 120 s stall that actually happened, both guards live."""
    pulses = [_pulses_for(5.0, 125.0)] + [_pulses_for(5.0, 5.0)] * 11
    rec = _run_one_archive(monkeypatch, pulses, stalls={0: 120.0})

    assert rec.wind_gust_ms == pytest.approx(5.0, abs=0.1)
    assert rec.wind_speed_ms == pytest.approx(5.0, abs=0.1)


def test_implausible_sample_is_dropped_not_published(monkeypatch):
    """A sample past the ceiling leaves the record entirely — mean and gust."""
    absurd = _pulses_for(MAX_PLAUSIBLE_WIND_MS + 20, 5.0)
    pulses = [absurd] + [_pulses_for(4.0, 5.0)] * 11
    rec = _run_one_archive(monkeypatch, pulses)

    assert rec.wind_gust_ms == pytest.approx(4.0, abs=0.1)
    assert rec.wind_speed_ms == pytest.approx(4.0, abs=0.1)


def test_all_samples_implausible_leaves_wind_null(monkeypatch):
    """Nothing plausible to report is reported as nothing, not as zero."""
    absurd = _pulses_for(MAX_PLAUSIBLE_WIND_MS + 20, 5.0)
    rec = _run_one_archive(monkeypatch, [absurd] * 12)

    assert rec.wind_speed_ms is None
    assert rec.wind_gust_ms is None


def test_the_actual_spike_reproduces_under_the_old_arithmetic():
    """Anchor the diagnosis: 520 pulses / 5 s is the 70.6 m/s that was published.

    Same pulses measured against the interval that really elapsed (~125 s, from
    the 185.4 s archive gap less the 66.2 s median) give a believable breeze.
    """
    pulses = 520
    published = Anemometer.speed_ms(pulses, 5.0, RADIUS_CM, ADJUSTMENT)
    assert published == pytest.approx(69.4, abs=0.5)  # 250 km/h

    real_elapsed = 185.4 - 66.2 + 5.0
    corrected = Anemometer.speed_ms(pulses, real_elapsed, RADIUS_CM, ADJUSTMENT)
    assert corrected < 3.0
    assert corrected * 3.6 < 11  # ~10 km/h, matching its neighbours
