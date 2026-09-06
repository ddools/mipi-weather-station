"""The uploads section of `weatherstation-doctor`, and the error state it reads.

These cover the gap that let the Windy uploader sit wedged for two days: each
destination has its own cursor, so one can stall indefinitely while the others
stay current and nothing anywhere says so.
"""

from datetime import datetime, timedelta, timezone

from weatherstation.core.records import Record
from weatherstation.diagnose import (
    _read_upload_state,
    _upload_verdict,
    print_uploads,
)
from weatherstation.store import LocalBuffer


class _Cfg(dict):
    """Minimal stand-in for the config object's attribute access."""

    def __getattr__(self, name):
        return self[name]


def _buffer_with(tmp_path, count, start_minutes_ago=None):
    buffer = LocalBuffer(tmp_path / "w.sqlite3")
    start = start_minutes_ago if start_minutes_ago is not None else count
    for i in range(count):
        rec = Record()
        rec.recorded_at = (datetime.now(timezone.utc) - timedelta(minutes=start - i)).isoformat()
        buffer.append(rec)
    return buffer


def test_cursor_and_backlog_are_reported_per_uploader(tmp_path):
    buffer = _buffer_with(tmp_path, 10)
    buffer.mark_sent("supabase", 10)
    buffer.mark_sent("windy", 4)

    states, max_id, newest = _read_upload_state(tmp_path / "w.sqlite3")

    assert max_id == 10
    assert newest is not None
    by_name = {s.name: s for s in states}
    assert by_name["supabase"].backlog == 0
    assert by_name["windy"].backlog == 6
    assert by_name["windy"].last_sent_id == 4


def test_error_is_recorded_and_survives_to_the_doctor(tmp_path):
    buffer = _buffer_with(tmp_path, 3)
    buffer.record_error("windy", "HTTP 400: winddir must be an integer number")

    states, _, _ = _read_upload_state(tmp_path / "w.sqlite3")
    windy = next(s for s in states if s.name == "windy")
    assert "winddir must be an integer" in windy.last_error
    assert windy.last_error_at is not None


def test_a_successful_send_clears_the_error(tmp_path):
    buffer = _buffer_with(tmp_path, 3)
    buffer.record_error("windy", "HTTP 400: boom")
    buffer.mark_sent("windy", 1)

    states, _, _ = _read_upload_state(tmp_path / "w.sqlite3")
    windy = next(s for s in states if s.name == "windy")
    assert windy.last_error is None  # "why it is stuck now", not "what once broke"


def test_recording_an_error_does_not_move_the_cursor(tmp_path):
    buffer = _buffer_with(tmp_path, 5)
    buffer.mark_sent("windy", 3)
    buffer.record_error("windy", "HTTP 400: boom")

    states, _, _ = _read_upload_state(tmp_path / "w.sqlite3")
    assert next(s for s in states if s.name == "windy").last_sent_id == 3


def test_migration_adds_error_columns_to_an_older_buffer(tmp_path):
    """Every station in the field has a buffer predating the error columns."""
    import sqlite3

    path = tmp_path / "w.sqlite3"
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE readings (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "recorded_at TEXT NOT NULL, payload TEXT NOT NULL);"
        "CREATE TABLE upload_state (uploader TEXT PRIMARY KEY, "
        "last_sent_id INTEGER NOT NULL DEFAULT 0);"
        "INSERT INTO upload_state (uploader, last_sent_id) VALUES ('windy', 7);"
    )
    db.commit()
    db.close()

    buffer = LocalBuffer(path)  # opening it migrates
    buffer.record_error("windy", "HTTP 400: boom")

    states, _, _ = _read_upload_state(path)
    windy = next(s for s in states if s.name == "windy")
    assert windy.last_sent_id == 7  # existing cursor preserved
    assert windy.last_error == "HTTP 400: boom"


def test_verdict_is_quiet_when_everything_is_current(tmp_path):
    buffer = _buffer_with(tmp_path, 5)
    buffer.mark_sent("supabase", 5)
    states, _, _ = _read_upload_state(tmp_path / "w.sqlite3")

    lines = _upload_verdict(states, datetime.now(timezone.utc))
    assert lines == ["Every destination is up to date."]


def test_verdict_names_the_stalled_uploader_and_its_reason(tmp_path):
    """The report the two-day outage needed and did not have."""
    buffer = _buffer_with(tmp_path, 200, start_minutes_ago=3000)
    buffer.mark_sent("supabase", 200)
    buffer.mark_sent("windy", 40)
    buffer.record_error("windy", "HTTP 400: winddir must be an integer number")

    states, _, _ = _read_upload_state(tmp_path / "w.sqlite3")
    text = "\n".join(_upload_verdict(states, datetime.now(timezone.utc)))

    assert "windy is stuck" in text
    assert "record 41" in text  # the exact record that is blocking
    assert "winddir must be an integer number" in text
    assert "supabase" not in text  # healthy destinations stay out of the verdict


def test_verdict_points_at_the_log_when_no_reason_was_stored(tmp_path):
    buffer = _buffer_with(tmp_path, 100, start_minutes_ago=3000)
    buffer.mark_sent("windy", 10)

    states, _, _ = _read_upload_state(tmp_path / "w.sqlite3")
    text = "\n".join(_upload_verdict(states, datetime.now(timezone.utc)))
    assert "journalctl" in text


def test_a_short_backlog_is_not_called_a_stall(tmp_path):
    """Uploads run behind by design; catching up is not a fault."""
    buffer = _buffer_with(tmp_path, 5)
    buffer.mark_sent("windy", 2)

    states, _, _ = _read_upload_state(tmp_path / "w.sqlite3")
    lines = _upload_verdict(states, datetime.now(timezone.utc))
    assert lines == ["Every destination is current or catching up normally."]


def test_print_uploads_reports_a_missing_buffer(tmp_path, capsys):
    cfg = _Cfg(storage=_Cfg(sqlite_path=str(tmp_path / "nope.sqlite3")))
    print_uploads(cfg, tmp_path / "config.yaml")
    assert "not found" in capsys.readouterr().out


def test_print_uploads_renders_the_table(tmp_path, capsys):
    buffer = _buffer_with(tmp_path, 20, start_minutes_ago=3000)
    buffer.mark_sent("supabase", 20)
    buffer.mark_sent("windy", 5)
    buffer.record_error("windy", "HTTP 400: winddir must be an integer number")

    cfg = _Cfg(storage=_Cfg(sqlite_path=str(tmp_path / "w.sqlite3")))
    print_uploads(cfg, tmp_path / "config.yaml")

    out = capsys.readouterr().out
    assert "destination" in out
    assert "supabase" in out and "windy" in out
    assert "winddir must be an integer number" in out


def test_no_uploader_state_yet(tmp_path, capsys):
    _buffer_with(tmp_path, 3)
    cfg = _Cfg(storage=_Cfg(sqlite_path=str(tmp_path / "w.sqlite3")))
    print_uploads(cfg, tmp_path / "config.yaml")
    assert "No uploader has recorded a cursor yet" in capsys.readouterr().out
