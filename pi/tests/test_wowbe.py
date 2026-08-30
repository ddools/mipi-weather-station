from datetime import datetime, timedelta, timezone

import pytest
import requests

from weatherstation.config import Config
from weatherstation.core.records import Record
from weatherstation.store import LocalBuffer
from weatherstation.upload.wowbe import WowBeUploader


class FakeResponse:
    def __init__(self, status_code, text=""):
        self.status_code = status_code
        self.text = text


def _cfg(tmp_path):
    return Config(
        {
            "station": {"latitude": 53.35, "longitude": -6.26, "timezone": "Europe/Dublin"},
            "storage": {"sqlite_path": str(tmp_path / "w.sqlite3")},
            "uploaders": {"wowbe": {"enabled": True, "station_id": "12345"}},
            "env": {"wowbe_auth_key": "654321"},
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

    def fake_post(url, json=None, timeout=None):
        sent.update(url=url, json=json, timeout=timeout)
        return response

    monkeypatch.setattr("weatherstation.upload.wowbe.requests.post", fake_post)
    return sent


def test_send_builds_wow_body(tmp_path, monkeypatch):
    sent = _capture(monkeypatch)
    assert WowBeUploader(_cfg(tmp_path)).send(_record()) is True

    b = sent["json"]
    assert sent["url"] == "https://wow.meteo.be/api/v2/send/wow"
    assert b["siteid"] == "12345"
    assert b["siteAuthenticationKey"] == "654321"
    assert b["softwaretype"] == "mipi-weatherstation"
    assert b["tempf"] == 68.0
    assert b["humidity"] == 72
    assert b["dewptf"] == pytest.approx(58.8, abs=0.05)
    assert b["baromin"] == pytest.approx(29.92, abs=0.01)
    assert b["absbaromin"] == pytest.approx(29.86, abs=0.01)
    assert b["windspeedmph"] == pytest.approx(11.2, abs=0.05)
    assert b["windgustmph"] == pytest.approx(17.9, abs=0.05)
    assert b["winddir"] == 180
    assert b["rainin"] == 0.0
    assert b["dailyrainin"] == 0.0
    # dateutc: "YYYY-MM-DD HH:MM:SS", UTC, no fractional seconds, no offset
    datetime.strptime(b["dateutc"], "%Y-%m-%d %H:%M:%S")


def test_send_omits_absent_fields_but_always_sends_rain(tmp_path, monkeypatch):
    sent = _capture(monkeypatch)
    WowBeUploader(_cfg(tmp_path)).send(
        {"recorded_at": datetime.now(timezone.utc).isoformat(), "temp_c": 10.0}
    )
    b = sent["json"]
    assert b["tempf"] == 50.0
    for absent in ("humidity", "dewptf", "baromin", "windspeedmph", "winddir"):
        assert absent not in b
    assert b["rainin"] == 0.0
    assert b["dailyrainin"] == 0.0


def test_send_rain_totals_from_buffer(tmp_path, monkeypatch):
    buf = LocalBuffer(tmp_path / "w.sqlite3")
    now = datetime.now(timezone.utc)
    for mins, mm in [(10, 0.3), (120, 0.3), (600, 0.3)]:
        rec = Record(rain_mm=mm)
        rec.recorded_at = (now - timedelta(minutes=mins)).isoformat()
        buf.append(rec)

    sent = _capture(monkeypatch)
    WowBeUploader(_cfg(tmp_path)).send(_record())
    b = sent["json"]
    assert b["rainin"] == pytest.approx(round(0.3 / 25.4, 3))  # only the 10-min-ago tip
    assert b["dailyrainin"] >= b["rainin"]  # since-midnight window covers at least that tip


@pytest.mark.parametrize(
    ("status", "expected"),
    [(200, True), (403, False), (422, False), (429, False), (500, False)],
)
def test_send_status_handling(tmp_path, monkeypatch, status, expected):
    _capture(monkeypatch, FakeResponse(status, "detail"))
    assert WowBeUploader(_cfg(tmp_path)).send(_record()) is expected


def test_send_network_error_is_failure(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("no route")

    monkeypatch.setattr("weatherstation.upload.wowbe.requests.post", boom)
    assert WowBeUploader(_cfg(tmp_path)).send(_record()) is False
