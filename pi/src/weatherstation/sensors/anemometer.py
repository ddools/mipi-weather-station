"""Anemometer: reed switch on a GPIO pin; 2 pulses per rotation on the Oracle kit."""

from __future__ import annotations

import math
import threading


class Anemometer:
    PULSES_PER_ROTATION = 2
    # Reed switches chatter on close; undebounced, one pass of the cup magnet can
    # register as several pulses and inflate the speed. 3 ms still admits 333
    # pulses/s -- around 220 m/s of wind, far above anything the sampler's
    # plausibility ceiling accepts, so this cannot clip a real reading.
    BOUNCE_S = 0.003

    def __init__(self, pin: int) -> None:
        from gpiozero import Button

        self._count = 0
        self._lock = threading.Lock()
        self._btn = Button(pin, bounce_time=self.BOUNCE_S)
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
