"""Sensor factory. Real drivers on the Pi; mocks when WS_MOCK_SENSORS=1."""
from __future__ import annotations

from ..config import Config, mock_sensors


def build_sensors(cfg: Config):
    if mock_sensors():
        from .mock import MockBME280, MockPulse, MockVane

        return MockBME280(), MockPulse(), MockPulse(), MockVane()

    from .anemometer import Anemometer
    from .bme280 import BME280Sensor
    from .rain import RainGauge
    from .wind_vane import WindVane

    return (
        BME280Sensor(),
        Anemometer(cfg.pins.anemometer),
        RainGauge(cfg.pins.rain_gauge),
        WindVane(cfg.pins.wind_vane_adc_channel, cfg.calibration.vane_table),
    )
