"""Weather Underground PWS upload (imperial units, GET updateweatherstation.php).

WU accepts a backdated ``dateutc``, so a backlog replayed after an outage lands
as real history rather than being refused -- and it has never rejected an
over-age record of ours. `_MAX_AGE_S` is therefore not an API limit but the
escape hatch every uploader needs: `upload/base.py:flush()` stops at the first
record a destination refuses, so one permanently unacceptable record pins the
cursor and blocks every fresher reading behind it, silently and indefinitely.
That is how Windy took the station offline for two days (see upload/windy.py and
docs/uploads.md). Dropping past the bound guarantees the cursor keeps moving;
the SQLite buffer and Supabase remain the complete record either way.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import requests

from ..core import units
from .base import Uploader

log = logging.getLogger(__name__)

_URL = "https://weatherstation.wunderground.com/weatherstation/updateweatherstation.php"
# A day, matching `wowbe.py`: both accept backfill, so the bound is a wedge
# backstop rather than a mirror of a documented server rule.
_MAX_AGE_S = 86400


class WundergroundUploader(Uploader):
    name = "wunderground"

    def __init__(self, cfg) -> None:
        self._id = cfg.uploaders.wunderground.station_id
        self._key = cfg.env.wu_key

    def send(self, record: dict) -> bool:
        dt = datetime.fromisoformat(record["recorded_at"].replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(timezone.utc)

        if (datetime.now(timezone.utc) - dt).total_seconds() > _MAX_AGE_S:
            # Retrying would block every fresher record behind it. Drop it and
            # let the cursor advance.
            log.warning(
                "wunderground: dropping record older than %ds (%s)",
                _MAX_AGE_S,
                record["recorded_at"],
            )
            return True

        params = {
            "ID": self._id,
            "PASSWORD": self._key,
            "action": "updateraw",
            "dateutc": dt.strftime("%Y-%m-%d %H:%M:%S"),
        }
        if record.get("temp_c") is not None:
            params["tempf"] = round(units.c_to_f(record["temp_c"]), 1)
        if record.get("humidity") is not None:
            params["humidity"] = round(record["humidity"])
        if record.get("pressure_msl_hpa") is not None:
            params["baromin"] = round(units.hpa_to_inhg(record["pressure_msl_hpa"]), 3)
        if record.get("wind_speed_ms") is not None:
            params["windspeedmph"] = round(units.ms_to_mph(record["wind_speed_ms"]), 1)
        if record.get("wind_gust_ms") is not None:
            params["windgustmph"] = round(units.ms_to_mph(record["wind_gust_ms"]), 1)
        if record.get("wind_dir_deg") is not None:
            params["winddir"] = round(record["wind_dir_deg"])
        if record.get("rain_mm") is not None:
            params["rainin"] = round(units.mm_to_in(record["rain_mm"]), 3)
        if record.get("dewpoint_c") is not None:
            params["dewptf"] = round(units.c_to_f(record["dewpoint_c"]), 1)

        r = requests.get(_URL, params=params, timeout=15)
        ok = r.ok and "success" in r.text.lower()
        if not ok:
            log.warning("wunderground: HTTP %d, body=%r", r.status_code, r.text[:200])
            self.last_error = f"HTTP {r.status_code}: {r.text[:200]}"
        return ok
