"""Shared rain-accumulation helpers for uploaders.

Every destination we upload to wants rain as an **accumulation over a window**
(WU/Windy/WOW `rainin` = the last 60 minutes, `dailyrainin` = since local
midnight, CWOP `r`/`p`/`P` = last hour / last 24 h / since midnight). A single
archive record carries only the rain that fell during its own 60-second
interval, so a record's `rain_mm` is never the right value for any of those
fields -- sending it reports roughly a sixtieth of the real total.

These helpers read the local SQLite buffer -- the source of truth -- through a
throwaway read-only connection, so the figures stay correct across an uploader
restart with no in-memory accumulator to lose.

Windows are anchored on the **record's** timestamp, not on wall-clock now. For a
live reading the two are the same, but a backlog replayed after an outage would
otherwise stamp the current hour's rain onto an hours-old observation.
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

log = logging.getLogger(__name__)

# Timestamps are compared as strings: every row is written by `core.records.Record`
# as an aware-UTC `.isoformat()`, so they all share the `+00:00` shape and sort
# chronologically. Callers must pass bounds in that same form.
_SUM_BETWEEN = (
    "SELECT COALESCE(SUM(json_extract(payload, '$.rain_mm')), 0) "
    "FROM readings WHERE recorded_at >= ? AND recorded_at <= ?"
)


def sum_rain_since(sqlite_path: str, *since_iso: str, until_iso: str) -> tuple[float, ...]:
    """Total archived rain (mm) between each ISO timestamp and `until_iso`.

    Returns one float per timestamp, in order. `until_iso` is a required keyword
    rather than an implicit "now" so that no caller can accidentally sum rain
    that fell *after* the record being uploaded.

    Any DB error (missing file, locked, corrupt) is logged and yields zeros
    rather than raising -- a missing rain figure should never block an upload.
    """
    try:
        db = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True, timeout=5)
        try:
            return tuple(
                float(db.execute(_SUM_BETWEEN, (since, until_iso)).fetchone()[0])
                for since in since_iso
            )
        finally:
            db.close()
    except sqlite3.Error as e:
        log.warning("rain lookup failed (%s); reporting zeros", e)
        return tuple(0.0 for _ in since_iso)


def rain_hour_and_day(sqlite_path: str, tz_name: str, at: datetime) -> tuple[float, float]:
    """(last hour, since local midnight) rain totals in mm, as of `at`.

    The WU-protocol pair -- `rainin` and `dailyrainin` -- shared by the
    Weather Underground, Windy, WOW and WOW-BE uploaders.
    """
    return sum_rain_since(
        sqlite_path,
        (at - timedelta(hours=1)).isoformat(),
        local_midnight_utc(tz_name, at).isoformat(),
        until_iso=at.isoformat(),
    )


def local_midnight_utc(tz_name: str, at: datetime) -> datetime:
    """The local midnight most recently preceding `at` for `tz_name`, as UTC.

    Falls back to UTC midnight if the zone name is unknown (Dublin is within an
    hour of UTC year-round, so the "rain since midnight" total is only briefly
    off near midnight in the worst case)."""
    try:
        local = at.astimezone(ZoneInfo(tz_name))
    except Exception:
        log.warning("unknown timezone %r; using UTC midnight for rain totals", tz_name)
        return at.replace(hour=0, minute=0, second=0, microsecond=0)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight.astimezone(timezone.utc)
