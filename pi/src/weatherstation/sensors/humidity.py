"""HTU21D humidity over I2C (addr 0x40) — the Oracle kit's separate humidity chip.

Ported from the official Raspberry Pi Foundation driver (HTU21D.py), including
the CRC8 check on each reading (I2C glitches otherwise read as silently wrong
humidity values).
"""
from __future__ import annotations

import time

_ADDR = 0x40
_READ_TEMP_NOHOLD = 0xF3
_READ_HUM_NOHOLD = 0xF5
_SOFT_RESET = 0xFE


def _crc8_ok(buf: list[int]) -> bool:
    remainder = ((buf[0] << 8) + buf[1]) << 8 | buf[2]
    divisor = 0x988000
    for i in range(16):
        if remainder & (1 << (23 - i)):
            remainder ^= divisor
        divisor >>= 1
    return remainder == 0


class HTU21DSensor:
    def __init__(self) -> None:
        import smbus2

        self._bus = smbus2.SMBus(1)
        self._bus.write_byte(_ADDR, _SOFT_RESET)
        time.sleep(0.1)

    def _read(self, cmd: int) -> int | None:
        from smbus2 import i2c_msg

        self._bus.i2c_rdwr(i2c_msg.write(_ADDR, [cmd]))
        time.sleep(0.1)
        read = i2c_msg.read(_ADDR, 3)
        self._bus.i2c_rdwr(read)
        buf = list(read)
        if not _crc8_ok(buf):
            return None
        return (buf[0] << 8 | buf[1]) & 0xFFFC

    def read_temp_c(self) -> float | None:
        raw = self._read(_READ_TEMP_NOHOLD)
        if raw is None:
            return None
        return -46.85 + 175.72 * (raw / 65536.0)

    def read_humidity_pct(self) -> float | None:
        temp_c = self.read_temp_c()
        raw = self._read(_READ_HUM_NOHOLD)
        if raw is None or temp_c is None:
            return None
        rh = -6.0 + 125.0 * (raw / 65536.0)
        rh += (25 - temp_c) * -0.15  # temperature coefficient compensation
        return max(0.0, min(100.0, rh))
