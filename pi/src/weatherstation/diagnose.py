"""`weatherstation-doctor` — check the sensors that most often go quietly wrong.

Two sections, both printed by default:

* **Thermometers.** The kit has three and only one of them is trustworthy for
  air temperature, so this prints all three side by side with the differences
  between them and marks the one being published.
* **Rain gauge.** A tipping bucket that has stopped tipping looks exactly like
  dry weather in the data, so this reads the collector's own SQLite buffer and
  shows how many tips it has actually recorded, and when.
* **Uploads.** Each destination has its own cursor into the buffer, so one can
  be stuck for days while the others stay perfectly healthy and the dashboard
  looks fine. This shows how far behind each one is and why it stopped.

Run it on the Pi, in the same virtualenv as the collector — from anywhere, the
config file is found relative to the installation:

    ~/mipi-weather-station/pi/.venv/bin/weatherstation-doctor
    weatherstation-doctor --rain-watch     # tip the bucket by hand and watch
    weatherstation-doctor --uploads        # per-destination upload health only
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

_W1_ROOT = "/sys/bus/w1/devices"

# Below this spread the onboard chips are not meaningfully self-heating, so a
# reading that is still too warm is a siting problem rather than this one.
_SELF_HEATING_THRESHOLD_C = 3.0

# How far back the rain section looks. The hourly breakdown covers all of it —
# a truncated table can disagree with the 'last tip' line below it, which is
# exactly the sort of thing that sends you chasing the wrong fault.
_RAIN_WINDOW_H = 24

# A cursor this far behind the newest reading is not "briefly catching up".
# The archive interval is 60s, so this is ~10 records.
_BACKLOG_STALL_S = 600

# The kit's bucket, from config.example.yaml — only a fallback for when the real
# config can't be read.
_DEFAULT_BUCKET_MM = 0.2794


# --------------------------------------------------------------------------- config


def _find_config() -> Path | None:
    """config.yaml from the cwd, else next to the installed package.

    The collector is always started from `pi/` by its systemd unit, but the
    doctor gets run from wherever the operator happens to be standing. Falling
    back to a cwd-relative lookup made it silently report defaults instead of
    what the station is actually configured with.
    """
    cwd = Path("config.yaml")
    if cwd.exists():
        return cwd
    # .../pi/src/weatherstation/diagnose.py -> .../pi/config.yaml
    installed = Path(__file__).resolve().parents[2] / "config.yaml"
    return installed if installed.exists() else None


def _load_config():
    """(cfg or None, path or None, error string or None)."""
    path = _find_config()
    if path is None:
        return None, None, "config.yaml not found (looked in the cwd and next to the package)"
    try:
        from . import config

        return config.load(path), path, None
    except Exception as e:
        return None, path, f"{type(e).__name__}: {e}"


# ----------------------------------------------------------------------- thermometers


def _probe_status() -> tuple[str, float | None]:
    from .sensors.ds18b20 import DS18B20Sensor, find_device

    if not os.path.isdir(_W1_ROOT):
        return (
            f"1-Wire is not enabled (no {_W1_ROOT}) — run "
            "`sudo raspi-config nonint do_onewire 0` and reboot"
        ), None
    path = find_device()
    if path is None:
        return (
            "1-Wire is enabled, but no 28-* probe is on the bus — "
            "check the probe's wiring on GPIO 4"
        ), None
    temp_c = DS18B20Sensor(path).read_c()
    device = path.split("/")[-2]
    if temp_c is None:
        return f"probe {device} found, but this read failed (bad CRC or reset sentinel)", None
    return f"probe {device}", temp_c


def _onboard() -> tuple[float | None, float | None, float | None, float | None, str | None]:
    """(bmp_temp_c, pressure_hpa, htu_temp_c, rh_pct, error)."""
    try:
        from .sensors.bmp085 import BMP085Sensor
        from .sensors.humidity import HTU21DSensor

        bmp_temp, pressure = BMP085Sensor().read()
        htu_temp, rh = HTU21DSensor().read_temp_rh()
    except Exception as e:
        return None, None, None, None, f"{type(e).__name__}: {e}"
    return bmp_temp, pressure, htu_temp, rh, None


def _fmt(value: float | None, unit: str, places: int = 1) -> str:
    return "  --  " if value is None else f"{value:.{places}f} {unit}"


def _delta(value: float | None, ref: float | None) -> str:
    if value is None or ref is None:
        return ""
    return f"({value - ref:+.1f} C vs probe)"


_SITING_NOTES = [
    "",
    "The probe must be in shade at all times, in a ventilated radiation shield,",
    "about 1.5 m up, away from walls, roofs, tarmac and the enclosure itself. In",
    "direct sun an unshielded probe reads 5-10 C over true air temperature, and",
    "it stays high for a while after the sun has moved off it.",
]


def _temp_verdict(
    source: str, probe_temp: float | None, onboard_temp: float | None, spread: float | None
) -> list[str]:
    if probe_temp is None and onboard_temp is None:
        return [
            "No thermometer could be read at all, so there is nothing to compare.",
            "Check the lines above: on the Pi this usually means I2C or 1-Wire is",
            "disabled (`sudo raspi-config nonint do_i2c 0` / `do_onewire 0`, then",
            "reboot), or that this is not running on the station hardware.",
        ]
    if probe_temp is None and source == "onboard":
        return [
            "Air temperature is coming from the onboard BMP085 because config.yaml",
            "sets calibration.air_temp_source: onboard. That chip is bolted next to",
            "the Pi and self-heats — measured at +11 C on this hardware — so the",
            "station will report several degrees warmer than it actually is.",
            "",
            "Fix: set air_temp_source back to `auto` and restart the collector.",
        ]
    if probe_temp is None:
        return [
            "Air temperature is coming from the onboard BMP085, because no DS18B20",
            "probe is readable. That chip is bolted next to the Pi and self-heats —",
            "measured at +11 C on this hardware — so the station is reporting the",
            "inside of the enclosure, not the air. This is the usual cause of a",
            "station that reads several degrees warmer than the forecast.",
            "",
            "Fix: get the probe back on the bus (see the 1-Wire line above). The",
            "collector re-checks every 60s and switches over on its own once the",
            "probe appears — no restart needed.",
        ]
    if spread is not None and spread >= _SELF_HEATING_THRESHOLD_C:
        return [
            f"Working as intended: the onboard chips are running {spread:.1f} C hotter than",
            "the probe (self-heating), and the collector is correctly reporting the",
            "probe instead. The published temperature is the probe's.",
            "",
            "If that figure is still too warm, the probe itself is badly sited:",
        ] + _SITING_NOTES
    return [
        f"The probe and the onboard chips agree to within {spread:.1f} C, so self-heating",
        "is not what is inflating this reading. The published temperature is the",
        "probe's, and if it reads too warm the cause is siting, not the hardware:",
    ] + _SITING_NOTES


def _buffer_path(cfg, cfg_path: Path | None) -> Path | None:
    """Locate the collector's SQLite buffer from config.

    sqlite_path is relative to the collector's working directory, which is the
    directory holding config.yaml -- not wherever the doctor was invoked from.
    """
    if not cfg:
        return None
    raw = cfg.storage.get("sqlite_path", "data/weather.sqlite3")
    base = cfg_path.resolve().parent if cfg_path else Path.cwd()
    return Path(raw) if Path(raw).is_absolute() else base / raw


def print_thermometers(cfg) -> None:
    source = cfg.calibration.get("air_temp_source", "auto") if cfg else "auto"
    w1_status, probe_temp = _probe_status()
    bmp_temp, pressure, htu_temp, rh, err = _onboard()

    if source == "onboard":
        probe_temp = None  # config forbids it, whatever the bus says
        w1_status += "  [ignored: air_temp_source=onboard]"

    reported = probe_temp if probe_temp is not None else bmp_temp
    onboard_temps = [t for t in (bmp_temp, htu_temp) if t is not None]
    spread = (
        max(t - probe_temp for t in onboard_temps)
        if probe_temp is not None and onboard_temps
        else None
    )

    print("thermometers")
    print()
    print(f"  air_temp_source : {source}")
    print(f"  1-Wire          : {w1_status}")
    if err:
        print(f"  I2C air board   : unreadable — {err}")
    print()
    used = " <- reported as air temperature"
    print(
        f"  DS18B20 probe (1-Wire, on a lead) {_fmt(probe_temp, 'C')}"
        f"{used if probe_temp is not None else ''}".rstrip()
    )
    print(
        f"  BMP085 onboard (I2C 0x77)         {_fmt(bmp_temp, 'C')} "
        f"{_delta(bmp_temp, probe_temp)}"
        f"{used if probe_temp is None and bmp_temp is not None else ''}".rstrip()
    )
    print(
        f"  HTU21D onboard (I2C 0x40)         {_fmt(htu_temp, 'C')} "
        f"{_delta(htu_temp, probe_temp)}".rstrip()
    )
    print()
    print(f"  pressure  {_fmt(pressure, 'hPa', 2)} (station)")
    print(f"  humidity  {_fmt(rh, '%RH')} as measured at the chip")
    print(f"  the collector would publish {_fmt(reported, 'C')} right now")
    print()
    for line in _temp_verdict(source, probe_temp, bmp_temp, spread):
        print(f"  {line}".rstrip())


# ------------------------------------------------------------------------- rain gauge


@dataclass
class RainSummary:
    """What the collector's own buffer says the gauge has done."""

    records: int = 0
    span_h: float = 0.0
    total_mm: float = 0.0
    tips: int = 0
    last_tip: datetime | None = None
    hourly: list[tuple[datetime, float, int]] = field(default_factory=list)


def summarise_rain(rows, bucket_mm: float, tz: ZoneInfo) -> RainSummary:
    """Fold archive rows into per-hour rain totals.

    `rows` is an iterable of (recorded_at ISO string, rain_mm or None), as stored
    by the collector. Rows without a rain figure are counted as records (the
    collector was alive) but contribute no rain, which is the honest reading of a
    failed sensor cycle.
    """
    summary = RainSummary()
    buckets: dict[datetime, float] = {}
    stamps: list[datetime] = []

    for recorded_at, rain_mm in rows:
        try:
            when = datetime.fromisoformat(recorded_at)
        except (TypeError, ValueError):
            continue
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        summary.records += 1
        stamps.append(when)
        if rain_mm is None:
            continue
        mm = float(rain_mm)
        summary.total_mm += mm
        if mm > 0:
            summary.last_tip = when if summary.last_tip is None else max(summary.last_tip, when)
        hour = when.astimezone(tz).replace(minute=0, second=0, microsecond=0)
        buckets[hour] = buckets.get(hour, 0.0) + mm

    if stamps:
        summary.span_h = (max(stamps) - min(stamps)).total_seconds() / 3600.0
    # Tip counts are derived, not stored: the collector only records millimetres.
    summary.tips = round(summary.total_mm / bucket_mm) if bucket_mm else 0
    summary.hourly = [
        (hour, mm, round(mm / bucket_mm) if bucket_mm else 0)
        for hour, mm in sorted(buckets.items())
    ]
    return summary


def _read_rain_rows(db_path: Path, since: datetime):
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    try:
        return db.execute(
            "SELECT recorded_at, json_extract(payload, '$.rain_mm') FROM readings "
            "WHERE recorded_at >= ? ORDER BY recorded_at",
            (since.isoformat(),),
        ).fetchall()
    finally:
        db.close()


def _rain_verdict(summary: RainSummary, bucket_mm: float) -> list[str]:
    if summary.records == 0:
        return [
            "The buffer holds no records for this window at all, so this says nothing",
            "about the gauge — the collector was not archiving. Check the service with",
            "`systemctl status weatherstation` and `journalctl -u weatherstation`.",
        ]
    if summary.tips == 0:
        return [
            f"The gauge has not tipped once in {summary.span_h:.1f}h of records. If it has been",
            "raining in that time, the gauge is not reporting — see the test below.",
        ]
    tips = f"{summary.tips} tip" + ("" if summary.tips == 1 else "s")
    rate = summary.tips / summary.span_h if summary.span_h else 0.0
    return [
        f"The collector recorded {tips} ({summary.total_mm:.2f} mm) over {summary.span_h:.1f}h —",
        f"an average of {rate:.1f} tips an hour. Each tip is {bucket_mm} mm, so steady",
        "light rain (~1 mm/h) should produce roughly 3-4 tips an hour, and heavy rain",
        "many more. Far fewer than that while it is genuinely raining means the gauge",
        "is not keeping up — see the test below.",
    ]


_RAIN_TEST_NOTES = [
    "",
    "To tell a blocked gauge from a dead switch, stop the collector and tip the",
    "bucket by hand:",
    "",
    "    sudo systemctl stop weatherstation",
    "    weatherstation-doctor --rain-watch",
    "    sudo systemctl start weatherstation      # when you are done",
    "",
    "Each tip should print a line. If they register, the switch and wiring are",
    "fine and the funnel is blocked — leaves, silt, or a spider's web in the",
    "throat, or the bucket fouled so it cannot rock. If nothing registers, it is",
    "the reed switch or its wiring to GPIO 6.",
]


def print_rain(cfg, cfg_path: Path | None) -> None:
    print("rain gauge")
    print()
    bucket_mm = _DEFAULT_BUCKET_MM
    tz = timezone.utc
    db_path = None
    if cfg:
        bucket_mm = cfg.calibration.get("rain_bucket_mm", _DEFAULT_BUCKET_MM)
        tz_name = cfg.station.get("timezone", "UTC")
        try:
            tz = ZoneInfo(tz_name)
        except Exception:
            # Say so rather than silently labelling the hourly table in UTC —
            # a table an hour out is worse than one that admits it.
            print(f"  note    : unknown timezone {tz_name!r}; hours shown in UTC")
        db_path = _buffer_path(cfg, cfg_path)

    if db_path is None or not db_path.exists():
        print(f"  buffer  : not found ({db_path or 'no config'})")
        print()
        print("  Without the collector's SQLite buffer there is nothing to read here.")
        return

    since = datetime.now(timezone.utc) - timedelta(hours=_RAIN_WINDOW_H)
    try:
        rows = _read_rain_rows(db_path, since)
    except sqlite3.Error as e:
        print(f"  buffer  : unreadable — {e}")
        return

    summary = summarise_rain(rows, bucket_mm, tz)
    print(f"  buffer  : {db_path}")
    print(f"  bucket  : {bucket_mm} mm per tip")
    print(f"  window  : last {_RAIN_WINDOW_H}h — {summary.records} records")
    print()
    if summary.hourly:
        print("  hour (local)     rain     tips")
        for hour, mm, tips in summary.hourly:
            bar = "#" * min(tips, 40)
            print(f"  {hour:%a %H:%M}        {mm:5.2f} mm  {tips:4d}  {bar}".rstrip())
        print()
    plural = "" if summary.tips == 1 else "s"
    print(f"  total   : {summary.total_mm:.2f} mm in {summary.tips} tip{plural}")
    if summary.last_tip is not None:
        ago = (datetime.now(timezone.utc) - summary.last_tip).total_seconds() / 3600.0
        print(f"  last tip: {summary.last_tip.astimezone(tz):%a %H:%M} ({ago:.1f}h ago)")
    else:
        print("  last tip: none in this window")
    print()
    for line in _rain_verdict(summary, bucket_mm) + _RAIN_TEST_NOTES:
        print(f"  {line}".rstrip())


def watch_rain(cfg, seconds: int) -> None:
    """Live tip counter, for tipping the bucket by hand."""
    pin = cfg.pins.rain_gauge if cfg else 6
    bucket_mm = (
        cfg.calibration.get("rain_bucket_mm", _DEFAULT_BUCKET_MM) if cfg else _DEFAULT_BUCKET_MM
    )

    try:
        from .sensors.rain import RainGauge

        gauge = RainGauge(pin)
    except Exception as e:
        print(f"Could not claim GPIO {pin}: {type(e).__name__}: {e}")
        print()
        print("The collector holds this pin while it is running. Stop it first:")
        print("    sudo systemctl stop weatherstation")
        print("and remember to start it again afterwards.")
        return

    print(f"Watching GPIO {pin} for {seconds}s — tip the bucket by hand.")
    print("Each tip should print a line. Ctrl-C to stop early.")
    print()
    total = 0
    deadline = time.monotonic() + seconds
    try:
        while time.monotonic() < deadline:
            time.sleep(0.2)
            tips = gauge.read_and_reset()
            for _ in range(tips):
                total += 1
                print(
                    f"  tip {total:3d}  at {datetime.now():%H:%M:%S}  = {total * bucket_mm:.3f} mm"
                )
    except KeyboardInterrupt:
        pass
    print()
    if total:
        print(f"{total} tip(s) registered — the switch, wiring and counting path all work.")
        print("A gauge that works by hand but not in rain has a blocked funnel or a")
        print("bucket that cannot rock freely.")
    else:
        print("No tips registered. If you were tipping the bucket, the fault is the reed")
        print(f"switch or its wiring to GPIO {pin}.")


# ----------------------------------------------------------------------- uploads


@dataclass
class UploaderState:
    name: str
    last_sent_id: int
    backlog: int
    oldest_unsent: datetime | None
    last_error: str | None
    last_error_at: str | None


def _read_upload_state(db_path: Path) -> tuple[list[UploaderState], int, datetime | None]:
    """Per-uploader cursors plus the newest reading, read-only.

    Read-only on purpose: the collector is normally running against this same
    file, and a diagnostic must never take a write lock out from under it.
    """
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    try:
        row = db.execute("SELECT COALESCE(MAX(id), 0), COUNT(*) FROM readings").fetchone()
        max_id = row[0]
        have = {c[1] for c in db.execute("PRAGMA table_info(upload_state)")}
        # A buffer written before the error columns existed still reports cursors.
        errors = "last_error, last_error_at" if "last_error" in have else "NULL, NULL"
        rows = db.execute(
            f"SELECT uploader, last_sent_id, {errors} FROM upload_state ORDER BY uploader"
        ).fetchall()

        states = []
        for name, last_sent_id, last_error, last_error_at in rows:
            backlog = db.execute(
                "SELECT COUNT(*) FROM readings WHERE id > ?", (last_sent_id,)
            ).fetchone()[0]
            oldest = db.execute(
                "SELECT recorded_at FROM readings WHERE id > ? ORDER BY id LIMIT 1",
                (last_sent_id,),
            ).fetchone()
            states.append(
                UploaderState(
                    name=name,
                    last_sent_id=last_sent_id,
                    backlog=backlog,
                    oldest_unsent=_parse_utc(oldest[0]) if oldest else None,
                    last_error=last_error,
                    last_error_at=last_error_at,
                )
            )

        newest = db.execute("SELECT recorded_at FROM readings ORDER BY id DESC LIMIT 1").fetchone()
        return states, max_id, _parse_utc(newest[0]) if newest else None
    finally:
        db.close()


def _parse_utc(value: str) -> datetime | None:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def _fmt_age(seconds: float) -> str:
    if seconds < 90:
        return f"{seconds:.0f}s"
    if seconds < 5400:
        return f"{seconds / 60:.0f}m"
    if seconds < 172800:
        return f"{seconds / 3600:.1f}h"
    return f"{seconds / 86400:.1f}d"


def _upload_verdict(states: list[UploaderState], now: datetime) -> list[str]:
    stalled = [
        s
        for s in states
        if s.oldest_unsent is not None
        and (now - s.oldest_unsent).total_seconds() > _BACKLOG_STALL_S
    ]
    if not stalled:
        if any(s.backlog for s in states):
            return ["Every destination is current or catching up normally."]
        return ["Every destination is up to date."]

    lines = []
    for s in stalled:
        age = _fmt_age((now - s.oldest_unsent).total_seconds())
        lines.append(f"{s.name} is stuck {age} behind at record {s.last_sent_id + 1}.")
        if s.last_error:
            lines.append(f"  it refused that record with: {s.last_error}")
        else:
            lines.append("  no reason recorded — check the log for the HTTP status:")
            lines.append(f"  journalctl -u weatherstation | grep -i {s.name}")
    lines.append("")
    lines.append("A cursor stops at the first record a destination refuses, to keep the")
    lines.append("readings in order, so everything newer is queued behind that one record.")
    lines.append("Fix the cause and the backlog drains on its own; the other destinations")
    lines.append("are unaffected, which is why the website can look healthy throughout.")
    return lines


def print_uploads(cfg, cfg_path: Path | None) -> None:
    print("uploads")
    print()
    db_path = _buffer_path(cfg, cfg_path)
    if db_path is None or not db_path.exists():
        print(f"  buffer  : not found ({db_path or 'no config'})")
        print()
        print("  Without the collector's SQLite buffer there is nothing to read here.")
        return

    try:
        states, max_id, newest = _read_upload_state(db_path)
    except sqlite3.Error as e:
        print(f"  buffer  : unreadable — {e}")
        return

    now = datetime.now(timezone.utc)
    print(f"  buffer  : {db_path}")
    newest_age = f" ({_fmt_age((now - newest).total_seconds())} ago)" if newest else ""
    print(f"  latest  : record {max_id}{newest_age}")
    print()

    if not states:
        print("  No uploader has recorded a cursor yet — none has run against this buffer.")
        return

    print(f"  {'destination':<14}{'cursor':>8}{'behind':>9}{'oldest unsent':>16}")
    for s in states:
        age = "—"
        if s.oldest_unsent is not None:
            age = _fmt_age((now - s.oldest_unsent).total_seconds())
        print(f"  {s.name:<14}{s.last_sent_id:>8}{s.backlog:>9}{age:>16}")
    print()
    for line in _upload_verdict(states, now):
        print(f"  {line}" if line else "")


# ------------------------------------------------------------------------------- cli


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--temp", action="store_true", help="thermometer section only")
    parser.add_argument("--rain", action="store_true", help="rain gauge section only")
    parser.add_argument("--uploads", action="store_true", help="per-destination upload health only")
    parser.add_argument(
        "--rain-watch",
        nargs="?",
        type=int,
        const=60,
        metavar="SECONDS",
        help="watch the gauge live for SECONDS (default 60) so you can tip it by hand; "
        "needs the collector stopped",
    )
    args = parser.parse_args()

    cfg, cfg_path, cfg_err = _load_config()

    if args.rain_watch is not None:
        watch_rain(cfg, args.rain_watch)
        return

    print("mipi weather station — station check")
    print()
    print(f"  config  : {cfg_path or 'not found'}{f' — {cfg_err}' if cfg_err else ''}")
    print()

    # No section flag means all of them; any flag means only what was asked for.
    picked = args.temp or args.rain or args.uploads
    sections = []
    if args.temp or not picked:
        sections.append(lambda: print_thermometers(cfg))
    if args.rain or not picked:
        sections.append(lambda: print_rain(cfg, cfg_path))
    if args.uploads or not picked:
        sections.append(lambda: print_uploads(cfg, cfg_path))

    for i, section in enumerate(sections):
        if i:
            print()
            print("-" * 72)
            print()
        section()


if __name__ == "__main__":
    main()
