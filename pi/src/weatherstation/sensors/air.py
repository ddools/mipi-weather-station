"""Combines the two physically separate Oracle-kit air chips into one reading.

The kit's "air" board is BMP085 (temp/pressure, 0x77) + HTU21D (humidity, 0x40) —
not a single BME280 — but the rest of the collector wants one (temp, humidity,
pressure) triple, so this wrapper presents that.
"""
from __future__ import annotations

from .bmp085 import BMP085Sensor
from .humidity import HTU21DSensor


class AirSensor:
    def __init__(self) -> None:
        self._bmp = BMP085Sensor()
        self._htu = HTU21DSensor()

    def read(self) -> tuple[float, float, float]:
        """Return (temp_c, humidity_pct, pressure_hpa)."""
        temp_c, pressure_hpa = self._bmp.read()
        humidity_pct = self._htu.read_humidity_pct()
        return temp_c, humidity_pct, pressure_hpa
