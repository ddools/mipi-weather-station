"""`weatherstation-doctor` — read every thermometer on the kit side by side.

The station has three temperature sensors and only one of them is trustworthy
for air temperature. When the dashboard reads several degrees warmer than the
forecast or than a neighbouring station, the question is always which chip the
number came from, so this prints all three at once with the differences between
them, then says what the numbers mean.

Run it on the Pi, in the same virtualenv as the collector:

    .venv/bin/weatherstation-doctor
"""

from __future__ import annotations

import argparse
import os

_W1_ROOT = "/sys/bus/w1/devices"

# Below this spread the onboard chips are not meaningfully self-heating, so a
# reading that is still too warm is a siting problem rather than this one.
_SELF_HEATING_THRESHOLD_C = 3.0


def _configured_source() -> tuple[str, str]:
    """(air_temp_source, where it came from)."""
    try:
        from . import config

        cfg = config.load()
    except Exception as e:  # no config.yaml, unreadable, bad YAML
        return "auto", f"default (config not loaded: {type(e).__name__})"
    return cfg.calibration.get("air_temp_source", "auto"), "config.yaml"


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


def _verdict(
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.parse_args()

    source, source_from = _configured_source()
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

    print("mipi weather station — thermometer check")
    print()
    print(f"  air_temp_source : {source}  (from {source_from})")
    print(f"  1-Wire          : {w1_status}")
    if err:
        print(f"  I2C air board   : unreadable — {err}")
    print()
    print("  thermometer                       reading")
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
    print()
    print(f"  the collector would publish {_fmt(reported, 'C')} right now")
    print()
    for line in _verdict(source, probe_temp, bmp_temp, spread):
        print(f"  {line}".rstrip())


if __name__ == "__main__":
    main()
