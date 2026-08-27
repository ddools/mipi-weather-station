"""Sensor factory. Real drivers on the Pi; mocks when WS_MOCK_SENSORS=1.

Returns ``(air, anemometer, rain, vane, air_quality)``. ``air_quality`` is
``None`` unless the optional TGS2600 on the snap-off board is enabled in config
(``sensors.air_quality.enabled``) — the collector runs fine without it.
"""

from __future__ import annotations

from ..config import Config, mock_sensors


def build_sensors(cfg: Config):
    if mock_sensors():
        from .mock import MockAirQualitySensor, MockAirSensor, MockPulse, MockVane

        return MockAirSensor(), MockPulse(), MockPulse(), MockVane(), MockAirQualitySensor()

    from .air import AirSensor
    from .anemometer import Anemometer
    from .rain import RainGauge
    from .wind_vane import WindVane

    aq_cfg = (cfg.get("sensors") or {}).get("air_quality") or {}
    air_quality = None
    if aq_cfg.get("enabled"):
        from .air_quality import AirQualitySensor

        air_quality = AirQualitySensor(warmup_s=aq_cfg.get("warmup_s", 300))

    return (
        AirSensor(cfg.calibration.get("air_temp_source", "auto")),
        Anemometer(cfg.pins.anemometer),
        RainGauge(cfg.pins.rain_gauge),
        WindVane(cfg.calibration.wind_vane),
        air_quality,
    )
