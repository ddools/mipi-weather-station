from datetime import datetime, timezone

from weatherstation.config import Config
from weatherstation.core.records import Record
from weatherstation.store import LocalBuffer
from weatherstation.upload.cwop import CWOPUploader, format_packet

_LAT, _LON = 53.35, -6.26


def _cfg(tmp_path, **cwop):
    base = {"enabled": True, "station_id": "CW0000", "send_interval_s": 300}
    base.update(cwop)
    return Config(
        {
            "station": {"latitude": _LAT, "longitude": _LON, "timezone": "Europe/Dublin"},
            "storage": {"sqlite_path": str(tmp_path / "w.sqlite3")},
            "uploaders": {"cwop": base},
            "env": {"cwop_passcode": "-1"},
        }
    )


def _fresh_iso():
    return datetime.now(timezone.utc).isoformat()


def test_format_packet_full_record():
    record = {
        "recorded_at": "2026-08-30T09:23:45+00:00",
        "temp_c": 20.0,
        "humidity": 72,
        "pressure_msl_hpa": 1013.2,
        "wind_speed_ms": 5.0,
        "wind_gust_ms": 8.0,
        "wind_dir_deg": 180,
    }
    packet = format_packet("CW0000", _LAT, _LON, record, 0.0, 0.0, 0.0)
    assert packet == (
        "CW0000>APRS,TCPIP*:@300923z5321.00N/00615.60W_180/011g018t068r000p000P000h72b10132mipiWX"
    )


def test_format_packet_negative_temp_and_missing_fields():
    record = {
        "recorded_at": "2026-01-05T00:00:00+00:00",
        "temp_c": -6.0,  # 21.2 F
        "wind_dir_deg": None,
        "wind_speed_ms": None,
    }
    packet = format_packet("CW0000", _LAT, _LON, record, 0.0, 0.0, 0.0)
    body = packet.split(":", 1)[1]
    assert body.startswith("@050000z5321.00N/00615.60W_.../...g...t021")
    assert "h" not in body[body.index("P000") :]  # humidity omitted
    assert "b" not in body[body.index("P000") :]  # pressure omitted


def test_format_packet_sub_zero_fahrenheit():
    record = {"recorded_at": "2026-01-05T12:00:00+00:00", "temp_c": -20.0}  # -4 F
    packet = format_packet("CW0000", _LAT, _LON, record, 0.0, 0.0, 0.0)
    assert "t-04" in packet


def test_format_packet_international_gw_id():
    """Ours is a GW id (non-US) — the prefix is passed through untouched."""
    record = {"recorded_at": "2026-08-31T09:23:45+00:00", "temp_c": 20.0}
    packet = format_packet("GW7965", _LAT, _LON, record, 0.0, 0.0, 0.0)
    assert packet.startswith("GW7965>APRS,TCPIP*:@310923z5321.00N/00615.60W_")


def test_station_id_is_upper_cased(tmp_path):
    up = CWOPUploader(_cfg(tmp_path, station_id="gw7965"))
    assert up._callsign == "GW7965"


def test_rain_windows_sum_from_buffer(tmp_path):
    buf = LocalBuffer(tmp_path / "w.sqlite3")
    now = datetime.now(timezone.utc)
    # three tips inside the last hour, one well outside it
    for mins, mm in [(5, 0.28), (30, 0.28), (50, 0.28), (600, 0.28)]:
        rec = Record(rain_mm=mm)
        rec.recorded_at = (now - _minutes(mins)).isoformat()
        buf.append(rec)

    up = CWOPUploader(_cfg(tmp_path))
    r1, r24, _rmid = up._rain_windows(now)
    assert round(r1, 2) == 0.84
    assert round(r24, 2) == 1.12


def test_rain_windows_missing_db_returns_zeros(tmp_path):
    up = CWOPUploader(_cfg(tmp_path))
    assert up._rain_windows(datetime.now(timezone.utc)) == (0.0, 0.0, 0.0)


def test_send_skips_stale_record_without_transmitting(tmp_path):
    up = CWOPUploader(_cfg(tmp_path))
    up._transmit = _boom
    old = (datetime.now(timezone.utc) - _minutes(30)).isoformat()
    assert up.send({"recorded_at": old, "temp_c": 12.0}) is True


def test_send_skips_empty_record(tmp_path):
    up = CWOPUploader(_cfg(tmp_path))
    up._transmit = _boom
    assert up.send({"recorded_at": _fresh_iso()}) is True


def test_send_throttles_to_interval(tmp_path):
    up = CWOPUploader(_cfg(tmp_path))
    calls = []
    up._transmit = lambda packet: calls.append(packet) or True

    assert up.send({"recorded_at": _fresh_iso(), "temp_c": 15.0}) is True
    assert up.send({"recorded_at": _fresh_iso(), "temp_c": 15.5}) is True
    assert len(calls) == 1  # second call is inside the 5-minute window


def test_send_reports_transmit_failure(tmp_path):
    up = CWOPUploader(_cfg(tmp_path))
    up._transmit = lambda packet: False
    assert up.send({"recorded_at": _fresh_iso(), "temp_c": 15.0}) is False


def _minutes(n):
    from datetime import timedelta

    return timedelta(minutes=n)


def _boom(_packet):
    raise AssertionError("_transmit should not be called")
