from datetime import datetime, timedelta, timezone

import pytest
import requests

from weatherstation.config import Config
from weatherstation.core.records import Record
from weatherstation.store import LocalBuffer
from weatherstation.upload.wow import WowUploader


class FakeResponse:
    def __init__(self, status_code, text=""):
        self.status_code = status_code
        self.text = text


def _cfg(tmp_path, **wow):
    block = {"enabled": True, "station_id": "987654"}
    block.update(wow)
    return Config(
        {
            "station": {"latitude": 53.35, "longitude": -6.26, "timezone": "Europe/Dublin"},
            "storage": {"sqlite_path": str(tmp_path / "w.sqlite3")},
            "uploaders": {"wow": block},
            "env": {"wow_auth_key": "123456"},
        }
    )


def _record(**kw):
    base = {
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "temp_c": 20.0,
        "humidity": 72,
        "dewpoint_c": 14.9,
        "pressure_msl_hpa": 1013.2,
        "pressure_hpa": 1011.0,
        "wind_speed_ms": 5.0,
        "wind_gust_ms": 8.0,
        "wind_dir_deg": 180,
    }
    base.update(kw)
    return base


def _capture(monkeypatch, response=None):
    response = response or FakeResponse(200)
    sent = {}

    def fake_get(url, params=None, timeout=None):
        sent.update(url=url, params=params, timeout=timeout)
        return response

    monkeypatch.setattr("weatherstation.upload.wow.requests.get", fake_get)
    return sent


def test_send_builds_wow_query(tmp_path, monkeypatch):
    sent = _capture(monkeypatch)
    assert WowUploader(_cfg(tmp_path)).send(_record()) is True

    p = sent["params"]
    assert sent["url"] == "https://wow.metoffice.gov.uk/automaticreading"
    assert p["siteid"] == "987654"
    assert p["siteAuthenticationKey"] == "123456"
    assert p["softwaretype"] == "mipi-weatherstation"
    assert p["tempf"] == 68.0
    assert p["humidity"] == 72
    assert p["dewptf"] == pytest.approx(58.8, abs=0.05)
    assert p["baromin"] == pytest.approx(29.92, abs=0.01)
    assert p["windspeedmph"] == pytest.approx(11.2, abs=0.05)
    assert p["windgustmph"] == pytest.approx(17.9, abs=0.05)
    assert p["winddir"] == 180
    assert p["rainin"] == 0.0
    assert p["dailyrainin"] == 0.0
    # absbaromin is a WU field WOW does not document — don't send it
    assert "absbaromin" not in p
    # dateutc: "YYYY-MM-DD HH:MM:SS", UTC, no fractional seconds, no offset
    datetime.strptime(p["dateutc"], "%Y-%m-%d %H:%M:%S")


def test_send_omits_absent_fields_but_always_sends_rain(tmp_path, monkeypatch):
    sent = _capture(monkeypatch)
    WowUploader(_cfg(tmp_path)).send(
        {"recorded_at": datetime.now(timezone.utc).isoformat(), "temp_c": 10.0}
    )
    p = sent["params"]
    assert p["tempf"] == 50.0
    for absent in ("humidity", "dewptf", "baromin", "windspeedmph", "winddir"):
        assert absent not in p
    assert p["rainin"] == 0.0
    assert p["dailyrainin"] == 0.0


def test_send_rain_totals_from_buffer(tmp_path, monkeypatch):
    buf = LocalBuffer(tmp_path / "w.sqlite3")
    now = datetime.now(timezone.utc)
    for mins, mm in [(10, 0.3), (120, 0.3), (600, 0.3)]:
        rec = Record(rain_mm=mm)
        rec.recorded_at = (now - timedelta(minutes=mins)).isoformat()
        buf.append(rec)

    sent = _capture(monkeypatch)
    WowUploader(_cfg(tmp_path)).send(_record())
    p = sent["params"]
    assert p["rainin"] == pytest.approx(round(0.3 / 25.4, 3))  # only the 10-min-ago tip
    assert p["dailyrainin"] >= p["rainin"]


def test_throttles_to_one_reading_per_window(tmp_path, monkeypatch):
    calls = []

    def fake_get(url, params=None, timeout=None):
        calls.append(params)
        return FakeResponse(200)

    monkeypatch.setattr("weatherstation.upload.wow.requests.get", fake_get)
    up = WowUploader(_cfg(tmp_path))
    # first send goes out; the next four are skipped, and skipping is not a failure
    # (the record is marked delivered so the backlog keeps draining)
    assert all(up.send(_record()) is True for _ in range(5))
    assert len(calls) == 1

    monkeypatch.setattr("weatherstation.upload.wow.time.monotonic", lambda: up._last_sent_at + 301)
    assert up.send(_record()) is True
    assert len(calls) == 2


def test_send_interval_is_configurable(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "weatherstation.upload.wow.requests.get",
        lambda url, params=None, timeout=None: (calls.append(params), FakeResponse(200))[1],
    )
    up = WowUploader(_cfg(tmp_path, send_interval_s=0))
    for _ in range(3):
        up.send(_record())
    assert len(calls) == 3


@pytest.mark.parametrize(
    ("status", "expected"),
    [(200, True), (429, True), (400, False), (401, False), (403, False), (500, False)],
)
def test_send_status_handling(tmp_path, monkeypatch, status, expected):
    _capture(monkeypatch, FakeResponse(status, "detail"))
    assert WowUploader(_cfg(tmp_path)).send(_record()) is expected


def test_failure_does_not_start_the_throttle_window(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "weatherstation.upload.wow.requests.get",
        lambda url, params=None, timeout=None: (calls.append(params), FakeResponse(500))[1],
    )
    up = WowUploader(_cfg(tmp_path))
    assert up.send(_record()) is False
    assert up.send(_record()) is False  # retried immediately, not swallowed by the throttle
    assert len(calls) == 2


def test_send_network_error_is_failure(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("no route")

    monkeypatch.setattr("weatherstation.upload.wow.requests.get", boom)
    assert WowUploader(_cfg(tmp_path)).send(_record()) is False
