"""SQLite-first store-and-forward buffer. This is the source of truth on the Pi."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

from ..core.records import Record

_SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_state (
    uploader TEXT PRIMARY KEY,
    last_sent_id INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_readings_time ON readings(recorded_at);
"""


class LocalBuffer:
    def __init__(self, path: str | Path) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        # The sampler appends while the uploader thread reads and marks rows sent,
        # so every statement below goes through one lock to keep those two off
        # each other's transactions.
        self._lock = threading.Lock()
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def append(self, record: Record) -> None:
        with self._lock:
            self._append(record)

    def _append(self, record: Record) -> None:
        self._db.execute(
            "INSERT INTO readings (recorded_at, payload) VALUES (?, ?)",
            (record.recorded_at, json.dumps(record.as_dict())),
        )
        self._db.commit()

    def pending(self, uploader: str, limit: int = 200) -> list[tuple[int, dict]]:
        """Rows not yet sent by this uploader (oldest first)."""
        with self._lock:
            return self._pending(uploader, limit)

    def _pending(self, uploader: str, limit: int) -> list[tuple[int, dict]]:
        cur = self._db.execute(
            "SELECT COALESCE(last_sent_id, 0) FROM upload_state WHERE uploader = ?",
            (uploader,),
        )
        row = cur.fetchone()
        last = row[0] if row else 0
        cur = self._db.execute(
            "SELECT id, payload FROM readings WHERE id > ? ORDER BY id LIMIT ?",
            (last, limit),
        )
        return [(rid, json.loads(payload)) for rid, payload in cur.fetchall()]

    def mark_sent(self, uploader: str, row_id: int) -> None:
        with self._lock:
            self._mark_sent(uploader, row_id)

    def _mark_sent(self, uploader: str, row_id: int) -> None:
        self._db.execute(
            "INSERT INTO upload_state (uploader, last_sent_id) VALUES (?, ?) "
            "ON CONFLICT(uploader) DO UPDATE SET last_sent_id = excluded.last_sent_id",
            (uploader, row_id),
        )
        self._db.commit()
