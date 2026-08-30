"""WOW-BE (wow.meteo.be) upload -- Royal Meteorological Institute of Belgium.

WOW-BE is the reboot of the WMO "Weather Observations Website" concept after the
UK Met Office / Met Eireann WOW shutdown (late 2026). Unlike the old WOW, the v2
API is a plain JSON REST endpoint:

    POST https://wow.meteo.be/api/v2/send/wow
    Content-Type: application/json
    {"siteid": "...", "siteAuthenticationKey": "...", "dateutc": "...", <weather>}

Auth is a Site ID plus an Authentication Key (a PIN / password chosen at
registration), both sent in the body. Imperial units, same field names as the
Weather Underground protocol (tempf, baromin, windspeedmph, ...). Rate limit is
20 requests/min per site, so the 60 s archive interval needs no client throttle.

Responses: 200 accepted, 403 bad credentials, 422 validation error, 429 rate
limited. 429 is treated as a retryable failure (the base flush() loop pauses the
backlog and retries next tick); 403/422 fail loudly and also retry, on the
assumption a fix (correct key, backend change) will land eventually.

API reference: https://wow.meteo.be/docs/api/
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import requests

from ..core import units
from ._rain import local_midnight_utc, sum_rain_since
from .base import Uploader

log = logging.getLogger(__name__)

_URL = "https://wow.meteo.be/api/v2/send/wow"


class WowBeUploader(Uploader):
    name = "wowbe"

    def __init__(self, cfg) -> None:
        c = cfg.uploaders.wowbe
        self._site_id = str(c.station_id)
        self._auth_key = str(cfg.env.wowbe_auth_key)
        self._url = c.get("url", _URL)
        self._tz = cfg.station.get("timezone", "UTC")
        self._sqlite_path = str(cfg.storage.sqlite_path)

    def send(self, record: dict) -> bool:
        dt = datetime.fromisoformat(record["recorded_at"].replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(timezone.utc)
        now_utc = datetime.now(timezone.utc)

        rain_1h_mm, rain_today_mm = sum_rain_since(
            self._sqlite_path,
            (now_utc - timedelta(hours=1)).isoformat(),
            local_midnight_utc(self._tz, now_utc).isoformat(),
        )

        body = {
            "siteid": self._site_id,
            "siteAuthenticationKey": self._auth_key,
            "dateutc": dt.strftime("%Y-%m-%d %H:%M:%S"),
            "softwaretype": "mipi-weatherstation",
        }
        if record.get("temp_c") is not None:
            body["tempf"] = round(units.c_to_f(record["temp_c"]), 1)
        if record.get("humidity") is not None:
            body["humidity"] = round(record["humidity"])
        if record.get("dewpoint_c") is not None:
            body["dewptf"] = round(units.c_to_f(record["dewpoint_c"]), 1)
        if record.get("pressure_msl_hpa") is not None:
            body["baromin"] = round(units.hpa_to_inhg(record["pressure_msl_hpa"]), 3)
        if record.get("pressure_hpa") is not None:
            body["absbaromin"] = round(units.hpa_to_inhg(record["pressure_hpa"]), 3)
        if record.get("wind_speed_ms") is not None:
            body["windspeedmph"] = round(units.ms_to_mph(record["wind_speed_ms"]), 1)
        if record.get("wind_gust_ms") is not None:
            body["windgustmph"] = round(units.ms_to_mph(record["wind_gust_ms"]), 1)
        if record.get("wind_dir_deg") is not None:
            body["winddir"] = round(record["wind_dir_deg"])
        body["rainin"] = round(units.mm_to_in(rain_1h_mm), 3)
        body["dailyrainin"] = round(units.mm_to_in(rain_today_mm), 3)

        try:
            r = requests.post(self._url, json=body, timeout=15)
        except requests.RequestException as e:
            log.warning("wowbe: request failed: %s", e)
            return False

        if r.status_code == 200:
            return True
        log.warning("wowbe: HTTP %d, body=%r", r.status_code, r.text[:300])
        return False
