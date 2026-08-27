"""Sensor factory. Real drivers on the Pi; mocks when WS_MOCK_SENSORS=1."""
from __future__ import annotations

from ..config import Config, mock_sensors


def build_sensors(cfg: Config):
    if mock_sensors():
        from .mock import MockAirSensor, MockPulse, MockVane

        return MockAirSensor(), MockPulse(), MockPulse(), MockVane()

    from .air import AirSensor
    from .anemometer import Anemometer
    from .rain import RainGauge
    from .wind_vane import WindVane

    return (
        AirSensor(),
        Anemometer(cfg.pins.anemometer),
        RainGauge(cfg.pins.rain_gauge),
        WindVane(cfg.calibration.wind_vane),
    )
