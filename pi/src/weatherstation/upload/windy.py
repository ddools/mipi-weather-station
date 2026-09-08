"""Windy Stations API v2 upload (effective Jan 2026).

GET /api/v2/observation/update with query params — WU-protocol-compatible,
NOT the POST/JSON shape an earlier draft of this uploader assumed. Auth is
the station's own password (a distinct concept from Windy's account-level
"API key", which is for managing stations, not uploading observations).
Pressure is in Pascals. Uploads are rate-limited to once per 5 minutes
server-side, which is slower than our 60s archive interval — handled by
skipping (returning success without a request) between windows rather than
hammering the endpoint into 429s.

Two things Windy validates strictly, both of which wedged this uploader in
production (2026-09-02, record 2455):

- `winddir` must be an **integer**. The vane reports the 16 compass points as
  `index * 22.5`, so the eight intercardinals (NNE, ESE, ...) are fractional
  and every record carrying one was rejected with HTTP 400. WU and WOW-BE
  already rounded; only this uploader passed the raw float through.
- `time` must be within **2 hours** of now. A rejected record blocks the
  buffer cursor (`upload/base.py` stops at the first failure to keep
  ordering), so once one record sticks it ages past that window and can never
  be accepted again — the head-of-line block is permanent and the station
  goes silent on Windy while every other destination stays healthy. Records
  past the window are therefore dropped rather than retried forever, the same
  rule `upload/cwop.py` applies to a realtime-only network.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

import requests

from ._rain import rain_hour_and_day
from .base import Uploader

log = logging.getLogger(__name__)

_URL = "https://stations.windy.com/api/v2/observation/update"
_MIN_INTERVAL_S = 300  # Windy rejects more frequent updates per station
# Windy rejects a `time` more than 2h old. Stop short of that so a record close
# to the edge is not sent only to be refused for age while it is in flight.
_MAX_AGE_S = 6900  # 1h55m


def _parse_utc(recorded_at: str) -> datetime:
    """`recorded_at` as an aware UTC datetime. Naive timestamps are read as UTC."""
    dt = datetime.fromisoformat(recorded_at.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


class WindyUploader(Uploader):
    name = "windy"

    def __init__(self, cfg) -> None:
        self._password = cfg.env.windy_station_password
        self._station = cfg.uploaders.windy.station_id
        self._tz = cfg.station.get("timezone", "UTC")
        self._sqlite_path = str(cfg.storage.sqlite_path)
        # -inf, not 0.0: time.monotonic() counts from boot, so 0.0 would make
        # every record in the first 5 minutes after a reboot look like it fell
        # inside the rate-limit window and get skipped.
        self._last_sent_at = float("-inf")

    def send(self, record: dict) -> bool:
        now = time.monotonic()
        if now - self._last_sent_at < _MIN_INTERVAL_S:
            return True  # within Windy's 5-minute window — skip, not a failure

        dt = _parse_utc(record["recorded_at"])
        if (datetime.now(timezone.utc) - dt).total_seconds() > _MAX_AGE_S:
            # Windy will refuse it for age; retrying would block every fresher
            # record behind it forever. Drop it and let the cursor advance.
            log.warning(
                "windy: dropping record older than %ds (%s)",
                _MAX_AGE_S,
                record["recorded_at"],
            )
            return True

        params = {
            "id": self._station,
            "time": record["recorded_at"],
            "softwaretype": "mipi-weatherstation",
        }
        if record.get("temp_c") is not None:
            params["temp"] = record["temp_c"]
        if record.get("humidity") is not None:
            params["humidity"] = record["humidity"]
        if record.get("pressure_msl_hpa") is not None:
            params["pressure"] = record["pressure_msl_hpa"] * 100  # hPa -> Pa
        if record.get("wind_speed_ms") is not None:
            params["wind"] = record["wind_speed_ms"]
        if record.get("wind_gust_ms") is not None:
            params["gust"] = record["wind_gust_ms"]
        if record.get("wind_dir_deg") is not None:
            params["winddir"] = round(record["wind_dir_deg"])  # Windy requires an integer
        # NOT record["rain_mm"], which is only this interval's rain: Windy's
        # precipitation params are all "over the past hour", so this is summed
        # from the buffer like every other destination's rain field.
        params["precip"] = round(rain_hour_and_day(self._sqlite_path, self._tz, dt)[0], 3)
        if record.get("dewpoint_c") is not None:
            params["dewpoint"] = record["dewpoint_c"]

        r = requests.get(
            _URL,
            params=params,
            headers={"Authorization": f"Bearer {self._password}"},
            timeout=15,
        )
        # 409 = duplicate payload (already accepted on a previous attempt) — idempotent success
        ok = r.ok or r.status_code == 409
        if ok:
            self._last_sent_at = now
        else:
            log.warning("windy: HTTP %d, body=%r", r.status_code, r.text[:200])
            self.last_error = f"HTTP {r.status_code}: {r.text[:200]}"
        return ok
