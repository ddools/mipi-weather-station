"""Anemometer: reed switch on a GPIO pin; 2 pulses per rotation on the Oracle kit."""

from __future__ import annotations

import math
import threading


class Anemometer:
    PULSES_PER_ROTATION = 2

    def __init__(self, pin: int) -> None:
        from gpiozero import Button

        self._count = 0
        self._lock = threading.Lock()
        self._btn = Button(pin)
        self._btn.when_pressed = self._spin

    def _spin(self) -> None:
        with self._lock:
            self._count += 1

    def read_and_reset(self) -> int:
        """Return pulse count since last call."""
        with self._lock:
            c, self._count = self._count, 0
        return c

    @staticmethod
    def speed_ms(pulses: int, seconds: float, radius_cm: float, adjustment: float) -> float:
        rotations = pulses / Anemometer.PULSES_PER_ROTATION
        dist_cm = rotations * (2 * math.pi * radius_cm)
        return (dist_cm / 100.0) / seconds * adjustment if seconds > 0 else 0.0
