# mipi-weatherstation (Pi collector)

Python collector for the Oracle Raspberry Pi Weather Station kit.
See the [main README](../README.md) for the full project.

## Diagnostics

```
.venv/bin/weatherstation-doctor
```

Reads all three of the kit's thermometers side by side (DS18B20 probe, BMP085,
HTU21D), shows which one the collector is publishing as air temperature, and
explains the difference. Run it first if the station reads warmer or cooler than
the forecast — see [troubleshooting](../docs/sensors.md#troubleshooting-the-station-reads-several-degrees-too-warm).
