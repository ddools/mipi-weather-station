"""Uploader registry. Each uploader replays its own backlog from the local buffer."""

from __future__ import annotations

from ..config import Config


def build_uploaders(cfg: Config) -> list:
    ups = []
    u = cfg.uploaders
    if u.supabase.enabled and cfg.env.supabase_url:
        from .supabase import SupabaseUploader

        ups.append(SupabaseUploader(cfg))
    if u.wunderground.enabled and cfg.env.wu_key:
        from .wunderground import WundergroundUploader

        ups.append(WundergroundUploader(cfg))
    if u.windy.enabled and cfg.env.windy_station_password:
        from .windy import WindyUploader

        ups.append(WindyUploader(cfg))
    cwop = u.get("cwop")  # optional block: absent in configs predating CWOP support
    if cwop and cwop.get("enabled") and cwop.get("station_id"):
        from .cwop import CWOPUploader

        ups.append(CWOPUploader(cfg))
    wowbe = u.get("wowbe")  # optional block: absent in configs predating WOW-BE support
    if wowbe and wowbe.get("enabled") and wowbe.get("station_id") and cfg.env.wowbe_auth_key:
        from .wowbe import WowBeUploader

        ups.append(WowBeUploader(cfg))
    return ups
