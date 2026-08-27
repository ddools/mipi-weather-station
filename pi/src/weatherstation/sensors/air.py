"""Combines the Oracle-kit air chips into one (temp, humidity, pressure) reading.

The "air" board is BMP085 (temp/pressure, 0x77) + HTU21D (humidity, 0x40) — not
a single BME280 — but the rest of the collector wants one triple, so this
wrapper presents that.

Both onboard thermometers self-heat ~10 C when the board sits near the Pi, so
when a DS18B20 probe is present we take air temperature from it instead and
correct the HTU21D's relative humidity to the real air temperature (dewpoint is
conserved as air exchanges through the screen). `air_temp_source` in config:

    auto     - use the DS18B20 if the 1-Wire bus has one, else onboard (default)
    ds18b20  - require the DS18B20; fail at startup if it's absent
    onboard  - always use the BMP085 temperature
"""

from __future__ import annotations

from ..core import units
from .bmp085 import BMP085Sensor
from .humidity import HTU21DSensor

_SOURCES = ("auto", "ds18b20", "onboard")


class AirSensor:
    def __init__(self, temp_source: str = "auto") -> None:
        if temp_source not in _SOURCES:
            raise ValueError(f"air_temp_source must be one of {_SOURCES}, got {temp_source!r}")
        self._bmp = BMP085Sensor()
        self._htu = HTU21DSensor()
        self._probe = self._build_probe(temp_source)

    @staticmethod
    def _build_probe(temp_source: str):
        if temp_source == "onboard":
            return None
        from .ds18b20 import DS18B20Sensor, available

        if temp_source == "ds18b20":
            return DS18B20Sensor()  # raises if absent — that's the point
        return DS18B20Sensor() if available() else None  # auto

    def read(self) -> tuple[float | None, float | None, float | None]:
        """Return (temp_c, humidity_pct, pressure_hpa)."""
        onboard_temp, pressure_hpa = self._bmp.read()
        chip_temp, rh = self._htu.read_temp_rh()

        probe_temp = self._probe.read_c() if self._probe else None
        if probe_temp is None:
            # no probe, or a bad read this cycle — onboard temp, RH as measured
            return onboard_temp, rh, pressure_hpa

        if rh is not None and chip_temp is not None:
            # The HTU21D measured this RH at its own (self-heated) temperature;
            # re-express it at the true air temperature, holding dewpoint fixed.
            dewpoint = units.dewpoint_c(chip_temp, rh)
            rh = round(units.rh_from_dewpoint(probe_temp, dewpoint), 1)
        return probe_temp, rh, pressure_hpa
