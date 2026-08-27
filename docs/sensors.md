# Sensor hardware reference — Oracle Raspberry Pi Weather Station kit

This is the verified hardware reference for the physical kit this project targets:
the official 2016 Raspberry Pi Foundation / Oracle "Weather Station" HAT (the one
sent to ~1000 schools), built from the
[assembly guide](https://projects.raspberrypi.org/en/projects/oracle-raspberrypi-weather-station).
It is **not** the generic BYOWS (Build-Your-Own-Weather-Station) hardware profile —
that kit uses a BME280 and an MCP3008 SPI ADC, which are different chips from what's
actually on this board. Early drafts of this project's plan assumed BYOWS-style
hardware; this doc corrects that, verified against real hardware on 2026-08-27 and
against the [official kit driver source](https://github.com/RaspberryPiFoundation/weather-station).

## Chip map (I2C bus 1)

| Address | Chip | Measures | Driver in this repo |
|---|---|---|---|
| `0x77` | **BMP085/BMP180** (chip ID `0x55`) | temperature, pressure | `sensors/bmp085.py` |
| `0x40` | **HTU21D** | humidity (+ its own temp, used only for compensation) | `sensors/humidity.py` |
| `0x69` | **MCP342X** ADC, "main HAT board" | wind vane (channel 0) | `sensors/mcp342x.py` + `sensors/wind_vane.py` |
| `0x6A` | **MCP342X** ADC, "air quality snap-off board" | TGS2600 air quality sensor (channel 0) | not implemented — see below |
| `0x68` | unidentified | — | likely an onboard RTC (common on education HATs); not used by this project |

`temp_c`/`humidity_pct`/`pressure_hpa` are combined into one reading by
`sensors/air.py:AirSensor`, which the rest of the collector treats as a single
"air" sensor (mirroring the old, incorrect single-BME280 assumption at the
interface level, even though it's two physical chips).

Confirm any of this on your own unit with `i2cdetect -y 1` and, for the two Bosch-family
addresses, a direct chip-ID register read: `i2cget -y 1 0x77 0xd0` should return `0x55`
for BMP085/180 (a BME280 would read `0x60`, a BMP280 `0x58`).

## BMP085/BMP180 (pressure + temperature)

- I2C address `0x77` (fixed; unlike a BME280 there's no `0x76`/`0x77` SDO-pin choice).
- No CircuitPython driver exists for this discontinued chip, so `bmp085.py` talks to
  it directly over `smbus2` and implements the Bosch datasheet compensation formula,
  ported line-for-line from the official kit's `bmpBackend.py`.
- Standard resolution mode (mode `1`): ~8ms pressure conversion, no oversampling.

## HTU21D (humidity)

- I2C address `0x40`, fixed.
- Read protocol is plain I2C (write a command byte, wait, read 3 bytes) — **not**
  a standard SMBus block read, which always re-sends a register byte before reading
  and would restart the measurement mid-conversion. Use `smbus2.i2c_msg` for the
  write and read as two separate raw I2C transactions, not `read_i2c_block_data`.
- Each reading includes a CRC-8 check (polynomial `0x0131`); `read_humidity_pct()`
  returns `None` on a bad checksum rather than a silently wrong value.
- The humidity formula includes a temperature-coefficient correction using the
  chip's *own* temperature reading — it does not need or use the BMP085's temperature.

## MCP342X (I2C ADC, used for the wind vane)

- **Not** an MCP3008 (that's SPI; this kit's ADC is I2C). Two instances exist on the
  bus at different fixed addresses: `0x69` (wind vane, on the main board) and `0x6A`
  (air quality, on the detachable board).
- 15-bit resolution (`max = 32767`, `vref = 2.048V`), ~300ms conversion time.
- Same raw-I2C caveat as the HTU21D: read the 3-byte result via `i2c_msg`, not
  `read_i2c_block_data`, or the write-cmd-then-read sequence restarts the conversion.

## Wind vane

- 16-position reed switch vane wired as a **fixed resistor-divider network built
  into the kit board** — the resistor-to-direction mapping is a manufacturing
  constant, not something that needs per-unit measurement (unlike a generic vane).
- Circuit: `Vin = 3.268V`, divider resistor `75kΩ`, each of the 16 directions pulls
  in a specific resistor (33kΩ for N, 6.57kΩ for NNE, ... — full table in
  `config.example.yaml` under `calibration.wind_vane.directions`, copied from the
  official kit's `wind_direction.json`).
- `wind_vane.py` computes each direction's expected ADC value from the divider
  equation at startup, sorts them, and assigns each an ADC range (midpoint between
  neighbours) — same algorithm as the official driver's `wind_direction.py`.
- Verified on real hardware: reading tracks physical rotation across the full
  16-point compass correctly.

## Anemometer

- Reed switch on **GPIO 5** (BCM), 2 pulses per rotation, cup radius **9.0 cm**.
- Calibration factor is **2.36**, not 1.18 (an earlier plan draft copied the wrong
  constant from a different kit's documentation). The factor is a dimensionless
  multiplier converting swept-cup speed to true wind speed, so it applies the same
  way regardless of what unit you compute the base speed in — no formula change
  needed beyond fixing the constant. Verified against the official driver's
  `interrupt_daemon.py`.
- Verified on real hardware: pulses register while spinning the cups by hand.

## Rain gauge

- Reed switch (tipping bucket) on **GPIO 6** (BCM), **0.2794 mm per tip** — this
  value was already correct.
- Verified on real hardware: pulses register on tipping the bucket by hand.

## Not implemented (available but out of scope)

- **TGS2600 air quality sensor** at `0x6A` (MCP342X channel 0) — physically present
  on the kit's detachable board but this project doesn't read or upload it.
- **DS18B20 ground-temperature probe** (1-Wire) — part of the original kit's sensor
  set per the official repo (`ds18b20_therm.py`) but not wired/tested here.
- Chip at `0x68` — unidentified, presumed RTC, unused.

## Provisioning gotchas hit during bring-up

- Raspberry Pi OS trixie (Debian 13) ships `python3-lgpio` as a system package, but
  `pip install gpiozero`'s transitive `lgpio` dependency still tries to **compile**
  its own copy — needs `sudo apt install swig build-essential python3-dev
  liblgpio-dev` first, or the wheel build fails with `cannot find -llgpio`.
- I2C (`/dev/i2c-1`, header pins) and SPI are both disabled by default on a fresh
  image — `sudo raspi-config nonint do_i2c 0` / `do_spi 0` then reboot. The
  always-present `/dev/i2c-2` is the HDMI DDC bus, not the sensor bus.
