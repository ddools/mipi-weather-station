"""Weather Underground PWS upload (imperial units, GET updateweatherstation.php)."""
from __future__ import annotations

import logging

import requests

from ..core import units
from .base import Uploader

log = logging.getLogger(__name__)

_URL = "https://weatherstation.wunderground.com/weatherstation/updateweatherstation.php"


class WundergroundUploader(Uploader):
    name = "wunderground"

    def __init__(self, cfg) -> None:
        self._id = cfg.uploaders.wunderground.station_id
        self._key = cfg.env.wu_key

    def send(self, record: dict) -> bool:
        params = {
            "ID": self._id,
            "PASSWORD": self._key,
            "action": "updateraw",
            "dateutc": record["recorded_at"].replace("T", " ").split("+")[0],
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
        return ok
