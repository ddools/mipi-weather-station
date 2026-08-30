"""CWOP (Citizen Weather Observer Program) upload via APRS-IS.

CWOP has no HTTP API: observations are pushed as APRS weather packets over a
plain TCP socket to an APRS-IS server (cwop.aprs.net:14580), which feeds NOAA
MADIS and, from there, National Weather Service forecast models. Non-ham
stations use a CW/DW/EW id and the APRS-IS passcode ``-1``; licensed amateur
operators use their callsign and a real passcode.

CWOP wants at most one report per ~5 minutes and only cares about *current*
conditions, so this uploader:

- self-throttles to ``send_interval_s`` (default 300 s), returning success
  without transmitting inside the window (same trick as the Windy uploader);
- drops records older than ``_MAX_AGE_S`` outright -- a backlog replayed after
  an outage is stale weather that MADIS would reject anyway;
- derives the APRS rain fields (last hour / last 24 h / since local midnight)
  by summing ``rain_mm`` straight from the local SQLite buffer, which is the
  source of truth and survives an uploader restart.

APRS weather packet reference: http://www.aprs.org/doc/APRS101.PDF section 12.
CWOP formatting notes: http://www.wxqa.com/faq.html
"""

from __future__ import annotations

import contextlib
import logging
import socket
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .. import __version__
from ..core import units
from .base import Uploader

log = logging.getLogger(__name__)

# Name reported on the APRS-IS login line and (abbreviated) at the tail of each
# packet, so the station is identifiable on findu.com / aprs.fi while debugging.
_SOFTWARE = "mipi-weatherstation"
_APRS_ID = "mipiWX"

# CWOP feeds a realtime analysis; anything older than this is not worth sending.
_MAX_AGE_S = 600


def _fmt_lat(lat: float) -> str:
    """Decimal degrees -> APRS ``DDMM.mmH`` (8 chars)."""
    hemi = "N" if lat >= 0 else "S"
    lat = abs(lat)
    deg = int(lat)
    return f"{deg:02d}{(lat - deg) * 60:05.2f}{hemi}"


def _fmt_lon(lon: float) -> str:
    """Decimal degrees -> APRS ``DDDMM.mmH`` (9 chars)."""
    hemi = "E" if lon >= 0 else "W"
    lon = abs(lon)
    deg = int(lon)
    return f"{deg:03d}{(lon - deg) * 60:05.2f}{hemi}"


def _fmt_wind(dir_deg: float | None, speed_ms: float | None) -> str:
    """``ddd/sss`` -- wind bearing (deg) and sustained speed (mph). Dots if unknown."""
    d = "..." if dir_deg is None else f"{int(round(dir_deg)) % 360:03d}"
    s = "..." if speed_ms is None else f"{min(999, int(round(units.ms_to_mph(speed_ms)))):03d}"
    return f"{d}/{s}"


def _fmt_gust(gust_ms: float | None) -> str:
    if gust_ms is None:
        return "g..."
    return f"g{min(999, int(round(units.ms_to_mph(gust_ms)))):03d}"


def _fmt_temp(temp_c: float | None) -> str:
    """``tddd`` in Fahrenheit; sub-zero as ``t-dd``. Dots if unknown."""
    if temp_c is None:
        return "t..."
    n = int(round(units.c_to_f(temp_c)))
    if n < 0:
        return f"t-{min(99, -n):02d}"
    return f"t{min(999, n):03d}"


def _rain_hundredths(mm: float) -> int:
    """mm -> hundredths of an inch, clamped to the APRS 3-digit field."""
    return min(999, max(0, int(round(units.mm_to_in(mm) * 100))))


def format_packet(
    callsign: str,
    lat: float,
    lon: float,
    record: dict,
    rain_1h_mm: float,
    rain_24h_mm: float,
    rain_since_midnight_mm: float,
) -> str:
    """Build the full APRS-IS weather packet line (no trailing CRLF)."""
    dt = datetime.fromisoformat(record["recorded_at"].replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    ts = dt.astimezone(timezone.utc).strftime("%d%H%M") + "z"

    # Order is fixed by the APRS spec: wind, gust, temp, rain(1h/24h/midnight),
    # humidity, pressure. The '/' after the latitude is the symbol-table id; the
    # '_' after the longitude is the weather-station symbol code.
    parts = [
        f"@{ts}{_fmt_lat(lat)}/{_fmt_lon(lon)}_",
        _fmt_wind(record.get("wind_dir_deg"), record.get("wind_speed_ms")),
        _fmt_gust(record.get("wind_gust_ms")),
        _fmt_temp(record.get("temp_c")),
        f"r{_rain_hundredths(rain_1h_mm):03d}",
        f"p{_rain_hundredths(rain_24h_mm):03d}",
        f"P{_rain_hundredths(rain_since_midnight_mm):03d}",
    ]

    rh = record.get("humidity")
    if rh is not None:
        h = int(round(rh))
        # APRS: h00 == 100%; otherwise 01..99.
        parts.append(f"h{0 if h >= 100 else max(1, h):02d}")

    pmsl = record.get("pressure_msl_hpa")
    if pmsl is not None:
        # Sea-level pressure in tenths of a millibar/hPa, 5 digits (b10132 = 1013.2).
        parts.append(f"b{min(99999, max(0, int(round(pmsl * 10)))):05d}")

    return f"{callsign}>APRS,TCPIP*:{''.join(parts)}{_APRS_ID}"


class CWOPUploader(Uploader):
    name = "cwop"

    def __init__(self, cfg) -> None:
        c = cfg.uploaders.cwop
        self._callsign = str(c.station_id).upper()
        self._passcode = str(cfg.env.cwop_passcode or "-1")
        self._host = c.get("server", "cwop.aprs.net")
        self._port = int(c.get("port", 14580))
        self._interval_s = int(c.get("send_interval_s", 300))
        self._lat = float(cfg.station.latitude)
        self._lon = float(cfg.station.longitude)
        self._tz = cfg.station.get("timezone", "UTC")
        self._sqlite_path = str(cfg.storage.sqlite_path)
        self._timeout = 20
        self._last_sent_at = float("-inf")

    def send(self, record: dict) -> bool:
        now = time.monotonic()
        if now - self._last_sent_at < self._interval_s:
            return True  # inside CWOP's ~5-minute window -- skip, not a failure

        dt = datetime.fromisoformat(record["recorded_at"].replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        now_utc = datetime.now(timezone.utc)
        if (now_utc - dt).total_seconds() > _MAX_AGE_S:
            return True  # too stale for a realtime network -- drop it, mark sent

        if all(
            record.get(k) is None
            for k in ("temp_c", "humidity", "pressure_msl_hpa", "wind_speed_ms")
        ):
            return True  # nothing worth reporting

        r1, r24, rmid = self._rain_windows(now_utc)
        packet = format_packet(self._callsign, self._lat, self._lon, record, r1, r24, rmid)
        ok = self._transmit(packet)
        if ok:
            self._last_sent_at = now
        return ok

    def _rain_windows(self, now_utc: datetime) -> tuple[float, float, float]:
        """(last hour, last 24 h, since local midnight) rain totals in mm."""
        windows = (
            (now_utc - timedelta(hours=1)).isoformat(),
            (now_utc - timedelta(hours=24)).isoformat(),
            self._local_midnight_utc(now_utc).isoformat(),
        )
        q = (
            "SELECT COALESCE(SUM(json_extract(payload, '$.rain_mm')), 0) "
            "FROM readings WHERE recorded_at >= ?"
        )
        try:
            db = sqlite3.connect(f"file:{self._sqlite_path}?mode=ro", uri=True, timeout=5)
            try:
                return tuple(float(db.execute(q, (since,)).fetchone()[0]) for since in windows)
            finally:
                db.close()
        except sqlite3.Error as e:
            log.warning("cwop: rain lookup failed (%s); reporting zeros", e)
            return 0.0, 0.0, 0.0

    def _local_midnight_utc(self, now_utc: datetime) -> datetime:
        try:
            local = now_utc.astimezone(ZoneInfo(self._tz))
        except Exception:
            log.warning("cwop: unknown timezone %r; using UTC midnight for rain total", self._tz)
            return now_utc.replace(hour=0, minute=0, second=0, microsecond=0)
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
        return midnight.astimezone(timezone.utc)

    def _transmit(self, packet: str) -> bool:
        login = f"user {self._callsign} pass {self._passcode} vers {_SOFTWARE} {__version__}\r\n"
        try:
            with socket.create_connection((self._host, self._port), timeout=self._timeout) as sock:
                sock.settimeout(self._timeout)
                sock.sendall(login.encode("ascii"))
                # The server sends a banner + "# logresp ..." line; a bad passcode
                # for a real callsign shows up here. A read timeout is not fatal --
                # APRS-IS never acks the observation itself anyway.
                with contextlib.suppress(OSError):
                    resp = sock.recv(4096).decode("ascii", "replace")
                    if "invalid" in resp.lower():
                        log.warning("cwop: server rejected login: %s", resp.strip())
                        return False
                sock.sendall((packet + "\r\n").encode("ascii"))
                time.sleep(1.0)  # let the packet flush before the socket closes
            log.info("cwop: sent %s", packet)
            return True
        except OSError as e:
            log.warning("cwop: socket error talking to %s:%s: %s", self._host, self._port, e)
            return False
