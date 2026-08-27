"""Base uploader: store-and-forward loop shared by all destinations."""
from __future__ import annotations

import logging

from ..store import LocalBuffer

log = logging.getLogger(__name__)


class Uploader:
    name = "base"

    def send(self, record: dict) -> bool:  # pragma: no cover - interface
        """Send one record. Return True on success. Must be safe to retry."""
        raise NotImplementedError

    def flush(self, buffer: LocalBuffer) -> None:
        """Replay backlog; stop at first failure (keeps ordering, retries later)."""
        for row_id, record in buffer.pending(self.name):
            try:
                ok = self.send(record)
            except Exception:
                log.exception("%s: send failed", self.name)
                ok = False
            if not ok:
                log.warning("%s: rejected record %s, will retry next tick", self.name, row_id)
                break
            buffer.mark_sent(self.name, row_id)
