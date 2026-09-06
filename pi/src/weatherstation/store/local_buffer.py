"""SQLite-first store-and-forward buffer. This is the source of truth on the Pi."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from ..core.records import Record

# Enough of an API error body to name the offending field; these are read by a
# human in `weatherstation-doctor`, not parsed.
_MAX_ERROR_CHARS = 300

_SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_state (
    uploader TEXT PRIMARY KEY,
    last_sent_id INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_error_at TEXT
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
        self._migrate()
        self._db.commit()

    def _migrate(self) -> None:
        """Add columns to upload_state that a buffer created before them lacks.

        Every station in the field has a buffer predating the error columns, and
        the CREATE TABLE above is IF NOT EXISTS, so it never revises one. Cheap
        and idempotent, so it just runs at every startup.
        """
        have = {row[1] for row in self._db.execute("PRAGMA table_info(upload_state)")}
        for column in ("last_error", "last_error_at"):
            if column not in have:
                self._db.execute(f"ALTER TABLE upload_state ADD COLUMN {column} TEXT")

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
        # Clearing the error here, in the same statement that advances the
        # cursor, is what makes `last_error` mean "why this uploader is stuck
        # right now" rather than "the last thing that ever went wrong".
        self._db.execute(
            "INSERT INTO upload_state (uploader, last_sent_id) VALUES (?, ?) "
            "ON CONFLICT(uploader) DO UPDATE SET last_sent_id = excluded.last_sent_id, "
            "last_error = NULL, last_error_at = NULL",
            (uploader, row_id),
        )
        self._db.commit()

    def record_error(self, uploader: str, message: str) -> None:
        """Note why this uploader last refused a record. Does not move the cursor."""
        with self._lock:
            self._record_error(uploader, message)

    def _record_error(self, uploader: str, message: str) -> None:
        self._db.execute(
            "INSERT INTO upload_state (uploader, last_sent_id, last_error, last_error_at) "
            "VALUES (?, 0, ?, ?) "
            "ON CONFLICT(uploader) DO UPDATE SET last_error = excluded.last_error, "
            "last_error_at = excluded.last_error_at",
            (uploader, message[:_MAX_ERROR_CHARS], datetime.now(timezone.utc).isoformat()),
        )
        self._db.commit()
