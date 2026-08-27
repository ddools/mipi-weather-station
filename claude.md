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
- **DS18B20** 1-Wire probe — the kit's "ground" probe, but repurposed as the
  **air-temperature source** because the BMP085/HTU21D bake ~10 °C when the board
  is near the Pi (see Gotchas). `sensors/ds18b20.py`, read via `/sys/bus/w1`.
  `calibration.air_temp_source: auto|ds18b20|onboard` (default `auto`). When the
  probe is in use, `AirSensor` also corrects the HTU21D's RH to the real air temp
  (dewpoint held constant — `units.rh_from_dewpoint`).
- Anemometer: reed switch, GPIO 5, **2 pulses/rotation, radius 9.0 cm,
  adjustment factor 2.36** (was wrongly documented as 1.18).
- Rain gauge: tipping bucket, GPIO 6, **0.2794 mm/tip** (this was already correct).
- Wind vane: 16 reed positions via **MCP342X I2C ADC** (addr `0x69`, channel 0) —
  **not** SPI/MCP3008. The 16 resistor values are a fixed factory network on the
  board, not per-unit — `calibration.wind_vane` in config.example.yaml ships with
  the real values and works out of the box, no per-unit calibration step needed.

## Current state (verified working)

- `pip install -e ".[dev]"` clean; **8/8 pytest pass** (`pi/tests/`).
- Full pipeline smoke-tested with `WS_MOCK_SENSORS=1 weatherstation` — mock sensors
  produce records through sampler → SQLite.
- **All four sensors verified on real hardware** (2026-08-27, over SSH to the Pi):
  BMP085 and HTU21D return plausible live readings; wind vane tracks physical
  rotation across the full 16-point compass; anemometer and rain gauge both
  register GPIO pulses when triggered by hand. See [docs/sensors.md](docs/sensors.md).
- **BMP085/HTU21D self-heating confirmed** (2026-08-27): both onboard chips read
  ~27.5 °C against a true ~17 °C; DS18B20 (`28-000006e2639a`) on its lead reads
  18.9 °C. Collector now defaults to the DS18B20 for air temp. Still to do:
  deploy the change to the Pi and mount the air board away from the Pi body.
- **Supabase live** (2026-08-27): project created, schema applied, real sensor
  data confirmed flowing end-to-end (sensors → SQLite → Supabase). RLS verified
  via direct REST calls (publishable key can SELECT, can't INSERT). Collector
  runs as a systemd service on the Pi (`ddools` user), enabled on boot.
  Store-and-forward soak test (24h, network-unplug) not yet done — needs elapsed
  real time, not blocked on anything.
- **Weather Underground live** (2026-08-27): station "DDools Pi Station"
  (Holmpatrick), ID `IHOLMP2`. Real data confirmed landing via WU's history
  table. Hit and resolved a gotcha: a freshly-created device returned a bare
  `unauthorized` even with correct credentials until Edit→Save on the device
  in WU's dashboard; after that, uploads succeed immediately. The live
  "current conditions" tile still shows "Offline" — believed to be normal
  new-station dashboard lag, not a real failure (see TODO.md).
- **Windy live** (2026-08-27), station `C9fexco`. `upload/windy.py` was
  substantially wrong (POST/JSON to a made-up endpoint) and got rewritten
  against Windy's real API reference — real endpoint is
  `GET /api/v2/observation/update`, auth is the **station password**
  (`WINDY_STATION_PASSWORD`, not an "API key" — that's a different, account-
  level concept in Windy's API). Windy also rate-limits to once per 5 min per
  station, handled client-side in the uploader. See TODO.md for the full story.
- **Astro site live in `web/`** (2026-08-27) — full dashboard with server
  islands, ECharts, shadcn/ui, Meteocons, tides. Not yet deployed to Vercel.
- **CI live** (2026-08-27) — `.github/workflows/ci.yml`: `pi` job (ruff check +
  ruff format check + pytest on Py 3.9 & 3.13) and `web` job (`npm ci` + `astro
  build`). Runs on push-to-`main` and every PR.
- No CWOP uploader. TGS2600 air quality sensor is present on the kit but not
  implemented (see docs/sensors.md "Not implemented"). The DS18B20 1-Wire probe
  **is** now used — as the air-temperature source (see Gotchas), not as a
  separate ground-temp field.

## Dev conventions

- Python ≥3.9, Ruff (format + lint), line length 100. Ruff is **pinned exact**
  (`ruff==0.16.4` in the `dev` extra) and lint rules are listed explicitly in
  `pyproject.toml` (`[tool.ruff.lint] select`) — newer ruff drifts both the
  formatter and the default rule set, which breaks CI reproducibility. Bump
  deliberately, run `ruff format`, commit the churn.
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
3. ~~**Astro site in `web/`**~~ — done 2026-08-27: server-island live panel,
   `/api/history` (24h raw, 7d/30d hourly-bucketed), ECharts charts + wind rose,
   shadcn/ui, Meteocons icons, Tides section, dark mode. Not yet deployed —
   still needs a domain (undecided) and a Vercel project wired to `web/`.
   Details in `web/README.md` and TODO.md.
4. ~~**Weather Underground**~~ — done 2026-08-27: station live, `success`
   responses confirmed, real data visible in WU's history table.
5. ~~**Windy v2**~~ — done 2026-08-27, see above.
6. **Polish** — ~~GitHub Actions CI~~ (done 2026-08-27), gauge dials,
   retention/downsampling job in Supabase (SQL written in
   `docs/supabase-retention.sql`, not yet applied), CWOP uploader,
   README screenshots.

## Gotchas

- **Windy's API reference is a JS-rendered SPA** — plain `curl`/WebFetch on
  `stations.windy.com/api-reference` returns an empty shell; need a headless
  browser (or similar) to actually read the endpoint docs. Key facts once
  rendered: upload is `GET /api/v2/observation/update` (WU-protocol-compatible
  query params), NOT `POST /api/v2/observations` with JSON (an earlier,
  unverified guess). Auth is the **station password** (My Stations page), a
  distinct concept from the account-level "API key" (for `/api/v2/pws`
  management) — don't confuse the two. Uploads are rate-limited to once per
  5 minutes per station; our 60s archive interval means the uploader must
  self-throttle client-side or it'll just collect 429s.
- A **freshly-created WU device** may return a bare `unauthorized` on upload
  even with correct ID/key copied straight from the dashboard. Fix: Edit →
  Save the device in WU's member dashboard (re-triggers provisioning), then
  retry — no code or credential change needed. The dashboard's live "current
  conditions" tile can also keep showing "Offline" for a while after uploads
  are genuinely succeeding; check the **history table**
  (`/dashboard/pws/<ID>/table/<date>/<date>/daily`) to verify real data
  landing, don't trust the tile alone.
- `upload/base.py`'s `flush()` only logs on an **exception** — a normal `False`
  return from `send()` (e.g. the destination rejects the request without
  erroring) fails silently, no log line at all. Worth knowing when a service
  looks "fine" in `journalctl` but data isn't actually arriving somewhere;
  verify against the destination directly rather than trusting silence.
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
- **BMP085/HTU21D self-heat ~10 °C** when the air board sits near the Pi — measured
  2026-08-27: both onboard chips ~27.5 °C against a true 17 °C, while a DS18B20 on a
  lead in the same spot read 18.9 °C. Two independent chips agreeing rules out a
  driver/calibration bug — it's thermal. Fix is the DS18B20 as the temp source
  (`air_temp_source`, done) and/or physically mounting the board away from the Pi.
  Pressure is fine (BMP085 self-compensates); raw HTU21D RH reads low and is
  corrected in `AirSensor` when the probe is active.
- WU wants **imperial** (°F, inHg, mph, inches) and UTC `dateutc`; response body must
  contain "success".
- Windy upload pressure is **Pa**, not hPa.
- Supabase free projects pause after 7 days idle — a live station never idles, but a
  long holiday pause can suspend the project (restorable, ~30 s wake).
- Supabase uploader treats HTTP 409 (duplicate on retry) as success — there's a
  unique index on `recorded_at` to make retries idempotent.
- `pyproject.toml` readme must stay `pi/README.md` (setuptools can't reference
  `../README.md`).