"""The archive record — one row per archive interval."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone


@dataclass
class Record:
    recorded_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    temp_c: float | None = None
    humidity: float | None = None  # %RH
    pressure_hpa: float | None = None  # station pressure
    pressure_msl_hpa: float | None = None  # sea-level adjusted
    wind_speed_ms: float | None = None  # avg over interval
    wind_gust_ms: float | None = None  # max sample in interval
    wind_dir_deg: float | None = None
    rain_mm: float | None = None  # rain during interval
    dewpoint_c: float | None = None

    def as_dict(self) -> dict:
        return asdict(self)
