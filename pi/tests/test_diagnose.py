"""Rain-buffer folding in `weatherstation-doctor`.

A tipping bucket that has stopped tipping is indistinguishable from dry weather
in the data, so the arithmetic that turns archived millimetres back into a tip
count is the part worth pinning down.
"""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from weatherstation.diagnose import _stuck_gauge_verdict, summarise_rain

BUCKET = 0.2794
DUBLIN = ZoneInfo("Europe/Dublin")


def _rows(start, minutes, mm_at=None):
    """`minutes` one-minute archive rows from `start`; mm_at maps index -> rain_mm."""
    mm_at = mm_at or {}
    return [((start + timedelta(minutes=i)).isoformat(), mm_at.get(i, 0.0)) for i in range(minutes)]


def _rows_h(start, minutes, humidity, mm_at=None):
    """Like `_rows` but every row also carries a humidity reading (percent)."""
    mm_at = mm_at or {}
    return [
        ((start + timedelta(minutes=i)).isoformat(), mm_at.get(i, 0.0), humidity)
        for i in range(minutes)
    ]


def test_counts_tips_back_out_of_archived_millimetres():
    start = datetime(2026, 9, 2, 6, 0, tzinfo=timezone.utc)
    # three tips in the 06:00 hour, one in the 07:00 hour
    rows = _rows(start, 120, {5: BUCKET, 6: BUCKET, 30: BUCKET, 65: BUCKET})
    s = summarise_rain(rows, BUCKET, DUBLIN)

    assert s.records == 120
    assert s.tips == 4
    assert s.total_mm == round(4 * BUCKET, 10) or abs(s.total_mm - 4 * BUCKET) < 1e-9
    assert len(s.hourly) == 2
    assert [tips for _, _, tips in s.hourly] == [3, 1]


def test_a_dry_window_is_distinguishable_from_no_records():
    start = datetime(2026, 9, 2, 6, 0, tzinfo=timezone.utc)
    dry = summarise_rain(_rows(start, 60), BUCKET, DUBLIN)
    assert dry.records == 60 and dry.tips == 0 and dry.last_tip is None

    empty = summarise_rain([], BUCKET, DUBLIN)
    assert empty.records == 0 and empty.tips == 0
    # span is what separates "gauge is quiet" from "collector wasn't running"
    assert empty.span_h == 0.0
    assert dry.span_h > 0.9


def test_last_tip_is_the_most_recent_nonzero_row():
    start = datetime(2026, 9, 2, 6, 0, tzinfo=timezone.utc)
    rows = _rows(start, 60, {10: BUCKET, 42: BUCKET})
    s = summarise_rain(rows, BUCKET, DUBLIN)
    assert s.last_tip == start + timedelta(minutes=42)


def test_failed_sensor_cycles_count_as_records_but_not_as_rain():
    start = datetime(2026, 9, 2, 6, 0, tzinfo=timezone.utc)
    rows = [((start + timedelta(minutes=i)).isoformat(), None) for i in range(30)]
    rows += _rows(start + timedelta(minutes=30), 30, {0: BUCKET})
    s = summarise_rain(rows, BUCKET, DUBLIN)
    assert s.records == 60
    assert s.tips == 1


def test_hours_are_bucketed_in_station_local_time():
    # 23:30 UTC on 30 June is 00:30 Dublin (IST, UTC+1) the next day, so this
    # must land in the following local hour, not the same UTC one.
    start = datetime(2026, 6, 30, 23, 30, tzinfo=timezone.utc)
    s = summarise_rain([(start.isoformat(), BUCKET)], BUCKET, DUBLIN)
    hour = s.hourly[0][0]
    assert (hour.day, hour.hour) == (1, 0)


def test_naive_timestamps_are_read_as_utc():
    rows = [("2026-09-02T06:00:00", BUCKET)]
    s = summarise_rain(rows, BUCKET, DUBLIN)
    assert s.tips == 1
    assert s.last_tip == datetime(2026, 9, 2, 6, 0, tzinfo=timezone.utc)


def test_unparseable_rows_are_skipped_rather_than_crashing():
    s = summarise_rain([("not-a-timestamp", BUCKET), (None, BUCKET)], BUCKET, DUBLIN)
    assert s.records == 0 and s.tips == 0


# --- stuck / blocked gauge heuristic ---------------------------------------
#
# The failure that motivated this: the bucket physically jammed and logged zero
# tips for days while it was actually raining, and nothing flagged it. The
# warning fires only when a long no-tip run coincides with sustained high
# humidity (a proxy for "it should have rained"); a genuinely dry gauge stays
# quiet.

STUCK_KW = {"stuck_hours": 24, "wet_samples": 120, "wet_humidity_pct": 95}


def test_no_tip_during_sustained_high_humidity_warns():
    start = datetime(2026, 9, 2, 6, 0, tzinfo=timezone.utc)
    # 30h of one-minute records, no tips, humidity pinned at 100%.
    s = summarise_rain(_rows_h(start, 30 * 60 + 1, humidity=100.0), BUCKET, DUBLIN)
    now = start + timedelta(hours=30)

    lines = _stuck_gauge_verdict(s, now, start, **STUCK_KW)

    assert lines, "a wet, tip-less 30h run should warn"
    assert lines[0].startswith("WARNING: rain gauge may be stuck or blocked")
    assert "30.0h" in lines[0]
    assert "100% on 1801 samples" in lines[1]


def test_long_dry_spell_in_dry_air_does_not_warn():
    start = datetime(2026, 9, 2, 6, 0, tzinfo=timezone.utc)
    # Same long no-tip run, but the air was dry the whole time — a healthy gauge.
    s = summarise_rain(_rows_h(start, 30 * 60 + 1, humidity=60.0), BUCKET, DUBLIN)
    now = start + timedelta(hours=30)

    assert _stuck_gauge_verdict(s, now, start, **STUCK_KW) == []


def test_recent_tip_does_not_warn_even_when_wet():
    start = datetime(2026, 9, 2, 6, 0, tzinfo=timezone.utc)
    minutes = 30 * 60 + 1
    # High humidity throughout, but the gauge tipped ~1.5h before the end.
    rows = _rows_h(start, minutes, humidity=100.0, mm_at={minutes - 90: BUCKET})
    s = summarise_rain(rows, BUCKET, DUBLIN)
    now = start + timedelta(minutes=minutes - 1)

    assert s.last_tip == start + timedelta(minutes=minutes - 90)
    assert _stuck_gauge_verdict(s, now, start, **STUCK_KW) == []


def test_wet_run_just_short_of_the_sample_threshold_does_not_warn():
    start = datetime(2026, 9, 2, 6, 0, tzinfo=timezone.utc)
    # Wet enough and long enough, but only 119 humid samples (< the 120 floor):
    # a brief wet blip is not the sustained wetness the warning is meant for.
    rows = _rows_h(start, 30 * 60 + 1, humidity=90.0)
    rows = [(t, mm, 100.0) for (t, mm, _) in rows[:119]] + rows[119:]
    s = summarise_rain(rows, BUCKET, DUBLIN)
    now = start + timedelta(hours=30)

    assert _stuck_gauge_verdict(s, now, start, **STUCK_KW) == []
