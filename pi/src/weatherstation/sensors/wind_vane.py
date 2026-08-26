"""Wind vane via MCP3008 ADC: map noisy voltage to nearest of 16 known positions."""
from __future__ import annotations


class WindVane:
    def __init__(self, channel: int, table: dict) -> None:
        from gpiozero import MCP3008

        self._adc = MCP3008(channel=channel)
        # {adc_value(0-1): degrees}
        self._table = {float(k): float(v) for k, v in table.items()}

    def read_deg(self) -> float | None:
        v = self._adc.value
        if not self._table:
            return None
        nearest = min(self._table, key=lambda k: abs(k - v))
        return self._table[nearest]
