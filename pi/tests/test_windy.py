from datetime import datetime, timedelta, timezone

from weatherstation.config import Config
from weatherstation.core.records import Record
from weatherstation.store import LocalBuffer
from weatherstation.upload.windy import WindyUploader


class FakeResponse:
    def __init__(self, status_code, text=""):
        self.status_code = status_code
        self.text = text

    @property
    def ok(self):
        return 200 <= self.status_code < 300


def _cfg(tmp_path):
    return Config(
        {
            "storage": {"sqlite_path": str(tmp_path / "w.sqlite3")},
            "uploaders": {"windy": {"enabled": True, "station_id": "C9fexco"}},
            "env": {"windy_station_password": "sekrit"},
        }
    )


def _record(**kw):
    base = {
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "temp_c": 15.0,
        "humidity": 80,
        "dewpoint_c": 11.8,
        "pressure_msl_hpa": 1009.5,
        "wind_speed_ms": 4.0,
        "wind_gust_ms": 7.5,
        "wind_dir_deg": 180.0,
        "rain_mm": 0.0,
    }
    base.update(kw)
    return base


def _capture(monkeypatch, response=None):
    response = response or FakeResponse(200)
    sent = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        sent.update(url=url, params=params, headers=headers, timeout=timeout)
        return response

    monkeypatch.setattr("weatherstation.upload.windy.requests.get", fake_get)
    return sent


def test_send_builds_query_params(tmp_path, monkeypatch):
    sent = _capture(monkeypatch)
    assert WindyUploader(_cfg(tmp_path)).send(_record()) is True
    assert sent["params"]["id"] == "C9fexco"
    assert sent["headers"]["Authorization"] == "Bearer sekrit"
    assert sent["params"]["pressure"] == 100950.0  # hPa -> Pa


def test_winddir_is_sent_as_an_integer(tmp_path, monkeypatch):
    """The vane reports the 16 points as index * 22.5, so half of them are
    fractional; Windy rejects a non-integer winddir with HTTP 400."""
    sent = _capture(monkeypatch)
    for angle in (22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5):
        up = WindyUploader(_cfg(tmp_path))
        assert up.send(_record(wind_dir_deg=angle)) is True
        assert isinstance(sent["params"]["winddir"], int)


def test_stale_record_is_dropped_not_retried(tmp_path, monkeypatch):
    """A record past Windy's 2h window can never be accepted. Retrying it
    blocks every fresher record behind it, so it is dropped instead."""
    sent = _capture(monkeypatch)
    old = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
    assert WindyUploader(_cfg(tmp_path)).send(_record(recorded_at=old)) is True
    assert sent == {}  # marked sent without a request


def test_fresh_record_is_still_sent(tmp_path, monkeypatch):
    sent = _capture(monkeypatch)
    recent = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
    assert WindyUploader(_cfg(tmp_path)).send(_record(recorded_at=recent)) is True
    assert sent["params"]["time"] == recent


def test_rate_limit_skips_without_a_request(tmp_path, monkeypatch):
    sent = _capture(monkeypatch)
    up = WindyUploader(_cfg(tmp_path))
    assert up.send(_record()) is True
    sent.clear()
    assert up.send(_record()) is True  # inside the 5-minute window
    assert sent == {}


def test_first_record_after_boot_is_sent(tmp_path, monkeypatch):
    """time.monotonic() counts from boot, so a 0.0 sentinel would swallow the
    first five minutes of records after every reboot."""
    monkeypatch.setattr("weatherstation.upload.windy.time.monotonic", lambda: 20.0)
    sent = _capture(monkeypatch)
    assert WindyUploader(_cfg(tmp_path)).send(_record()) is True
    assert sent["params"]["id"] == "C9fexco"


def test_409_counts_as_success(tmp_path, monkeypatch):
    _capture(monkeypatch, FakeResponse(409))
    assert WindyUploader(_cfg(tmp_path)).send(_record()) is True


def test_400_is_a_failure_and_blocks_the_cursor(tmp_path, monkeypatch):
    _capture(monkeypatch, FakeResponse(400, '{"error":"Bad Request"}'))
    assert WindyUploader(_cfg(tmp_path)).send(_record()) is False


def test_flush_advances_past_a_stale_backlog(tmp_path, monkeypatch):
    """The production failure: a wedged record ages out and every fresher one
    is stuck behind it. Dropping the stale ones lets the cursor catch up."""
    sent = _capture(monkeypatch)
    buffer = LocalBuffer(tmp_path / "w.sqlite3")
    for hours in (5, 4, 3):
        rec = Record()
        rec.recorded_at = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        rec.wind_dir_deg = 22.5
        buffer.append(rec)
    fresh = Record()
    fresh.wind_dir_deg = 22.5
    buffer.append(fresh)

    WindyUploader(_cfg(tmp_path)).flush(buffer)

    assert buffer.pending("windy") == []  # nothing left wedged
    assert sent["params"]["time"] == fresh.recorded_at  # the fresh one went out
    assert sent["params"]["winddir"] == 22
