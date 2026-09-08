"""Weather Underground uploader: field mapping, response handling, wedge guard."""

from datetime import datetime, timedelta, timezone

import pytest
import requests

from weatherstation.config import Config
from weatherstation.upload.wunderground import WundergroundUploader


class FakeResponse:
    def __init__(self, status_code, text="success"):
        self.status_code = status_code
        self.text = text

    @property
    def ok(self):
        return 200 <= self.status_code < 400


def _cfg():
    return Config(
        {
            "station": {"latitude": 53.58, "longitude": -6.14},
            "uploaders": {"wunderground": {"enabled": True, "station_id": "IHOLMP2"}},
            "env": {"wu_key": "secret"},
        }
    )


def _record(**kw):
    base = {
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "temp_c": 20.0,
        "humidity": 72.4,
        "dewpoint_c": 14.9,
        "pressure_msl_hpa": 1013.2,
        "wind_speed_ms": 5.0,
        "wind_gust_ms": 8.0,
        "wind_dir_deg": 202.5,
        "rain_mm": 0.2794,
    }
    base.update(kw)
    return base


def _capture(monkeypatch, response=None):
    response = response or FakeResponse(200)
    sent = {}

    def fake_get(url, params=None, timeout=None):
        sent.update(url=url, params=params, timeout=timeout)
        return response

    monkeypatch.setattr("weatherstation.upload.wunderground.requests.get", fake_get)
    return sent


def test_send_converts_to_imperial(monkeypatch):
    sent = _capture(monkeypatch)
    assert WundergroundUploader(_cfg()).send(_record()) is True

    p = sent["params"]
    assert p["ID"] == "IHOLMP2"
    assert p["PASSWORD"] == "secret"
    assert p["action"] == "updateraw"
    assert p["tempf"] == 68.0
    assert p["humidity"] == 72
    assert p["dewptf"] == 58.8
    assert p["baromin"] == pytest.approx(29.92, abs=0.005)
    assert p["windspeedmph"] == pytest.approx(11.2, abs=0.1)
    assert p["windgustmph"] == pytest.approx(17.9, abs=0.1)
    assert p["rainin"] == pytest.approx(0.011, abs=0.001)


def test_winddir_is_an_integer(monkeypatch):
    """The vane reports 16 points as index * 22.5, so intercardinals are
    fractional -- the field format that wedged Windy for two days (#18)."""
    sent = _capture(monkeypatch)
    WundergroundUploader(_cfg()).send(_record(wind_dir_deg=202.5))
    assert isinstance(sent["params"]["winddir"], int)
    assert sent["params"]["winddir"] == 202


def test_dateutc_is_utc_seconds(monkeypatch):
    """WU wants UTC to the second; a non-UTC offset must be converted, not
    truncated off the end of the string."""
    sent = _capture(monkeypatch)
    WundergroundUploader(_cfg()).send(_record(recorded_at="2026-09-08T20:08:30.225308+01:00"))
    assert sent["params"]["dateutc"] == "2026-09-08 19:08:30"


def test_missing_fields_are_omitted(monkeypatch):
    sent = _capture(monkeypatch)
    assert (
        WundergroundUploader(_cfg()).send(
            _record(temp_c=None, wind_gust_ms=None, rain_mm=None, humidity=None)
        )
        is True
    )
    p = sent["params"]
    for absent in ("tempf", "windgustmph", "rainin", "humidity"):
        assert absent not in p
    assert "windspeedmph" in p


@pytest.mark.parametrize(
    "status,body,expected",
    [
        (200, "success", True),
        (200, "unauthorized", False),  # fresh device, pre Edit->Save on WU
        (401, "unauthorized", False),
        (500, "server error", False),
    ],
)
def test_send_status_handling(monkeypatch, status, body, expected):
    _capture(monkeypatch, FakeResponse(status, body))
    assert WundergroundUploader(_cfg()).send(_record()) is expected


def test_rejection_records_last_error(monkeypatch):
    _capture(monkeypatch, FakeResponse(401, "unauthorized"))
    up = WundergroundUploader(_cfg())
    up.send(_record())
    assert "401" in up.last_error and "unauthorized" in up.last_error


def test_network_error_propagates(monkeypatch):
    """flush() catches the exception and records it; send() does not swallow it."""

    def boom(*a, **k):
        raise requests.ConnectionError("no route")

    monkeypatch.setattr("weatherstation.upload.wunderground.requests.get", boom)
    with pytest.raises(requests.ConnectionError):
        WundergroundUploader(_cfg()).send(_record())


def test_stale_record_is_dropped_not_retried(monkeypatch):
    """flush() stops at the first failure, so a permanently unacceptable record
    pins the cursor and blocks every later one -- how Windy took its station
    offline for two days (docs/uploads.md)."""
    sent = _capture(monkeypatch)
    old = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    assert WundergroundUploader(_cfg()).send(_record(recorded_at=old)) is True
    assert sent == {}  # marked sent without a request


def test_recent_backlog_is_still_backfilled(monkeypatch):
    """WU accepts a backdated dateutc; the bound is only a wedge backstop, so an
    outage shorter than it still lands as real history."""
    sent = _capture(monkeypatch)
    recent = (datetime.now(timezone.utc) - timedelta(hours=6)).isoformat()
    assert WundergroundUploader(_cfg()).send(_record(recorded_at=recent)) is True
    assert sent["params"]["ID"] == "IHOLMP2"
