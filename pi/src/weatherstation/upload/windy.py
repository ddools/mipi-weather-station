"""Windy Stations API v2 upload (effective Jan 2026; pressure in Pascals)."""
from __future__ import annotations

import requests

from .base import Uploader

_URL = "https://stations.windy.com/api/v2/observations"


class WindyUploader(Uploader):
    name = "windy"

    def __init__(self, cfg) -> None:
        self._key = cfg.env.windy_key
        self._station = cfg.uploaders.windy.station_id

    def send(self, record: dict) -> bool:
        obs = {"station": self._station, "ts": record["recorded_at"]}
        if record.get("temp_c") is not None:
            obs["temp"] = record["temp_c"]
        if record.get("humidity") is not None:
            obs["rh"] = record["humidity"]
        if record.get("pressure_msl_hpa") is not None:
            obs["pressure"] = record["pressure_msl_hpa"] * 100  # hPa -> Pa
        if record.get("wind_speed_ms") is not None:
            obs["wind"] = record["wind_speed_ms"]
        if record.get("wind_gust_ms") is not None:
            obs["gust"] = record["wind_gust_ms"]
        if record.get("wind_dir_deg") is not None:
            obs["winddir"] = record["wind_dir_deg"]
        if record.get("rain_mm") is not None:
            obs["precip"] = record["rain_mm"]

        r = requests.post(
            _URL,
            json={"observations": [obs]},
            headers={"Authorization": f"Bearer {self._key}"},
            timeout=15,
        )
        return r.ok
