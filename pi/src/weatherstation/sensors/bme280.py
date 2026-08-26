"""BME280 temperature / humidity / pressure over I2C (0x76 or 0x77)."""
from __future__ import annotations


class BME280Sensor:
    def __init__(self) -> None:
        import board
        import busio
        from adafruit_bme280 import basic as adafruit_bme280

        i2c = busio.I2C(board.SCL, board.SDA)
        try:
            self._dev = adafruit_bme280.Adafruit_BME280_I2C(i2c, address=0x76)
        except ValueError:
            self._dev = adafruit_bme280.Adafruit_BME280_I2C(i2c, address=0x77)

    def read(self) -> tuple[float, float, float]:
        """Return (temp_c, humidity_pct, pressure_hpa)."""
        return self._dev.temperature, self._dev.humidity, self._dev.pressure
