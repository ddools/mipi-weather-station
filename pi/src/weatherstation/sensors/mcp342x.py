"""MCP342X I2C ADC — the Oracle kit's actual wind-vane/air-quality ADC.

The kit uses this I2C ADC (addr 0x69 on the main board, 0x6A on the air-quality
snap-off board), not an MCP3008 over SPI. Ported from the official Raspberry
Pi Foundation driver (MCP342X.py).
"""

from __future__ import annotations

import time

_CMD_ZERO = 0x00
_CMD_RESET = 0x06
_CMD_READ_CH0_16BIT = 0x88
_CMD_READ_CH1_16BIT = 0xA8


class MCP342X:
    MAX = 32767.0  # 15-bit resolution
    VREF = 2.048

    def __init__(self, address: int) -> None:
        import smbus2

        self._bus = smbus2.SMBus(1)
        self._addr = address
        self._bus.write_byte(self._addr, _CMD_ZERO)
        self._bus.write_byte(self._addr, _CMD_RESET)
        time.sleep(0.001)

    def read(self, channel: int = 0) -> int | None:
        from smbus2 import i2c_msg

        cmd = _CMD_READ_CH1_16BIT if channel == 1 else _CMD_READ_CH0_16BIT
        self._bus.write_byte(self._addr, _CMD_ZERO)
        self._bus.write_byte(self._addr, cmd)
        time.sleep(0.3)  # conversion time at 15-bit resolution
        # Plain 3-byte I2C read (no SMBus register byte — matches the chip's protocol)
        read = i2c_msg.read(self._addr, 3)
        self._bus.i2c_rdwr(read)
        data = list(read)
        if data[2] & 0x80:  # ready bit not clear
            return None
        return (data[0] << 8) | data[1]
