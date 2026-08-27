# CLAUDE.md — Project handoff & context

Read this first. It's the source of truth for continuing work on this repo.

## What this project is

Open-source software for the **Oracle Raspberry Pi Weather Station** kit, built by
Dermot and his son in Dublin, Ireland. Two deliverables:

1. **Pi collector** (`pi/`) — Python service reading the kit's sensors, buffering
   locally, pushing to cloud + weather services.
2. **Public dashboard** — a **standalone site on its own domain** (name TBD, not
   yet registered — was originally planned as dermotdooley.com/weather, changed
   2026-08-27). Built in **Astro** with **shadcn/ui** (React/Tailwind/Radix
   components mounted as Astro React islands), hosted on **Vercel** as its own
   project. The Astro app lives fully in **this repo's `web/`** — it's the real
   deployable project now, not integration notes for another repo.

Repo: https://github.com/ddools/mipi-weather-station (public, MIT).

## Architecture (agreed & implemented)

```
sensors → core/sampler → store (SQLite, source of truth) → upload/* (per-dest cursors)
                                                             ├→ Supabase (Postgres) → Astro site
                                                             ├→ Weather Underground
                                                             └→ Windy (Stations API v2)
```

Key decisions already made — do not re-litigate without asking:
- **Custom Python** over WeeWX (learning + ownership; WeeWX kept as reference).
- **SQLite-first store-and-forward**: every archive record hits local SQLite before
  any upload; each uploader has its own `last_sent_id` cursor in `upload_state` and
  replays backlog, stopping at first failure. One dead destination never blocks another.
- **Supabase** free tier: `readings` table, RLS on, anonymous SELECT only; Pi inserts
  with service-role key. Schema in `docs/supabase-schema.sql`.
- **Astro**: static shell + server island (`server:defer`) live panel + SSR API routes
  (`/api/current`, `/api/history`, `prerender = false`) + **ECharts** client island for
  charts (lines, rain bars, wind rose, gauges). `@astrojs/vercel` adapter.
- **UI**: **shadcn/ui** (changed 2026-08-27) — React components (Tailwind + Radix)
  vendored into `web/src/components/ui/` via the shadcn CLI, mounted as Astro React
  islands (`@astrojs/react`). Not shadcn's native pairing (that's Next.js), but
  works fine as islands in an otherwise-static Astro site.
- **Weather services**: WU first (free, imperial units, GET updateweatherstation.php),
  then Windy **v2 API only** (legacy dies end of 2026; pressure in **Pascals**), then
  CWOP (APRS to cwop.aprs.net:14580 — not yet implemented).
  **Do NOT target Met Office/Met Éireann WOW** — decommissioning late 2026.
  (WOW-BE reboot at wow.meteo.be is the fallback if WOW-style sharing is wanted.)
- **Units**: SI internally everywhere; convert at the uploader edge (`core/units.py`).

## Hardware facts (Oracle kit)

Full reference with wiring, chip IDs, and provisioning gotchas: **[docs/sensors.md](docs/sensors.md)**.
Verified against real hardware on 2026-08-27 and against the official kit's
open-source driver ([RaspberryPiFoundation/weather-station](https://github.com/RaspberryPiFoundation/weather-station)).

This is the real Oracle/Foundation HAT, **not** generic BYOWS hardware — an early
plan draft assumed BME280 + MCP3008 (SPI), which are the wrong chips. Corrected:

- **BMP085/BMP180** on I2C addr `0x77` (fixed) — temp/pressure. No humidity output;
  see below. `sensors/bmp085.py`.
- **HTU21D** on I2C addr `0x40` — humidity, separate chip. `sensors/humidity.py`.
  `sensors/air.py:AirSensor` combines both into one `(temp, humidity, pressure)`
  reading so the rest of the collector still sees a single "air" sensor.
- Anemometer: reed switch, GPIO 5, **2 pulses/rotation, radius 9.0 cm,
  adjustment factor 2.36** (was wrongly documented as 1.18).
- Rain gauge: tipping bucket, GPIO 6, **0.2794 mm/tip** (this was already correct).
- Wind vane: 16 reed positions via **MCP342X I2C ADC** (addr `0x69`, channel 0) —
  **not** SPI/MCP3008. The 16 resistor values are a fixed factory network on the
  board, not per-unit — `calibration.wind_vane` in config.example.yaml ships with
  the real values and works out of the box, no per-unit calibration step needed.

## Current state (verified working)

- `pip install -e ".[dev]"` clean; **5/5 pytest pass** (`pi/tests/`).
- Full pipeline smoke-tested with `WS_MOCK_SENSORS=1 weatherstation` — mock sensors
  produce records through sampler → SQLite.
- **All four sensors verified on real hardware** (2026-08-27, over SSH to the Pi):
  BMP085 and HTU21D return plausible live readings; wind vane tracks physical
  rotation across the full 16-point compass; anemometer and rain gauge both
  register GPIO pulses when triggered by hand. See [docs/sensors.md](docs/sensors.md).
- **Supabase live** (2026-08-27): project created, schema applied, real sensor
  data confirmed flowing end-to-end (sensors → SQLite → Supabase). RLS verified
  via direct REST calls (publishable key can SELECT, can't INSERT). Collector
  runs as a systemd service on the Pi (`ddools` user), enabled on boot.
  Store-and-forward soak test (24h, network-unplug) not yet done — needs elapsed
  real time, not blocked on anything.
- WU and Windy uploaders written but **never run against live services** (no
  keys yet — Supabase now has keys, WU/Windy don't).
- No CI yet. No CWOP uploader. No Astro components written yet. TGS2600 air
  quality and DS18B20 ground-temp sensors are present on the kit but not
  implemented (see docs/sensors.md "Not implemented").

## Dev conventions

- Python ≥3.9, Ruff (format + lint), line length 100.
- Everything must run with `WS_MOCK_SENSORS=1` (no hardware deps at import time —
  hardware libs import lazily inside driver `__init__`).
- Secrets in `.env` only (`.env.example` documents keys); station/config in
  `config.yaml` (copy from `config.example.yaml`). Both gitignored.
- Run locally: `cd pi && python3 -m venv .venv && source .venv/bin/activate &&
  pip install -e ".[dev]" && cp config.example.yaml config.yaml &&
  WS_MOCK_SENSORS=1 weatherstation`
- Tests: `cd pi && pytest`
- New uploaders: subclass `upload/base.py:Uploader`, implement `send(record)->bool`
  (must be retry-safe), register in `upload/__init__.py:build_uploaders`.

## Roadmap / next steps (in order)

1. ~~**Sensor bring-up on the real Pi**~~ — done 2026-08-27, all four sensors
   verified on real hardware. See [docs/sensors.md](docs/sensors.md) for what
   changed (real chips are BMP085/HTU21D/MCP342X, not BME280/MCP3008 as first
   planned) and the provisioning steps (I2C/SPI enable, `swig`/`liblgpio-dev` for
   gpiozero's `lgpio` backend on trixie).
2. ~~**Supabase live**~~ — done 2026-08-27: project created, schema applied, keys
   in `.env`, real data flowing, RLS verified, systemd service enabled and running.
   Remaining: the 24h network-unplug soak test (needs elapsed time, not blocked).
3. **Astro site in `web/`** — standalone site, own Vercel project, domain TBD:
   scaffold Astro + `@astrojs/vercel` + `@astrojs/react`; `npx shadcn init` +
   add components; server-island live panel; `/api/history` with hourly
   downsampling for 7d/30d; ECharts charts; responsive CSS grid, dark mode; env
   vars `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` in Vercel. Details in
   `web/README.md`. Target: mobile Lighthouse ≥ 90.
4. **Weather Underground** — register PWS at wunderground.com → My Devices, put
   station ID in config + key in `.env`, enable, confirm `success` responses.
5. **Windy v2** — register at stations.windy.com, same pattern.
6. **Polish** — wind rose + gauges, retention/downsampling job in Supabase,
   GitHub Actions CI (ruff + pytest), CWOP uploader, README screenshots.

## Gotchas

- Supabase's **direct connection** DB host (`db.<ref>.supabase.co`) is IPv6-only;
  if `psql` fails with "could not translate host name" it's almost always missing
  IPv6 route, not bad credentials. Use the **session pooler** host instead
  (`aws-<n>-<region>.pooler.supabase.com:5432`, user `postgres.<ref>`) — it's
  IPv4-compatible and free. The paid "dedicated IPv4" add-on ($4/mo) is only for
  the direct/dedicated-pooler endpoints, not needed for this project.
- Supabase now issues `sb_publishable_...`/`sb_secret_...` API keys instead of
  the old anon/service_role JWTs. Same roles (publishable = client-safe + RLS,
  secret = full server-side access) — `.env`'s `SUPABASE_SERVICE_KEY` holds the
  secret key; the eventual Astro site's `PUBLIC_SUPABASE_ANON_KEY` will hold the
  publishable key.
- Real hardware is the official Oracle/Foundation HAT (BMP085 + HTU21D + MCP342X),
  not generic BYOWS parts (BME280 + MCP3008/SPI) — see docs/sensors.md before
  touching any sensor driver.
- WU wants **imperial** (°F, inHg, mph, inches) and UTC `dateutc`; response body must
  contain "success".
- Windy upload pressure is **Pa**, not hPa.
- Supabase free projects pause after 7 days idle — a live station never idles, but a
  long holiday pause can suspend the project (restorable, ~30 s wake).
- Supabase uploader treats HTTP 409 (duplicate on retry) as success — there's a
  unique index on `recorded_at` to make retries idempotent.
- `pyproject.toml` readme must stay `pi/README.md` (setuptools can't reference
  `../README.md`).