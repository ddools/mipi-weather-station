"""Windy Stations API v2 upload (effective Jan 2026).

GET /api/v2/observation/update with query params — WU-protocol-compatible,
NOT the POST/JSON shape an earlier draft of this uploader assumed. Auth is
the station's own password (a distinct concept from Windy's account-level
"API key", which is for managing stations, not uploading observations).
Pressure is in Pascals. Uploads are rate-limited to once per 5 minutes
server-side, which is slower than our 60s archive interval — handled by
skipping (returning success without a request) between windows rather than
hammering the endpoint into 429s.
"""

from __future__ import annotations

import logging
import time

import requests

from .base import Uploader

log = logging.getLogger(__name__)

_URL = "https://stations.windy.com/api/v2/observation/update"
_MIN_INTERVAL_S = 300  # Windy rejects more frequent updates per station


class WindyUploader(Uploader):
    name = "windy"

    def __init__(self, cfg) -> None:
        self._password = cfg.env.windy_station_password
        self._station = cfg.uploaders.windy.station_id
        self._last_sent_at = 0.0

    def send(self, record: dict) -> bool:
        now = time.monotonic()
        if now - self._last_sent_at < _MIN_INTERVAL_S:
            return True  # within Windy's 5-minute window — skip, not a failure

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
            params["winddir"] = record["wind_dir_deg"]
        if record.get("rain_mm") is not None:
            params["precip"] = record["rain_mm"]
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
        return ok
