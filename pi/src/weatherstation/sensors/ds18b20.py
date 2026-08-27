"""DS18B20 1-Wire temperature probe, read through the Linux w1 kernel driver.

Nominally the Oracle kit's soil/ground probe, but it's the only thermometer on
the kit that hangs on a lead instead of sitting on the Pi's board — the BMP085
and HTU21D on the air board self-heat ~10 C whenever the Pi is close. Mounted in
clean air, this probe reads real air temperature.

No I2C and no extra library: the values appear under /sys/bus/w1 once 1-Wire is
enabled (`sudo raspi-config nonint do_onewire 0`, or `dtoverlay=w1-gpio` in
config.txt — GPIO 4, which is how the kit is wired).
"""

from __future__ import annotations

import glob

_DEVICE_GLOB = "/sys/bus/w1/devices/28-*/w1_slave"
# 85000 is the sensor's power-on default; a genuine 85 C reading is impossible
# in this application, so treat it (and anything outside the DS18B20's range) as
# a failed conversion.
_RESET_SENTINEL = 85000
_MIN_MILLI = -55000
_MAX_MILLI = 125000


def find_device() -> str | None:
    matches = sorted(glob.glob(_DEVICE_GLOB))
    return matches[0] if matches else None


def available() -> bool:
    return find_device() is not None


class DS18B20Sensor:
    def __init__(self, device_path: str | None = None) -> None:
        self._path = device_path or find_device()
        if self._path is None:
            raise RuntimeError(
                "no DS18B20 found under /sys/bus/w1/devices/28-* — 1-Wire is "
                "disabled or the probe isn't connected"
            )

    def read_c(self) -> float | None:
        """Temperature in C, or None on a bad read (caller retries next cycle)."""
        try:
            with open(self._path) as f:
                lines = f.read().splitlines()
        except OSError:
            return None
        if len(lines) < 2 or not lines[0].rstrip().endswith("YES"):
            return None  # CRC check failed
        _, sep, raw = lines[1].partition("t=")
        if not sep or not raw.lstrip("-").isdigit():
            return None
        milli = int(raw)
        if milli == _RESET_SENTINEL or not (_MIN_MILLI < milli < _MAX_MILLI):
            return None
        return milli / 1000.0
