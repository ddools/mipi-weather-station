# TODO — delivering plan.MD

Task list to finish what [plan.MD](plan.MD) proposes. Hardware/sensor work is done
and verified (see [docs/sensors.md](docs/sensors.md)); this tracks what's left.
Numbered items match the corresponding step in plan.MD's "Details" sections where
one exists.

## Still open

Everything in plan.MD's core path (sensors, store-and-forward, Supabase, the Astro
site on Vercel, Weather Underground, Windy) is live as of 2026-08-27. Remaining:

- **Soak test** — data-integrity check **passed** 2026-08-28 (§1): local SQLite and
  Supabase both hold 1032 contiguous readings with full parity, all uploader cursors
  current, no gaps since the last stable restart. Still outstanding: a deliberate
  network-partition (unplug) test, and a genuine 24h *uninterrupted* run — yesterday's
  clean-run clock restarted at 2026-08-27 21:46 BST after a deploy-session restart storm.
- **Benchmarks** — live value updates within 60s of a new reading; mobile Lighthouse ≥ 90 (§2).
- **CWOP uploader** — not started; needs a from-scratch APRS client (§5).
- **Supabase retention job** — SQL written (`docs/supabase-retention.sql`), not yet
  run against the live project; repoint the 7d/30d queries at `readings_hourly` after (§5).
- **README screenshots** of the live dashboard (§5).
- **TGS2600 air quality** — collector + dashboard support built (2026-08-27, §5);
  **enabled and flowing** as of 2026-08-28 (`sensors.air_quality.enabled: true` on
  the Pi, `air_quality` values landing in Supabase — schema column is live). Still
  needs the **retention SQL** run, the daughterboard physically mounted, and a
  warm-up/calibration sanity check on the trend.

## Done

- [x] Repo scaffold, package structure (`pi/`, `web/`, `docs/`)
- [x] Sensor bring-up & verification on real hardware — BMP085, HTU21D, MCP342X
      wind vane, anemometer, rain gauge all confirmed working (2026-08-27)
- [x] SQLite-first local buffer with per-uploader cursors (`store/local_buffer.py`)
- [x] Uploader code for Supabase, Weather Underground, Windy v2 — written, unit
      tested, and confirmed live against all three services (2026-08-27; see §§1, 3, 4)
- [x] `docs/supabase-schema.sql` run against the real project (2026-08-27) —
      `readings` table, indexes, and RLS public-read policy all confirmed live
- [x] systemd service deployed and running on the Pi as `ddools` (2026-08-27) —
      `enabled`, survives the current boot; template in the repo still says `User=pi`
      as a documented default for other users, with a comment explaining to adjust it

## 1. Supabase live (plan.MD Details/B)

- [x] Create a Supabase project; grab project URL + keys — done 2026-08-27.
      Note: Supabase now issues `sb_publishable_...`/`sb_secret_...` keys instead
      of the old anon/service_role JWTs — functionally the same roles (publishable
      = client-safe/RLS-respecting, secret = full-access server-side), just new
      naming. `SUPABASE_SERVICE_KEY` in `.env` holds the secret key.
- [x] Run `docs/supabase-schema.sql` — done via `psql` against the **session
      pooler** (`aws-1-eu-west-1.pooler.supabase.com:5432`), not the direct
      connection host — that host is IPv6-only and this network has no IPv6
      route. The pooler is free or the direct/dedicated IPv4 add-on is $4/mo —
      use the pooler, no need to pay for the add-on.
- [x] `pi/.env` written on the Pi with `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`,
      permissions locked to `600`
- [x] `uploaders.supabase.enabled: true` confirmed in `config.yaml`
- [x] Ran `weatherstation` for real (not mock) on the Pi — one archive record
      (28.4°C / 37.8% / 1006.53 hPa / vane 180°) flowed sensors → SQLite →
      Supabase and was confirmed present via direct query
- [x] Verified RLS via the REST API directly: publishable-key `SELECT` returns
      data (200), publishable-key `INSERT` is rejected (401)
- [x] systemd service installed, enabled, and running as `ddools` — confirmed
      `active (running)`, `enabled` (starts on boot)
- [x] Store-and-forward data-integrity check — **passed 2026-08-28 09:30 BST**.
      Local SQLite: 1032 readings, IDs 1–1032 contiguous, zero missing. Supabase:
      exactly 1032 rows, latest row identical to local latest — full parity. All
      three uploader cursors (`supabase`/`wunderground`/`windy`) at 1032, no
      backlog. Notably the pipeline lost **no** data across yesterday evening's
      30+ restarts (a `config.yaml`-missing crash loop, one `readonly database`
      crash, the air-quality deploy) — every id is present locally and upstream.
- [ ] Store-and-forward soak test — the *remaining* pieces: a deliberate
      network-unplug test (never done), and a genuine 24h uninterrupted run.
      The service has only been continuously up since 2026-08-27 21:46 BST (the
      earlier "since 11:01 BST" note was wrong — it was restarted repeatedly
      during the evening deploy session). No gaps >150s since that restart;
      nominal archive interval measures ~66s.

## 2. Astro standalone site with shadcn/ui (plan.MD Details/C — now lives in this repo's `web/`)

**Changed 2026-08-27:** standalone site instead of a `/weather` page on
dermotdooley.com; `web/` is now the real deployable project. Live on Vercel
project `mipi-weather`, served at `weather.dermotdooley.com` for now (a dedicated
domain may come later).

- [x] Scaffold Astro in `web/` (2026-08-27) — `npm create astro@latest`, minimal
      template, `@astrojs/vercel` adapter, `@astrojs/react` for islands, Tailwind v4
      via `@tailwindcss/vite`. Note: create-astro dropped a nested `web/AGENTS.md` +
      `web/CLAUDE.md` symlink with Astro-specific dev workflow notes — kept, it's
      genuinely useful and doesn't conflict with the root `claude.md`.
- [x] `npx shadcn init` (template `astro`, base `radix`, preset `nova`) — needed a
      `@/*` path alias added to `tsconfig.json` first (shadcn's init won't proceed
      without one). Added components: `card`, `tabs`, `badge`, `separator`,
      `skeleton`, `button`.
- [x] Live-conditions panel as a server island (`server:defer`) in
      `src/components/CurrentConditions.astro` — queries Supabase directly
      server-side, static `Skeleton` fallback, verified end-to-end (curled the
      generated `/_server-islands/CurrentConditions` endpoint directly and got
      real live data back)
- [x] `/api/current` route + a 45s client-side refresh (in `CurrentConditions.astro`'s
      inline script) that patches the DOM in place, plus a 15s "Xm ago" ticker
- [x] `/api/history` route — 24h returns raw rows; 7d/30d bucket into hourly
      averages **in the API route itself** (fetches all raw rows in range, then
      averages in JS) rather than via a Postgres view/RPC. Fine at today's volume;
      revisit with server-side aggregation once the table has real history —
      pulling 43k raw rows for a 30d query will get slow eventually.
- [x] ECharts: temp/humidity/pressure line chart, rain bar chart, wind rose (polar
      bar, averaged by 16-point compass bucket) — all in `HistoryCharts.tsx`
      (client island). **Gauge dials for current temp/wind are not built** —
      only the three charts above exist so far.
- [x] Range switcher via shadcn `Tabs` (24h/7d/30d) — note: all three ranges fetch
      on mount (Radix keeps inactive `TabsContent` mounted), not just the active
      one. Fine at today's volume, worth lazy-loading later.
- [x] Responsive grid dashboard + dark mode — verified visually via headless
      browser screenshot (light + dark), both render correctly; dark mode toggle
      in the header, vanilla JS + `localStorage`, no FOUC (inline blocking script
      in `<head>`)
- [x] Production build verified (`npm run build`) — succeeds; one pre-existing
      transitive `path-to-regexp` ReDoS advisory via `@astrojs/vercel` (low real
      risk, route patterns aren't user input; not force-fixed since that would
      downgrade the adapter)
- [x] Weather icons — [Meteocons](https://meteocons.com) (MIT), flat style per
      preference, **animated** (`@meteocons/svg`, not `-static` — swapped after
      feedback; the flat style's SMIL animations play fine via plain `<img>`,
      no inline-SVG/JS needed). `thermometer`/`humidity`/`pressure-high`+
      `pressure-low` (picked dynamically by value)/`wind`/`raindrop` inline with
      each card/chart header (`flex items-center gap-2` on `CardHeader` — note
      shadcn's `CardHeader` is `grid` by default, so `flex-row` alone does
      nothing without `flex` first; tailwind-merge resolves the conflict once
      `flex` is actually there).
- [x] Tides section — Balbriggan, Co. Dublin (nearest coastal town), via
      **Open-Meteo Marine API** (`marine-api.open-meteo.com`, free, no key,
      non-commercial). `src/lib/tides.ts` fetches hourly `sea_level_height_msl`
      and finds local min/max to derive next high/low + rising/falling trend.
      Explicit caveat shown in the UI: this is an ~8km-resolution ocean model,
      not an official harmonic tide-gauge prediction — fine for a hobby
      dashboard, not for anything where accuracy matters. Ireland's Marine
      Institute has official predictions but no clear public API found; a
      third-party option (TidesAtlas) exists but wasn't evaluated further once
      Open-Meteo's free/keyless option worked. Revisit if accuracy complaints.
- [x] Wind Direction tile — a dedicated card (separate from the Wind
      speed/gust card) showing the real needle-compass icon
      (`compass.svg`) with its `<g id="Pointer">` rotated to the exact
      `wind_dir_deg` via server-side string injection into the raw SVG (Vite
      `?raw` import), not one of 8 pre-rotated static icons — full precision,
      not snapped to 8 or even 16 points. The icon's own idle wobble
      animation is preserved by marking it `additive="sum"` so it combines
      with our static rotation instead of overwriting it every frame. Client
      refresh (45s) updates the `transform` attribute directly via
      `setAttribute` — brittle in the sense that it depends on meteocons'
      internal SVG markup staying the same shape, but degrades gracefully
      (falls back to the default unrotated-but-still-wobbling icon) if a
      future release changes it, rather than erroring.
- [x] Domain — **`weather.dermotdooley.com` for now** (2026-08-27), a subdomain of
      the existing personal domain; a dedicated domain may be bought later. `site:`
      in `astro.config.mjs` set to `https://weather.dermotdooley.com`.
- [x] Created `web/` as its own Vercel project **`mipi-weather`** (2026-08-27,
      `ddools-projects` team) — git-connected to `ddools/mipi-weather-station`,
      Root Directory `web`, framework Astro, production branch `main`. Deliberately
      **not** the auto-created `pi-weather-station` project (that one is wired as a
      Python/`pi` build for Supabase's integration and carries the Supabase secret
      key — kept separate so the frontend project never sees it). Vercel
      Authentication (SSO) was on by default on the new project; disabled it so the
      site is public.
- [x] Vercel env vars set (Production + Preview): `PUBLIC_SUPABASE_URL`,
      `PUBLIC_SUPABASE_ANON_KEY` — publishable key only, never the secret key.
- [x] First production deploy live (2026-08-27):
      `https://mipi-weather-ddools-projects.vercel.app` — `/api/current` confirmed
      returning live Supabase rows.
- [x] DNS at Porkbun: `weather` CNAME → `cname.vercel-dns.com` added 2026-08-27.
      Resolves via public resolvers, Vercel reports the domain configured, TLS
      cert issued — `https://weather.dermotdooley.com/api/current` returns live
      Supabase data. (Note: a local macOS resolver cache can lag; public DNS is
      fine.)
- [x] Dashboard UX enhancement pass (2026-08-27, branch
      `dashboard-ux-enhancements`) — see [product-enhancement.md](product-enhancement.md).
      Today's H/L on the temp card; wind in km/h + Beaufort with the compass
      merged into the Wind card (dropped the separate Wind Direction tile);
      pressure trend arrow; Rain card is "today / last hour / 24h"; SSR
      sparklines on the stat cards; `/api/summary` route + `getTodaySummary()`.
      History charts: split the triple-axis chart into three, added a wind
      speed/gust chart, wind rose is now frequency-by-speed-band, per-range
      x-axis formatting. Layout: station metadata line, footer, OG/description
      meta, tab-title shows current temp.
- [ ] Benchmark: live value updates within 60s of a new reading; mobile Lighthouse ≥ 90

## 3. Weather Underground upload (plan.MD Details/D)

- [x] Registered — station "DDools Pi Station" (Holmpatrick), ID `IHOLMP2`
- [x] `WU_STATION_KEY` in `.env`, `station_id: "IHOLMP2"` +
      `enabled: true` in `config.yaml` on the Pi; service restarted, confirmed
      startup log lists `uploaders=['supabase', 'wunderground']`
- [x] Confirmed `success` response and real data landing on WU (2026-08-27) —
      **gotcha hit along the way**: a freshly-created device initially returned
      a bare `unauthorized` (not the documented `INVALIDPASSWORDID|...`) even
      with correct ID/key copied straight from the dashboard. Fix was
      Edit → Save on the device in WU's dashboard (https://preview.wunderground.com/member/devices)
      — re-triggers provisioning. After that, `curl`ing the exact ID/key
      returned `success` immediately.
- [x] Verified real data arriving: the **history table**
      (`/dashboard/pws/IHOLMP2/table/<date>/<date>/daily`) shows the actual Pi's
      archived readings, matching our Supabase rows unit-converted (83.1°F/38%
      ≈ our 28.4°C/38%).
- [x] **Station online confirmed** (2026-08-28) — the new-station "Offline" tile
      lag from yesterday has cleared. `api.weather.com/v2/pws/observations/current`
      for `IHOLMP2` returns our latest observation in real time (obsTimeUtc
      matches the newest Supabase row; temp/humidity/wind/pressure all line up).

## 4. Windy Stations API v2 upload (plan.MD Details/D)

- [x] Registered — station ID `C9fexco`
- [x] **`upload/windy.py` was substantially wrong and got rewritten from
      scratch** (2026-08-27) after checking Windy's actual current API
      reference (a JS-rendered SPA — `curl` alone shows nothing; had to render
      it with the headless browser to get the real endpoint spec):
  - Endpoint was `POST /api/v2/observations` with a JSON body — real one is
    **`GET /api/v2/observation/update`** with query params (WU-protocol-
    compatible shape).
  - Auth field was named `WINDY_API_KEY`/`windy_key` — that's actually a
    *different* Windy concept (account-level, for managing stations via
    `/api/v2/pws`). Uploads authenticate with the **station password**
    (per-station, shown on the station's page in My Stations). Renamed
    throughout to `WINDY_STATION_PASSWORD`/`windy_station_password`.
  - **Windy rate-limits uploads to once per 5 minutes per station** — not
    documented anywhere we'd looked before, and much slower than our 60s
    archive interval. `WindyUploader` now tracks `_last_sent_at` in memory and
    returns success-without-a-request when called inside that window, instead
    of hammering the endpoint into repeated 429s.
- [x] Added HTTP-status+body logging on rejection to all three uploaders
      (Supabase/WU/Windy), not just Windy — `upload/base.py`'s generic
      "rejected" warning (added for the WU debugging session) said nothing
      about *why*; now each uploader logs the actual response.
- [x] Confirmed live: real archive records uploading successfully with no
      rejections once past the 5-minute window (verified via `journalctl`
      after deploy, plus a direct `curl` against the real endpoint with the
      real credentials before wiring it in — both returned clean `200`s).

## 5. Polish (plan.MD Recommendations #5, Details/E)

- [ ] CWOP (APRS) uploader — **not started**, no `upload/cwop.py` exists yet.
      Needs: CWOP registration (NOAA CWOP signup for a `CW`/`DW` ID), an APRS
      packet formatter (mph/°F/inHg-hundredths/rain-hundredths), and a socket send
      to `cwop.aprs.net:14580` every ~5 min. WeeWX has this built in; this project
      needs a from-scratch client.
- [x] GitHub Actions CI: `.github/workflows/ci.yml` (2026-08-27) — two jobs on
      push-to-`main` + every PR:
  - **pi**: `ruff check` + `ruff format --check` + `pytest` on Python 3.9 & 3.13.
    Ruff lint rules are now pinned explicitly in `pyproject.toml`
    (`select = ["E","F","W","I","UP","B","SIM","C4"]`) and `ruff` itself pinned
    to `==0.16.4` in the `dev` extra — newer ruff ships a broader default rule
    set and a drifting formatter, which would make CI non-reproducible. One-time
    `ruff format` reformat of 21 files came with this (mechanical: blank line
    after module docstrings, re-wrapping lines that now fit in 100).
  - **web**: `npm ci` + `astro build` on Node 22, with dummy `PUBLIC_SUPABASE_*`
    env (build never hits Supabase; the live data paths are all request-time).
  - Not yet: `astro check` (TS typecheck) — needs `@astrojs/check` + `typescript`
    added as web devDeps first.
- [~] Retention/downsampling job in Supabase — keep 1-minute data ~90 days, hourly
      averages beyond that, to stay inside the 500MB free tier. **SQL written**
      (`docs/supabase-retention.sql`, 2026-08-27): `readings_hourly` rollup table
      + `roll_up_readings_hourly()` / `purge_old_readings()` functions +
      `pg_cron` schedules (rollup at :05, purge daily 03:20 UTC). Wind direction
      is vector-averaged, rain summed. **Not yet run against the live project** —
      needs the Supabase SQL editor. Follow-up after it has data: repoint the
      site's 7d/30d queries at `readings_hourly` (see §2 note).
- [x] Rain-radar map on the dashboard (2026-08-27) — `web/src/components/RainRadar.tsx`,
      a Leaflet client island. Radar frames + tiles from the free, keyless
      **RainViewer** Weather Maps API (past 2 h + short nowcast, play/scrub
      controls); basemap is keyless **Esri Gray Canvas** (CARTO now requires an
      API key). Attribution to RainViewer + Esri rendered under/on the map.
      **rainbow.ai was evaluated and rejected** — enterprise/paid only, no
      self-serve tier. Backlog: Met Éireann's own open radar (HDF5 over FTP on
      request, data.gov.ie) would be the most authoritative Ireland source but
      needs a decode-and-tile pipeline.
- [x] DS18B20 1-Wire probe — implemented, but as the **air-temperature source**
      (`calibration.air_temp_source`, `sensors/ds18b20.py`), not as a separate
      ground-temp field. The onboard BMP085/HTU21D self-heat ~10 °C next to the
      Pi, so the probe on its lead is the real air thermometer. See
      [docs/sensors.md](docs/sensors.md) "DS18B20".
- [ ] README screenshots of the live dashboard once it exists
- [~] TGS2600 air quality sensor (MCP342X @ `0x6A`, channel 0) — **code done**
      (2026-08-27). `i2cdetect` confirms the ADC at `0x6a` is present and
      unclaimed. `sensors/air_quality.py` ports the Foundation kit's relative
      index (`100 × (max − adc) / max`, uncalibrated — higher = more reducing
      gas); `sensors.air_quality.{enabled,warmup_s}` in config (off by default,
      300 s heater warm-up gate); flows through sampler → `Record.air_quality` →
      SQLite → Supabase. `air_quality` column added to `docs/supabase-schema.sql`
      + `docs/supabase-retention.sql` (averaged in the hourly rollup). Dashboard:
      a conditional "Air quality" card on the live panel + a history line chart,
      both hidden until real data lands. **Remaining:** run the two updated SQL
      files on the live project; fit the snap-off board; set `enabled: true` on
      the Pi; let it warm up and sanity-check the trend. Not sent to WU/Windy —
      neither accepts a non-calibrated index.

## Housekeeping

- [ ] Keep `docs/sensors.md`, `plan.MD`, and `claude.md` in sync as things change —
      they now cross-reference each other and will drift if only one is updated
- [ ] `pi/config.yaml` and `pi/.env` must never be committed — enforced by the
      repo-root `.gitignore` (added 2026-08-27; didn't exist before that)
