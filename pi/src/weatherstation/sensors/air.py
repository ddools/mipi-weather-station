"""Combines the Oracle-kit air chips into one (temp, humidity, pressure) reading.

The "air" board is BMP085 (temp/pressure, 0x77) + HTU21D (humidity, 0x40) — not
a single BME280 — but the rest of the collector wants one triple, so this
wrapper presents that.

Both onboard thermometers self-heat ~10 C when the board sits near the Pi, so
when a DS18B20 probe is present we take air temperature from it instead and
correct the HTU21D's relative humidity to the real air temperature (dewpoint is
conserved as air exchanges through the screen). `air_temp_source` in config:

    auto     - use the DS18B20 if the 1-Wire bus has one, else onboard (default)
    ds18b20  - require the DS18B20; fail at startup if it's absent
    onboard  - always use the BMP085 temperature

Falling back to the onboard chip is never silent: it is the difference between
reporting real air temperature and reporting the inside of the enclosure, so
every fallback is logged as a warning naming the consequence. In `auto` mode the
probe is re-checked periodically rather than latched at startup — see
`_REDETECT_INTERVAL_S`.
"""

from __future__ import annotations

import logging
import time

from ..core import units
from .bmp085 import BMP085Sensor
from .humidity import HTU21DSensor

log = logging.getLogger(__name__)

_SOURCES = ("auto", "ds18b20", "onboard")

_SELF_HEATING_NOTE = (
    "the onboard chip sits next to the Pi and self-heats (+11 C measured on this "
    "hardware), so air temperature will read several degrees too warm"
)

# How often `auto` re-checks the 1-Wire bus for a probe that was not there at
# startup. The w1 bus takes a few seconds to enumerate after boot and the
# collector wins that race under systemd often enough to matter; a one-shot
# check at construction would then latch the station onto the self-heated
# onboard chip until somebody noticed and restarted the service.
_REDETECT_INTERVAL_S = 60.0

# A probe that is present but returns a bad CRC on one cycle is normal; warning
# once per archive interval about it would be noise, so rate-limit it.
_FALLBACK_WARN_INTERVAL_S = 900.0


class AirSensor:
    def __init__(self, temp_source: str = "auto", *, bmp=None, htu=None) -> None:
        if temp_source not in _SOURCES:
            raise ValueError(f"air_temp_source must be one of {_SOURCES}, got {temp_source!r}")
        self._source = temp_source
        self._bmp = bmp if bmp is not None else BMP085Sensor()
        self._htu = htu if htu is not None else HTU21DSensor()
        self._probe = self._build_probe(temp_source)
        self._next_redetect = time.monotonic() + _REDETECT_INTERVAL_S
        self._next_fallback_warn = 0.0
        self._log_selected_source()

    @staticmethod
    def _build_probe(temp_source: str):
        if temp_source == "onboard":
            return None
        from .ds18b20 import DS18B20Sensor, available

        if temp_source == "ds18b20":
            return DS18B20Sensor()  # raises if absent — that's the point
        return DS18B20Sensor() if available() else None  # auto

    @property
    def temp_source(self) -> str:
        """Which thermometer air temperature is currently coming from."""
        return "ds18b20" if self._probe is not None else "onboard"

    def _log_selected_source(self) -> None:
        if self._probe is not None:
            log.info(
                "air temperature source: DS18B20 probe at %s (air_temp_source=%s)",
                self._probe.device_path,
                self._source,
            )
        elif self._source == "onboard":
            log.warning(
                "air temperature source: onboard BMP085, forced by air_temp_source=onboard — %s",
                _SELF_HEATING_NOTE,
            )
        else:
            log.warning(
                "air temperature source: onboard BMP085 — no DS18B20 found on the 1-Wire bus, "
                "and %s. Enable 1-Wire (`sudo raspi-config nonint do_onewire 0`, then reboot) "
                "or check the probe's wiring; the bus is re-checked every %.0fs and the "
                "collector switches over on its own once a probe appears.",
                _SELF_HEATING_NOTE,
                _REDETECT_INTERVAL_S,
            )

    def _redetect_probe(self) -> None:
        """`auto` only: pick up a probe that appeared after startup."""
        if self._source != "auto":
            return
        now = time.monotonic()
        if now < self._next_redetect:
            return
        self._next_redetect = now + _REDETECT_INTERVAL_S
        from .ds18b20 import DS18B20Sensor, available

        if not available():
            return
        self._probe = DS18B20Sensor()
        log.warning(
            "DS18B20 probe appeared at %s — air temperature now comes from the probe "
            "instead of the self-heated onboard chip; expect a step down in the series",
            self._probe.device_path,
        )

    def _warn_onboard_fallback(self, reason: str) -> None:
        now = time.monotonic()
        if now < self._next_fallback_warn:
            return
        self._next_fallback_warn = now + _FALLBACK_WARN_INTERVAL_S
        log.warning(
            "%s — falling back to the onboard BMP085 temperature, and %s",
            reason,
            _SELF_HEATING_NOTE,
        )

    def _probe_temp_c(self) -> float | None:
        if self._probe is None:
            self._redetect_probe()
        if self._probe is None:
            return None
        temp_c = self._probe.read_c()
        if temp_c is None:
            self._warn_onboard_fallback("DS18B20 read failed (bad CRC or bus error)")
        return temp_c

    def read(self) -> tuple[float | None, float | None, float | None]:
        """Return (temp_c, humidity_pct, pressure_hpa)."""
        onboard_temp, pressure_hpa = self._bmp.read()
        chip_temp, rh = self._htu.read_temp_rh()

        probe_temp = self._probe_temp_c()
        if probe_temp is None:
            # no probe, or a bad read this cycle — onboard temp, RH as measured
            return onboard_temp, rh, pressure_hpa

        if rh is not None and chip_temp is not None:
            # The HTU21D measured this RH at its own (self-heated) temperature;
            # re-express it at the true air temperature, holding dewpoint fixed.
            dewpoint = units.dewpoint_c(chip_temp, rh)
            rh = round(units.rh_from_dewpoint(probe_temp, dewpoint), 1)
        return probe_temp, rh, pressure_hpa
