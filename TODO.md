# TODO — delivering plan.MD

Task list to finish what [plan.MD](plan.MD) proposes. Hardware/sensor work is done
and verified (see [docs/sensors.md](docs/sensors.md)); this tracks what's left.
Numbered items match the corresponding step in plan.MD's "Details" sections where
one exists.

## Done

- [x] Repo scaffold, package structure (`pi/`, `web/`, `docs/`)
- [x] Sensor bring-up & verification on real hardware — BMP085, HTU21D, MCP342X
      wind vane, anemometer, rain gauge all confirmed working (2026-08-27)
- [x] SQLite-first local buffer with per-uploader cursors (`store/local_buffer.py`)
- [x] Uploader code for Supabase, Weather Underground, Windy v2 — written, unit
      tested, but **never run against live services** (no keys yet)
- [x] `docs/supabase-schema.sql` written (not yet run against a real project)
- [x] systemd unit file scaffolded (`pi/systemd/weatherstation.service`) — **needs
      a fix before use**: hardcodes `User=pi` and `/home/pi/...` paths, but the
      real Pi's user is `ddools` and the repo lives at `/home/ddools/mipi-weather-station`

## 1. Supabase live (plan.MD Details/B)

- [ ] Create a Supabase project; grab project URL + service-role key + anon key
- [ ] Run `docs/supabase-schema.sql` in the Supabase SQL editor (creates `readings`
      table + RLS policy for anonymous read-only `SELECT`)
- [ ] Copy `pi/.env.example` → `pi/.env` on the Pi, fill in `SUPABASE_URL` /
      `SUPABASE_SERVICE_KEY`
- [ ] Confirm `uploaders.supabase.enabled: true` in `config.yaml` (default is already on)
- [ ] Run `weatherstation` for real (not `WS_MOCK_SENSORS=1`) on the Pi and confirm
      rows land in Supabase
- [ ] Verify RLS: anonymous `SELECT` works from a plain REST call; an anon-key
      `INSERT` is rejected
- [ ] Store-and-forward soak test: unplug the Pi's network for a while, reconnect,
      confirm the backlog replays with **no gaps** (target: 24h continuous)
- [ ] Fix `pi/systemd/weatherstation.service` (`User=ddools`,
      `WorkingDirectory=/home/ddools/mipi-weather-station/pi`, matching `ExecStart`
      path), then `sudo cp` it in, `systemctl enable --now`, confirm it survives a reboot

## 2. Astro standalone site with shadcn/ui (plan.MD Details/C — now lives in this repo's `web/`)

**Changed 2026-08-27:** standalone domain (TBD, not registered yet) instead of a
`/weather` page on dermotdooley.com; `web/` is now the real deployable project.

- [ ] Pick and register the domain (currently undecided — blocks the Vercel custom
      domain step and any hardcoded URLs)
- [ ] Scaffold Astro in `web/` (`npm create astro@latest .`); `npx astro add vercel`
      + `npx astro add react` (shadcn/ui components are React, mounted as islands)
- [ ] `npx shadcn init` in `web/`, then add components as needed (`card`, `tabs`,
      `button`, dark-mode `ThemeProvider`, etc.)
- [ ] Create `web/` as its own Vercel project (separate from any existing site
      projects), connected to this repo with a `web/` root directory
- [ ] Live-conditions panel as a server island (`server:defer`) reading the latest
      Supabase row, with a static fallback skeleton, styled with shadcn `Card`
- [ ] `/api/current` route + client-side refresh timer (30–60s) for live updates
      without a full reload
- [ ] `/api/history` route (`export const prerender = false`) returning JSON for
      24h/7d/30d ranges, with hourly downsampling for the longer ranges
- [ ] ECharts line charts: temp, pressure, humidity, rain
- [ ] ECharts wind rose (polar bar) + gauge dials for current temp/wind
- [ ] Range switcher using shadcn `Tabs` (24h/7d/30d)
- [ ] Responsive CSS grid dashboard (multi-column desktop → single-column mobile),
      hero current-temp card, dark mode via shadcn's theme pattern
- [ ] Vercel env vars: `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` (anon key
      only — never the service key — in the front end)
- [ ] Once domain is registered: add as custom domain on the Vercel project, point DNS
- [ ] Benchmark: live value updates within 60s of a new reading; mobile Lighthouse ≥ 90

## 3. Weather Underground upload (plan.MD Details/D)

- [ ] Register a free PWS at wunderground.com → My Devices → Add a New PWS; note
      Station ID + Station Key
- [ ] Add `WU_STATION_KEY` to `.env`, station ID to `config.yaml`
      (`uploaders.wunderground.station_id`), set `enabled: true`
- [ ] `upload/wunderground.py` is already written (imperial unit conversion,
      `updateweatherstation.php` GET) — just needs a real key to verify against
- [ ] Confirm the response body contains `success`; station shows live data on
      wunderground.com

## 4. Windy Stations API v2 upload (plan.MD Details/D)

- [ ] Register a station at stations.windy.com for an API key
- [ ] Add `WINDY_API_KEY` to `.env`, station ID to `config.yaml`
      (`uploaders.windy.station_id`), set `enabled: true`
- [ ] `upload/windy.py` is already written (v2 API, pressure sent in Pa) — verify
      against the live endpoint
- [ ] Confirm data appears on the station's Windy dashboard

## 5. Polish (plan.MD Recommendations #5, Details/E)

- [ ] CWOP (APRS) uploader — **not started**, no `upload/cwop.py` exists yet.
      Needs: CWOP registration (NOAA CWOP signup for a `CW`/`DW` ID), an APRS
      packet formatter (mph/°F/inHg-hundredths/rain-hundredths), and a socket send
      to `cwop.aprs.net:14580` every ~5 min. WeeWX has this built in; this project
      needs a from-scratch client.
- [ ] GitHub Actions CI: `ruff` + `pytest` on push/PR (none exists yet)
- [ ] Retention/downsampling job in Supabase — keep 1-minute data ~90 days, hourly
      averages beyond that, to stay inside the 500MB free tier
- [ ] README screenshots of the live dashboard once it exists
- [ ] Optional/backlog — chips physically present on the kit but out of scope so
      far (see docs/sensors.md "Not implemented"):
  - [ ] TGS2600 air quality sensor (MCP342X @ `0x6A`, channel 0)
  - [ ] DS18B20 ground-temperature probe (1-Wire)

## Housekeeping

- [ ] Keep `docs/sensors.md`, `plan.MD`, and `claude.md` in sync as things change —
      they now cross-reference each other and will drift if only one is updated
- [ ] `pi/config.yaml` and `pi/.env` must never be committed — enforced by the
      repo-root `.gitignore` (added 2026-08-27; didn't exist before that)
