"""TGS2600 air-quality sensor on the Oracle kit's snap-off board.

Figaro TGS2600: a tin-dioxide (SnO2) semiconductor sensor whose resistance drops
in the presence of reducing gases — hydrogen, carbon monoxide, methane, ethanol,
and general "air contaminants" (cooking, solvents, smoke). It lives on the
detachable "air quality" daughterboard and is read through the *second* MCP342X
ADC at I2C ``0x6A``, channel 0 (the wind vane is the identical chip at ``0x69``).

This is **not** a calibrated pollutant monitor: no PM2.5/PM10, no ppm figure, no
correspondence to any AQI scale. The value here is the Raspberry Pi Foundation
kit's own relative index — ``100 * (max - adc) / max``, i.e. how far the divider
voltage is pulled below full scale, as a percentage. Higher = more reducing gas.
It only means something compared against this one station's own baseline over
time. Ported from the Foundation driver's ``tgs2600.py``.

The sensor's heater needs time to reach a stable temperature after power-on, so
readings are suppressed for ``warmup_s`` after construction (the datasheet wants a
long burn-in for absolute accuracy; a few minutes is plenty for a relative trend).
"""

from __future__ import annotations

import time

from .mcp342x import MCP342X


class AirQualitySensor:
    def __init__(
        self,
        address: int = 0x6A,
        channel: int = 0,
        warmup_s: float = 300.0,
        adc: object | None = None,
    ) -> None:
        self._adc = adc if adc is not None else MCP342X(address)
        self._channel = channel
        self._ready_at = time.monotonic() + warmup_s

    def read_index(self) -> float | None:
        """Foundation-scale contaminants index (0-100), or None if not ready.

        None means the heater is still warming up, or the ADC returned a
        not-ready sample this cycle — the caller retries next cycle.
        """
        if time.monotonic() < self._ready_at:
            return None
        raw = self._adc.read(self._channel)
        if raw is None:
            return None
        return (100.0 / MCP342X.MAX) * (MCP342X.MAX - raw)
