"""Shared rain-accumulation helpers for uploaders.

Some destinations want rain totals that a single archive record does not carry
(WOW-BE `dailyrainin`, CWOP `r`/`p`/`P`). These read the local SQLite buffer --
the source of truth -- through a throwaway read-only connection, so the figures
stay correct across an uploader restart with no in-memory accumulator to lose.
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

log = logging.getLogger(__name__)

_SUM_SINCE = (
    "SELECT COALESCE(SUM(json_extract(payload, '$.rain_mm')), 0) "
    "FROM readings WHERE recorded_at >= ?"
)


def sum_rain_since(sqlite_path: str, *since_iso: str) -> tuple[float, ...]:
    """Total archived rain (mm) at or after each ISO timestamp.

    Returns one float per timestamp, in order. Any DB error (missing file, locked,
    corrupt) is logged and yields zeros rather than raising -- a missing rain
    figure should never block an upload.
    """
    try:
        db = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True, timeout=5)
        try:
            return tuple(
                float(db.execute(_SUM_SINCE, (since,)).fetchone()[0]) for since in since_iso
            )
        finally:
            db.close()
    except sqlite3.Error as e:
        log.warning("rain lookup failed (%s); reporting zeros", e)
        return tuple(0.0 for _ in since_iso)


def local_midnight_utc(tz_name: str, now_utc: datetime) -> datetime:
    """The most recent local midnight for `tz_name`, as a UTC datetime.

    Falls back to UTC midnight if the zone name is unknown (Dublin is within an
    hour of UTC year-round, so the "rain since midnight" total is only briefly
    off near midnight in the worst case)."""
    try:
        local = now_utc.astimezone(ZoneInfo(tz_name))
    except Exception:
        log.warning("unknown timezone %r; using UTC midnight for rain totals", tz_name)
        return now_utc.replace(hour=0, minute=0, second=0, microsecond=0)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight.astimezone(timezone.utc)
