"""Tipping-bucket rain gauge: one GPIO pulse per bucket tip."""

from __future__ import annotations

import threading


class RainGauge:
    # The bucket's reed switch bounces like the anemometer's. Tips are slow
    # (seconds apart at worst), so a generous window costs nothing here.
    BOUNCE_S = 0.05

    def __init__(self, pin: int) -> None:
        from gpiozero import Button

        self._count = 0
        self._lock = threading.Lock()
        self._btn = Button(pin, bounce_time=self.BOUNCE_S)
        self._btn.when_pressed = self._tip

    def _tip(self) -> None:
        with self._lock:
            self._count += 1

    def read_and_reset(self) -> int:
        with self._lock:
            c, self._count = self._count, 0
        return c
