"""Load config.yaml + .env into a simple namespace."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv


class Config(dict):
    """Dict with attribute access for nested config."""

    def __getattr__(self, key: str) -> Any:
        try:
            val = self[key]
        except KeyError as e:
            raise AttributeError(key) from e
        return Config(val) if isinstance(val, dict) else val


def load(path: str | Path = "config.yaml") -> Config:
    load_dotenv()
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(
            f"{p} not found — copy config.example.yaml to config.yaml and edit it."
        )
    with p.open() as f:
        cfg = Config(yaml.safe_load(f))
    cfg["env"] = Config(
        supabase_url=os.getenv("SUPABASE_URL", ""),
        supabase_key=os.getenv("SUPABASE_SERVICE_KEY", ""),
        wu_key=os.getenv("WU_STATION_KEY", ""),
        windy_key=os.getenv("WINDY_API_KEY", ""),
    )
    return cfg


def mock_sensors() -> bool:
    return os.getenv("WS_MOCK_SENSORS", "0") == "1"
