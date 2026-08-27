"""Wind vane via MCP342X I2C ADC (addr 0x69, channel 0) reading a resistor-divider
network — the actual Oracle kit hardware, not an MCP3008-over-SPI vane.

The 16 reed positions map to fixed resistor values baked into the kit's board,
so (unlike a generic vane) the ADC ranges are derived once from Ohm's law
rather than requiring per-unit measurement.
"""
from __future__ import annotations

from .mcp342x import MCP342X

_COMPASS_ORDER = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]


class WindVane:
    def __init__(self, calibration: dict, address: int = 0x69, channel: int = 0) -> None:
        self._adc = MCP342X(address)
        self._channel = channel
        self._ranges = self._build_ranges(calibration)

    def _build_ranges(self, calibration: dict) -> list[tuple[float, float, float]]:
        vin = calibration["vin"]
        vdivider = calibration["vdivider_ohms"]
        directions = calibration["directions"]

        entries = []
        for name in _COMPASS_ORDER:
            ohms = directions[name]
            angle = _COMPASS_ORDER.index(name) * 22.5
            vout = (ohms / (vdivider + ohms)) * vin
            adc = round(MCP342X.MAX * (vout / MCP342X.VREF))
            entries.append([angle, adc])
        entries.sort(key=lambda e: e[1])

        ranges = []
        for i, (angle, adc) in enumerate(entries):
            lo = 1 if i == 0 else adc - (adc - entries[i - 1][1]) / 2 + 1
            hi = MCP342X.MAX - 1 if i == len(entries) - 1 else adc + (entries[i + 1][1] - adc) / 2
            ranges.append((lo, hi, angle))
        return ranges

    def read_deg(self) -> float | None:
        value = self._adc.read(self._channel)
        if value is None:
            return None
        for lo, hi, angle in self._ranges:
            if lo <= value <= hi:
                return angle
        return None
