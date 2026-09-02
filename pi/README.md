# mipi-weatherstation (Pi collector)

Python collector for the Oracle Raspberry Pi Weather Station kit.
See the [main README](../README.md) for the full project.

## Diagnostics

```
.venv/bin/weatherstation-doctor
```

Checks the two sensors that most often go quietly wrong, and explains what it
finds:

- **Thermometers** — all three side by side (DS18B20 probe, BMP085, HTU21D),
  marking which one is being published as air temperature.
  ([troubleshooting](../docs/sensors.md#troubleshooting-the-station-reads-several-degrees-too-warm))
- **Rain gauge** — tips per hour for the last 24h from the collector's buffer,
  so a bucket that has stopped tipping is visible rather than looking like dry
  weather.
  ([troubleshooting](../docs/sensors.md#troubleshooting-rain-totals-look-far-too-low))

```
weatherstation-doctor --temp          # thermometer section only
weatherstation-doctor --rain          # rain section only
weatherstation-doctor --rain-watch    # live tip counter; needs the collector stopped
```

`config.yaml` is found relative to the installation, so the command works from
any directory.
