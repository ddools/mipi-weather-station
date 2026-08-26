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
    if u.windy.enabled and cfg.env.windy_key:
        from .windy import WindyUploader

        ups.append(WindyUploader(cfg))
    return ups
