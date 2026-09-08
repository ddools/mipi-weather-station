"""Weather Underground uploader: field mapping, response handling, wedge guard."""

from datetime import datetime, timedelta, timezone

import pytest
import requests

from weatherstation.config import Config
from weatherstation.core.records import Record
from weatherstation.store import LocalBuffer
from weatherstation.upload.wunderground import WundergroundUploader


class FakeResponse:
    def __init__(self, status_code, text="success"):
        self.status_code = status_code
        self.text = text

    @property
    def ok(self):
        return 200 <= self.status_code < 400


def _cfg(tmp_path):
    return Config(
        {
            "station": {"latitude": 53.58, "longitude": -6.14, "timezone": "Europe/Dublin"},
            "storage": {"sqlite_path": str(tmp_path / "w.sqlite3")},
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


def test_send_converts_to_imperial(tmp_path, monkeypatch):
    sent = _capture(monkeypatch)
    assert WundergroundUploader(_cfg(tmp_path)).send(_record()) is True

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
    # rainin/dailyrainin are window totals from the buffer, not this record's
    # own rain_mm -- an empty buffer means a genuine 0.0, not a missing field.
    assert p["rainin"] == 0.0
    assert p["dailyrainin"] == 0.0


def test_winddir_is_an_integer(tmp_path, monkeypatch):
    """The vane reports 16 points as index * 22.5, so intercardinals are
    fractional -- the field format that wedged Windy for two days (#18)."""
    sent = _capture(monkeypatch)
    WundergroundUploader(_cfg(tmp_path)).send(_record(wind_dir_deg=202.5))
    assert isinstance(sent["params"]["winddir"], int)
    assert sent["params"]["winddir"] == 202


def test_dateutc_is_utc_seconds(tmp_path, monkeypatch):
    """WU wants UTC to the second; a non-UTC offset must be converted, not
    truncated off the end of the string."""
    sent = _capture(monkeypatch)
    WundergroundUploader(_cfg(tmp_path)).send(
        _record(recorded_at="2026-09-08T20:08:30.225308+01:00")
    )
    assert sent["params"]["dateutc"] == "2026-09-08 19:08:30"


def test_missing_fields_are_omitted(tmp_path, monkeypatch):
    sent = _capture(monkeypatch)
    assert (
        WundergroundUploader(_cfg(tmp_path)).send(
            _record(temp_c=None, wind_gust_ms=None, rain_mm=None, humidity=None)
        )
        is True
    )
    p = sent["params"]
    for absent in ("tempf", "windgustmph", "humidity"):
        assert absent not in p
    assert "windspeedmph" in p
    # rain is always reported: WU needs a 0 to draw a dry hour, and dropping
    # dailyrainin leaves it with no accumulation series at all.
    assert p["rainin"] == 0.0
    assert p["dailyrainin"] == 0.0


@pytest.mark.parametrize(
    "status,body,expected",
    [
        (200, "success", True),
        (200, "unauthorized", False),  # fresh device, pre Edit->Save on WU
        (401, "unauthorized", False),
        (500, "server error", False),
    ],
)
def test_send_status_handling(tmp_path, monkeypatch, status, body, expected):
    _capture(monkeypatch, FakeResponse(status, body))
    assert WundergroundUploader(_cfg(tmp_path)).send(_record()) is expected


def test_rejection_records_last_error(tmp_path, monkeypatch):
    _capture(monkeypatch, FakeResponse(401, "unauthorized"))
    up = WundergroundUploader(_cfg(tmp_path))
    up.send(_record())
    assert "401" in up.last_error and "unauthorized" in up.last_error


def test_network_error_propagates(tmp_path, monkeypatch):
    """flush() catches the exception and records it; send() does not swallow it."""

    def boom(*a, **k):
        raise requests.ConnectionError("no route")

    monkeypatch.setattr("weatherstation.upload.wunderground.requests.get", boom)
    with pytest.raises(requests.ConnectionError):
        WundergroundUploader(_cfg(tmp_path)).send(_record())


def test_stale_record_is_dropped_not_retried(tmp_path, monkeypatch):
    """flush() stops at the first failure, so a permanently unacceptable record
    pins the cursor and blocks every later one -- how Windy took its station
    offline for two days (docs/uploads.md)."""
    sent = _capture(monkeypatch)
    old = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    assert WundergroundUploader(_cfg(tmp_path)).send(_record(recorded_at=old)) is True
    assert sent == {}  # marked sent without a request


def test_recent_backlog_is_still_backfilled(tmp_path, monkeypatch):
    """WU accepts a backdated dateutc; the bound is only a wedge backstop, so an
    outage shorter than it still lands as real history."""
    sent = _capture(monkeypatch)
    recent = (datetime.now(timezone.utc) - timedelta(hours=6)).isoformat()
    assert WundergroundUploader(_cfg(tmp_path)).send(_record(recorded_at=recent)) is True
    assert sent["params"]["ID"] == "IHOLMP2"


def test_rain_is_an_hourly_accumulation_not_the_interval(tmp_path, monkeypatch):
    """`rainin` is WU's "accumulated rainfall in the past 60 min", not the rain
    that fell during this one 60s archive interval. Sending the record's own
    `rain_mm` under-reported every shower by roughly 60x."""
    buf = LocalBuffer(tmp_path / "w.sqlite3")
    now = datetime.now(timezone.utc)
    # four tips in the last hour, one well outside it
    for mins in (5, 20, 40, 55, 200):
        rec = Record(rain_mm=0.2794)
        rec.recorded_at = (now - timedelta(minutes=mins)).isoformat()
        buf.append(rec)

    sent = _capture(monkeypatch)
    WundergroundUploader(_cfg(tmp_path)).send(_record())

    p = sent["params"]
    assert p["rainin"] == pytest.approx(round(4 * 0.2794 / 25.4, 3))  # not 0.011
    assert p["dailyrainin"] == pytest.approx(round(5 * 0.2794 / 25.4, 3))


def test_rain_window_follows_the_record_not_the_clock(tmp_path, monkeypatch):
    """A backfilled record must carry the rain from the hour before *it*, not
    the hour before now -- otherwise a replayed backlog stamps today's shower
    onto yesterday's readings."""
    buf = LocalBuffer(tmp_path / "w.sqlite3")
    now = datetime.now(timezone.utc)
    for mins in (10, 400):  # one recent tip, one an hour before the backfilled record
        rec = Record(rain_mm=0.2794)
        rec.recorded_at = (now - timedelta(minutes=mins)).isoformat()
        buf.append(rec)

    sent = _capture(monkeypatch)
    backfilled = (now - timedelta(minutes=380)).isoformat()
    WundergroundUploader(_cfg(tmp_path)).send(_record(recorded_at=backfilled))

    # only the 400-min-ago tip is inside that record's preceding hour
    assert sent["params"]["rainin"] == pytest.approx(round(0.2794 / 25.4, 3))
