"""Deterministic-ish mock sensors so the collector runs anywhere."""
from __future__ import annotations

import random


class MockAirSensor:
    def read(self):
        return (
            12.0 + random.uniform(-1, 1),      # Dublin-ish temp
            80.0 + random.uniform(-5, 5),
            1013.0 + random.uniform(-3, 3),
        )


class MockPulse:
    def read_and_reset(self) -> int:
        return random.randint(0, 10)

    @staticmethod
    def speed_ms(pulses, seconds, radius_cm, adjustment):
        from .anemometer import Anemometer

        return Anemometer.speed_ms(pulses, seconds, radius_cm, adjustment)


class MockVane:
    def read_deg(self):
        return random.choice([0, 45, 90, 135, 180, 225, 270, 315])
