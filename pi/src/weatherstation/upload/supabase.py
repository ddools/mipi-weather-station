"""Insert archive records into a Supabase (Postgres) table via PostgREST."""
from __future__ import annotations

import logging

import requests

from .base import Uploader

log = logging.getLogger(__name__)


class SupabaseUploader(Uploader):
    name = "supabase"

    def __init__(self, cfg) -> None:
        self._url = f"{cfg.env.supabase_url}/rest/v1/{cfg.uploaders.supabase.table}"
        self._headers = {
            "apikey": cfg.env.supabase_key,
            "Authorization": f"Bearer {cfg.env.supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }

    def send(self, record: dict) -> bool:
        r = requests.post(self._url, json=record, headers=self._headers, timeout=15)
        # 409 = duplicate (already inserted on a previous retry) — treat as sent
        ok = r.status_code in (200, 201, 409)
        if not ok:
            log.warning("supabase: HTTP %d, body=%r", r.status_code, r.text[:200])
        return ok
