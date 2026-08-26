# CLAUDE.md — Project handoff & context

Read this first. It's the source of truth for continuing work on this repo.

## What this project is

Open-source software for the **Oracle Raspberry Pi Weather Station** kit, built by
Dermot and his son in Dublin, Ireland. Two deliverables:

1. **Pi collector** (`pi/`) — Python service reading the kit's sensors, buffering
   locally, pushing to cloud + weather services.
2. **Public dashboard** at **dermotdooley.com/weather** — built in **Astro**, hosted
   on **Vercel**, in the user's existing site repo (NOT this repo; `web/` here holds
   reusable pieces + integration notes only).

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
- **Weather services**: WU first (free, imperial units, GET updateweatherstation.php),
  then Windy **v2 API only** (legacy dies end of 2026; pressure in **Pascals**), then
  CWOP (APRS to cwop.aprs.net:14580 — not yet implemented).
  **Do NOT target Met Office/Met Éireann WOW** — decommissioning late 2026.
  (WOW-BE reboot at wow.meteo.be is the fallback if WOW-style sharing is wanted.)
- **Units**: SI internally everywhere; convert at the uploader edge (`core/units.py`).

## Hardware facts (Oracle kit)

- BME280 on I2C, addr 0x76 (fallback 0x77) — temp/humidity/pressure
- Anemometer: reed switch, GPIO pulse, **2 pulses/rotation, radius 9.0 cm,
  adjustment factor 1.18**
- Rain gauge: tipping bucket, **0.2794 mm/tip**
- Wind vane: 16 reed positions via **MCP3008 ADC** (SPI) + voltage divider —
  ADC→degrees table is per-unit; `calibration.vane_table` in config.yaml is a
  placeholder and needs real measured values.

## Current state (verified working)

- `pip install -e ".[dev]"` clean; **5/5 pytest pass** (`pi/tests/`).
- Full pipeline smoke-tested with `WS_MOCK_SENSORS=1 weatherstation` — mock sensors
  produce records through sampler → SQLite. Hardware drivers written but **untested
  on real hardware**.
- Uploaders written but **never run against live services** (no keys yet).
- No CI yet. No CWOP uploader. No Astro components written yet.

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

1. **Sensor bring-up on the real Pi** — `i2cdetect -y 1` for BME280; verify pulse
   counts; add `--calibrate-vane` CLI mode that prints raw ADC values while rotating
   the vane, to fill `vane_table`.
2. **Supabase live** — create project, run `docs/supabase-schema.sql`, add keys to
   `.env`, verify inserts + backlog replay (unplug-network test: 24h no gaps).
3. **Astro /weather page** — in the dermotdooley.com repo: `npx astro add vercel`;
   server-island live panel; `/api/history` with hourly downsampling for 7d/30d;
   ECharts charts; responsive CSS grid, dark mode; env vars `PUBLIC_SUPABASE_URL`,
   `PUBLIC_SUPABASE_ANON_KEY` in Vercel. Details in `web/README.md`.
   Target: mobile Lighthouse ≥ 90.
4. **Weather Underground** — register PWS at wunderground.com → My Devices, put
   station ID in config + key in `.env`, enable, confirm `success` responses.
5. **Windy v2** — register at stations.windy.com, same pattern.
6. **Polish** — wind rose + gauges, retention/downsampling job in Supabase,
   GitHub Actions CI (ruff + pytest), CWOP uploader, README screenshots.

## Gotchas

- WU wants **imperial** (°F, inHg, mph, inches) and UTC `dateutc`; response body must
  contain "success".
- Windy upload pressure is **Pa**, not hPa.
- Supabase free projects pause after 7 days idle — a live station never idles, but a
  long holiday pause can suspend the project (restorable, ~30 s wake).
- Supabase uploader treats HTTP 409 (duplicate on retry) as success — there's a
  unique index on `recorded_at` to make retries idempotent.
- `pyproject.toml` readme must stay `pi/README.md` (setuptools can't reference
  `../README.md`).