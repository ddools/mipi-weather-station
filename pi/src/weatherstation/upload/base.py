"""Base uploader: store-and-forward loop shared by all destinations."""

from __future__ import annotations

import logging

from ..store import LocalBuffer

log = logging.getLogger(__name__)


class Uploader:
    name = "base"
    # Why the last send was refused. Set by each uploader where it logs the
    # rejection, so the reason survives into the buffer and `weatherstation-doctor`
    # instead of living only in journald.
    last_error: str | None = None

    def send(self, record: dict) -> bool:  # pragma: no cover - interface
        """Send one record. Return True on success. Must be safe to retry."""
        raise NotImplementedError

    def flush(self, buffer: LocalBuffer) -> None:
        """Replay backlog; stop at first failure (keeps ordering, retries later)."""
        for row_id, record in buffer.pending(self.name):
            try:
                ok = self.send(record)
            except Exception as exc:
                log.exception("%s: send failed", self.name)
                self.last_error = f"{type(exc).__name__}: {exc}"
                ok = False
            if not ok:
                log.warning("%s: rejected record %s, will retry next tick", self.name, row_id)
                buffer.record_error(self.name, self.last_error or "rejected, no reason recorded")
                break
            self.last_error = None
            buffer.mark_sent(self.name, row_id)  # also clears the stored error
