"""BMP085/BMP180 temperature + pressure over I2C (addr 0x77).

This is the actual chip on the Oracle kit's air sensor board (chip ID 0x55) —
not a BME280. Compensation algorithm ported from the official Raspberry Pi
Foundation driver (RaspberryPiFoundation/weather-station bmpBackend.py), which
implements the Bosch BMP085 datasheet formula.
"""
from __future__ import annotations

import time

_CONTROL = 0xF4
_TEMPDATA = 0xF6
_PRESSUREDATA = 0xF6
_READTEMPCMD = 0x2E
_READPRESSURECMD = 0x34
_MODE = 1  # standard: 8ms pressure conversion, no oversampling


class BMP085Sensor:
    def __init__(self, address: int = 0x77) -> None:
        import smbus2

        self._bus = smbus2.SMBus(1)
        self._addr = address
        self._read_calibration()

    def _read_s16(self, reg: int) -> int:
        v = self._read_u16(reg)
        return v - 65536 if v >= 32768 else v

    def _read_u16(self, reg: int) -> int:
        hi = self._bus.read_byte_data(self._addr, reg)
        lo = self._bus.read_byte_data(self._addr, reg + 1)
        return (hi << 8) + lo

    def _read_calibration(self) -> None:
        self._ac1 = self._read_s16(0xAA)
        self._ac2 = self._read_s16(0xAC)
        self._ac3 = self._read_s16(0xAE)
        self._ac4 = self._read_u16(0xB0)
        self._ac5 = self._read_u16(0xB2)
        self._ac6 = self._read_u16(0xB4)
        self._b1 = self._read_s16(0xB6)
        self._b2 = self._read_s16(0xB8)
        self._mb = self._read_s16(0xBA)
        self._mc = self._read_s16(0xBC)
        self._md = self._read_s16(0xBE)

    def _raw_temp(self) -> int:
        self._bus.write_byte_data(self._addr, _CONTROL, _READTEMPCMD)
        time.sleep(0.005)
        return self._read_u16(_TEMPDATA)

    def _raw_pressure(self) -> int:
        self._bus.write_byte_data(self._addr, _CONTROL, _READPRESSURECMD + (_MODE << 6))
        time.sleep(0.008)
        msb = self._bus.read_byte_data(self._addr, _PRESSUREDATA)
        lsb = self._bus.read_byte_data(self._addr, _PRESSUREDATA + 1)
        xlsb = self._bus.read_byte_data(self._addr, _PRESSUREDATA + 2)
        return ((msb << 16) + (lsb << 8) + xlsb) >> (8 - _MODE)

    def read(self) -> tuple[float, float]:
        """Return (temp_c, pressure_hpa)."""
        ut = self._raw_temp()
        up = self._raw_pressure()

        x1 = ((ut - self._ac6) * self._ac5) >> 15
        x2 = (self._mc << 11) // (x1 + self._md)
        b5 = x1 + x2
        temp_c = ((b5 + 8) >> 4) / 10.0

        b6 = b5 - 4000
        x1 = (self._b2 * (b6 * b6 >> 12)) >> 11
        x2 = (self._ac2 * b6) >> 11
        x3 = x1 + x2
        b3 = (((self._ac1 * 4 + x3) << _MODE) + 2) // 4
        x1 = (self._ac3 * b6) >> 13
        x2 = (self._b1 * (b6 * b6 >> 12)) >> 16
        x3 = ((x1 + x2) + 2) >> 2
        b4 = (self._ac4 * (x3 + 32768)) >> 15
        b7 = (up - b3) * (50000 >> _MODE)
        p = (b7 * 2) // b4 if b7 < 0x80000000 else (b7 // b4) * 2
        x1 = (p >> 8) * (p >> 8)
        x1 = (x1 * 3038) >> 16
        x2 = (-7375 * p) >> 16
        p = p + ((x1 + x2 + 3791) >> 4)

        return temp_c, p / 100.0
