# TODO — delivering plan.MD

Task list to finish what [plan.MD](plan.MD) proposes. Hardware/sensor work is done
and verified (see [docs/sensors.md](docs/sensors.md)); this tracks what's left.
Numbered items match the corresponding step in plan.MD's "Details" sections where
one exists.

## Still open

Everything in plan.MD's core path (sensors, store-and-forward, Supabase, the Astro
site on Vercel, Weather Underground, Windy) is live as of 2026-08-27; CWOP since
2026-09-08 and WOW-BE since 2026-09-07. Remaining, as of 2026-09-26:

- **CWOP's elevation record** says 5 m; should be 16. Edit at
  <https://madis.ncep.noaa.gov/cwop_signup.shtml> → *Existing Account Update*;
  lands on the weekly Wednesday station-table build (cutoff Tue 02:00). See
  [docs/cwop.md](docs/cwop.md).
- **Heartbeat alerting** — code live on the Pi (2026-09-26), but off until
  `HEARTBEAT_URL` is set in the Pi's `.env`. Create a check at healthchecks.io
  (period 1 min, grace 1–5 min) — [docs/alerting.md](docs/alerting.md).
- **Supabase purge job** — the hourly rollup is verified running (2026-09-26:
  the newest `readings_hourly` bucket was the last complete hour, 60 samples
  each). The daily purge only deletes raw rows older than 90 days, and the
  oldest is 2026-08-27, so it has nothing to do until ~2026-11-25. After that,
  check the oldest raw row in `readings` is never more than ~90 days old (or run
  `select jobname, schedule from cron.job;` in the SQL editor any time).

## Done

- [x] **Archive-interval drift fixed** (#29, deployed and verified 2026-09-26).
      The collector archived every ~64.96 s against a configured 60 s, losing
      ~110 records a day: each sensor read's cost was added to a fixed sleep. It
      now sleeps to an absolute deadline. Verified on the live data after the
      restart: every gap exactly 60 s (min = avg = max).
- [x] **Heartbeat dead man's switch** (#29, 2026-09-26) — `core/heartbeat.py`;
      see "Still open" for switching it on.
- [x] **Wind spike fix deployed** — the fixed sampler (real elapsed timing,
      uploads off the sampling thread, 55 m/s ceiling, reed debounce; see
      2026-09-01 below) is confirmed running: the Pi pulled `main` at `40c300a`,
      which includes it, and restarted 2026-09-26. The bad 70.6 m/s row (3507,
      2026-09-01T12:29:10Z) was nulled out, verified 2026-09-08.
- [x] **Benchmarks** — both passed, measured 2026-09-08. *Live-update latency:*
      a new reading is on `/api/current` 1.7–7.1 s after the Pi records it; with
      the 45 s poll the worst case is ~50 s, inside the 60 s target.
      *Lighthouse:* production first scored mobile 84 / desktop 92; after the
      PR #23 fixes the preview scored **mobile 96** (LCP 3.9 → 2.6 s, CLS 0.119 →
      0, unused JS 338 → 28 KB). The remaining headroom is the hero waiting on its
      `server:defer` island. Not re-measured since the 2026-09-25 design pass.
- [x] **Dashboard design-review pass** (#28, 2026-09-26) — stale build-time
      panels made server islands, one countdown rule, stale-feed chip, one icon
      set, reworked tablet/desktop grid, `og.png` share image. `web/README.md`.
- [x] **README screenshots** — 2026-09-08, `docs/screenshots/` (desktop light,
      History in dark, phone), captured from production; re-shot 2026-09-26
      after the design pass.
- [x] **Network-outage soak test — passed 2026-09-26.** Cut the Pi's outbound
      HTTP/HTTPS/APRS for 10 minutes with an nftables drop rule (SSH untouched;
      auto-lifted by a `systemd-run` timer), 20:12–20:22 UTC. Results:
      - the Pi kept archiving every 60 s throughout (ids 37452–37467 contiguous)
        while every upload cursor froze — no sampling stall from hung uploads;
      - the site showed "Delayed · last reading 6m ago";
      - within ~60 s of the rule lifting every destination was back to 0 behind;
      - Supabase holds all 16 rows of the window, gaps 59.9999–60.0001 s, no wind
        spike (max gust 3.07 m/s).
      To repeat it (needs sudo on the Pi):
      ```
      sudo nft add table inet soak
      sudo nft add chain inet soak out '{ type filter hook output priority 0; }'
      sudo nft add rule inet soak out tcp dport '{ 80, 443, 14580 }' drop
      sudo systemd-run --on-active=10m --unit=soak-unblock nft delete table inet soak
      ```
- [x] **Gauge dials — dropped** (2026-09-26). In the original plan, never built;
      the cards already show the values and the design pass pushed toward less
      on the page.
- [x] **Rolling air-quality baseline** (2026-09-26) — the TGS2600 index drifted
      from ~62 to a ~69 median in its first month, so fixed bands kept going
      stale. The card's bands are now margins above the station's own 7-day
      median (`lib/supabase.ts:getAirBaseline`, from `readings_hourly`, 1-h memo):
      Normal ≤ +1.5, Slightly raised ≤ +2.1, from the week's p90/p98 gaps. On the
      day it shipped that gave 70.86 / 71.46 against the hand-tuned 70.9 / 71.5.
- [x] **Data credits** (2026-09-26) — a footer line credits Open-Meteo and the
      EPA (both CC BY 4.0, which requires it) and RainViewer. The EPA line had
      been removed from the bathing card on purpose, so it lives in the footer.
- [x] **Station elevation** — 16 m in the Pi's `config.yaml`, confirmed
      2026-09-26 over SSH and from the live data (station vs sea-level pressure
      implies exactly 16.0 m).
- [x] **WOW-BE** — site registered and uploading since 2026-09-07.
- [x] **WOW / WOW-IE** — decided 2026-09-26 **not** to enable: WOW shuts down
      late 2026 and WOW-BE covers the same ground. Code and tests stay.
- [x] **TGS2600 air quality** — enabled on the Pi 2026-08-28, board mounted away
      from the Pi; rollup SQL live. Baseline follow-up in "Still open".
- [x] **Offline alerting** (2026-09-15) — `.github/workflows/station-watchdog.yml`
      runs on GitHub every ~15 min (independent of the Pi), queries Supabase for
      the newest `recorded_at`, and opens/closes a single `station-down` GitHub
      issue when data goes stale (>20 min) / resumes. Logic in
      `.github/scripts/station-watchdog.cjs`. Replaces `dashboard-health.yml`
      (#5, 2026-08-30), which did the same Supabase freshness check but just
      failed the Action run — this version raises an actual issue instead of
      relying on GitHub's default failed-scheduled-run email. Also added
      `web/src/pages/api/health.ts` — returns HTTP 503 when data is stale, for
      pointing an external uptime monitor at (UptimeRobot, a phone app). Needs
      repo secrets `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` (already
      set for the retired workflow, so no new secrets needed).
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
- [x] Store-and-forward soak test — network-outage test **passed 2026-09-26**
      (see Done).
      The service has only been continuously up since 2026-08-27 21:46 BST (the
      earlier "since 11:01 BST" note was wrong — it was restarted repeatedly
      during the evening deploy session). No gaps >150s since that restart;
      nominal archive interval measured ~66s — a bug, fixed 2026-09-26 (see Done).

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
      **2026-08-31 (PR #11):** `getHistory` was silently truncating every range to
      PostgREST's 1000-row response cap (the oldest 1000 = ~17h), so SSR "today"
      figures and the 7d/30d charts were stale. Now paged in `fetchRange`, capped
      at 20k rows — the `readings_hourly` rollup is still the real fix.
- [x] ECharts: temp/humidity/pressure line chart, rain bar chart, wind rose (polar
      bar, averaged by 16-point compass bucket) — all in `HistoryCharts.tsx`
      (client island). Gauge dials for current temp/wind were planned but
      dropped (2026-09-26).
- [x] Derived + external dashboard panels (2026-08-31, PR #11): **Feels like**
      (wind chill / humidex, `lib/derived.ts`), **trend arrows** on temp/humidity
      + "vs 24h ago" (`lib/format.ts` `trend()`), **Records** card — all-time +
      this-month extremes, month rain vs Dublin normal, wettest day, dry streak
      (`lib/records.ts`, `RecordsSection.astro`), **Station health** — freshness,
      completeness, uptime, gap, totals (`lib/health.ts`, `StationHealth.astro`),
      **Moon** phase/illumination (`lib/moon.ts`, SunCalc port), **Pollen** —
      Open-Meteo CAMS per-species (`lib/pollen.ts`). Station-health footer still
      hardcoded "WU + Windy live, CWOP/WOW-BE coming" — since superseded by
      `StationLinks.astro` / `lib/stations.ts`, which lists CWOP (`GW7965`, live
      2026-09-08) with its aprs.fi link.
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
      **Superseded 2026-09-25 (#28):** card headers now use Lucide icons at one
      size; Meteocons remain only for weather conditions, served as
      Nord-recoloured copies from `public/weather-icons/`, still except the hero's
      (`pnpm weather-icons`).
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
      **Since changed:** the compass lives in the Wind card, and its wobble is
      stripped (2026-09-25) — only the hero icon animates now.
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
- [x] Sun tile (2026-08-28) — `src/components/SunSection.astro` + `src/lib/sun.ts`.
      Sunrise/sunset for Skerries computed locally (SunCalc-core algorithm, no API),
      daylight-progress bar with a sun marker, day length + delta vs yesterday.
      Sits in the left column of the live panel above Rain/Air quality; verified
      light + dark via headless screenshot.
- [x] Benchmark: **both passed**. Live updates 1.7–7.1 s to `/api/current` plus a
      45 s poll, inside the 60 s target. Lighthouse **mobile 96** on the PR #23
      preview (up from 84 on production: LCP 3.9 → 2.6 s, CLS 0.119 → 0).
      Full detail in "Still open" at the top.

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
- [x] **Wedged in production and fixed (2026-09-03).** The station went silent
      on Windy while Supabase/WU stayed healthy — the cursors are per-uploader,
      so nothing surfaced it. `journalctl` showed the same record (2455) being
      rejected once a minute with HTTP 400 and two messages:
  - `winddir must be an integer number` — the **root cause**. The vane reports
    the 16 compass points as `index * 22.5` (`sensors/wind_vane.py:47`), so the
    eight intercardinals are fractional. `upload/windy.py` was the only uploader
    that passed `wind_dir_deg` through raw; WU and WOW-BE already `round()` it.
  - `time must not be more than 2 hours in the past` — the **consequence**.
    `upload/base.py:flush` stops at the first failure to keep ordering, so the
    rejected record blocked the cursor, aged past Windy's 2h window, and could
    never be accepted again. Permanent head-of-line block.
      Fixes: round `winddir`; drop records older than 1h55m rather than retrying
      them forever (the rule `upload/cwop.py` already applies). Also switched the
      rate-limit sentinel from `0.0` to `-inf` — `time.monotonic()` counts from
      boot, so `0.0` made the first 5 minutes of records after every reboot look
      like they fell inside the 5-minute window and get skipped.
- [x] `tests/test_windy.py` — 9 tests. There were **none** before, which is why
      a field-format bug shipped; each of the three fixes above fails the suite
      when reverted on its own.
- [x] **`uploads` section in `weatherstation-doctor`** (2026-09-03) — per-
      destination cursor, backlog depth, age of the oldest unsent record, and
      the reason it stopped. `upload_state` gained `last_error`/`last_error_at`,
      written by `upload/base.py:flush` from an uploader's `last_error` and
      cleared by the next successful `mark_sent`, so it always says why a
      destination is stuck *now* rather than what once broke. Old buffers are
      migrated with `ALTER TABLE` at startup. A backlog only counts as a stall
      once its oldest unsent record is >10 min old, since uploads run behind by
      design. `docs/uploads.md` writes up the failure mode. 12 tests.
- [x] **WOW-BE staleness guard** (2026-09-03) — it rounds `winddir` so it was
      never exposed to the Windy bug, but it was the one live uploader that
      would retry a rejected record forever. Bound is 24h: it accepts backfill,
      so this is only a wedge backstop, not an API limit.
- [x] `wunderground` staleness guard — **done 2026-09-08**. It was the last live
      uploader that could wedge permanently. Drops records older than 24h, the
      same bound as `wowbe` (WU accepts a backdated `dateutc`, so this is a wedge
      backstop, not an API limit). `dateutc` now goes through `datetime` rather
      than string surgery, which also fixes a latent non-UTC-offset bug. WU had
      no tests at all; it now has 12 (`tests/test_wunderground.py`). Every live
      uploader now has a bound — see the table in `docs/uploads.md`.

## 5. Polish (plan.MD Recommendations #5, Details/E)

- [x] CWOP (APRS) uploader — **live 2026-09-08**; code done 2026-08-30 (`upload/cwop.py`).
      From-scratch APRS-IS client: opens a plain TCP socket to
      `cwop.aprs.net:14580`, logs in (`user <ID> pass <passcode> vers ...`), sends
      one APRS complete-weather-report packet, closes. Formatter converts to the
      APRS field set (position as `DDMM.mmN/DDDMM.mmW`, wind mph, temp °F incl.
      sub-zero `t-dd`, pressure in tenths-of-hPa `bnnnnn`, humidity `hnn` with
      `h00`=100%, rain in hundredths-of-inch for 1 h / 24 h / since-local-midnight).
      Rain windows are summed straight from the local SQLite buffer (read-only
      connection, `json_extract`), so they survive an uploader restart. Throttled
      to `send_interval_s` (300 s) like Windy; records older than 10 min are
      dropped rather than backfilled (CWOP is realtime-only). Config block
      `uploaders.cwop` + `station.timezone` in `config.example.yaml`, passcode in
      `.env` (`CWOP_PASSCODE`, default `-1`). 11 unit tests in `tests/test_cwop.py`.
      **Id `GW7965` issued 2026-08-31** (registration submitted 2026-08-30; MADIS
      id `G7965`, DUBLIN/IE), **site registered/activated 2026-09-08** after the
      packets showed at findu (`wx.cgi?call=GW7965`)/aprs.fi and we replied to the
      cwop-support@noaa.gov welcome thread. CWOP's record now carries our position
      (53.58467/-6.13983, straight from the packets) and elevation 5 m — the one
      thing still open, since the site is 16 m. Later account edits go
      through <https://madis.ncep.noaa.gov/cwop_signup.shtml> (*Existing Account
      Update*) and only land on the weekly Wednesday build (cutoff Tue 02:00).
      International ids use the `GW` prefix; the uploader never inspects it. Full
      notes: [docs/cwop.md](docs/cwop.md).
- [x] WOW-BE uploader — **live since 2026-09-07**; code done 2026-08-30 (`upload/wowbe.py`, 9 tests).
      RMI Belgium's WOW reboot (`wow.meteo.be`) — the migration path now that the
      UK/IE WOW instances are being decommissioned. v2 is a JSON REST API
      (`POST /api/v2/send/wow`, not the old query-string GET), auth = Site ID +
      Authentication Key (PIN) in the body, WU-protocol field set (°F/inHg/mph/in),
      `dateutc` as `YYYY-MM-DD HH:MM:SS` UTC, rate limit 20/min (no client
      throttle needed). `rainin` (last hour) + `dailyrainin` (since local
      midnight) summed from the SQLite buffer via the shared `upload/_rain.py`
      helper (also refactored CWOP onto it). Endpoint probed live — 422 validation
      responses confirm shape. Full notes: [docs/wowbe.md](docs/wowbe.md).
- [-] WOW / WOW-IE uploader — **code done 2026-09-06, deliberately not enabled**
      (decided 2026-09-26; WOW shuts down late 2026) (`upload/wow.py`, 13 tests).
      wow.met.ie is Met Éireann's *display* front-end onto the UK Met Office WOW
      network — registration and uploads both happen on wow.metoffice.gov.uk, and
      `wow.met.ie/automaticreading` just serves the HTML shell (a 200 that uploads
      nothing). Protocol is the old query-string `GET /automaticreading`:
      `siteid` + `siteAuthenticationKey` (6-digit PIN) as query params, WU-protocol
      field set minus `absbaromin` (not in WOW's parameter list), `dateutc` as
      `YYYY-MM-DD HH:MM:SS` UTC. WOW wants ≥5 min between readings and 429s past
      that, so the uploader self-throttles like Windy — skips inside the window and
      reports success, giving one record in five with no backfill. `429` counts as
      delivered; `400` is WOW's blanket rejection for unknown site / wrong PIN /
      bad field, with an empty body (probed live 2026-09-06 — no differentiated
      validation, unlike WOW-BE's 422s). Shares `upload/_rain.py` with CWOP/WOW-BE.
      To enable it anyway: a site registered at <https://wow.metoffice.gov.uk>,
      `WOW_AUTH_KEY` in `.env`, `uploaders.wow.{enabled,station_id}` +
      `station.timezone` on the Pi; then allow ~2 h for the WOW-IE map to show it.
      **Caveat: the Met Office began retiring WOW in Jan 2026, full decommissioning
      late 2026** — this is a deliberately short-lived destination, run alongside
      WOW-BE (the successor) and switched off when it stops answering. Full notes:
      [docs/wow-ie.md](docs/wow-ie.md).
- [x] GitHub Actions CI: `.github/workflows/ci.yml` (2026-08-27) — two jobs on
      push-to-`main` + every PR:
  - **pi**: `ruff check` + `ruff format --check` + `pytest` on Python 3.9 & 3.13.
    Ruff lint rules are now pinned explicitly in `pyproject.toml`
    (`select = ["E","F","W","I","UP","B","SIM","C4"]`) and `ruff` itself pinned
    to `==0.16.4` in the `dev` extra — newer ruff ships a broader default rule
    set and a drifting formatter, which would make CI non-reproducible. One-time
    `ruff format` reformat of 21 files came with this (mechanical: blank line
    after module docstrings, re-wrapping lines that now fit in 100).
  - **web**: `pnpm install --frozen-lockfile` + `astro build` on Node 22, with dummy `PUBLIC_SUPABASE_*`
    env (build never hits Supabase; the live data paths are all request-time).
  - `astro check` (TS typecheck) added in #23 (2026-09-08); the job runs
    `pnpm run check` then `pnpm run build`.
- [x] Retention/downsampling job in Supabase — keep 1-minute data ~90 days, hourly
      averages beyond that, to stay inside the 500MB free tier. **SQL written**
      (`docs/supabase-retention.sql`, 2026-08-27): `readings_hourly` rollup table
      + `roll_up_readings_hourly()` / `purge_old_readings()` functions +
      `pg_cron` schedules (rollup at :05, purge daily 03:20 UTC). Wind direction
      is vector-averaged, rain summed. **Run on the live project** — the rollups
      answer over REST (checked 2026-09-26) and the site's 7d / 30d / All-time
      charts read them (#26). The hourly rollup job is verified running
      (2026-09-26); the purge can't act before ~2026-11-25 — see "Still open".
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
- [x] README screenshots — done 2026-09-08, captured from production with a
      headless browser into `docs/screenshots/` (desktop light, History in dark,
      phone). Regenerate them the same way after any visual change.
- [x] TGS2600 air quality sensor (MCP342X @ `0x6A`, channel 0) — **code done**
      (2026-08-27). `i2cdetect` confirms the ADC at `0x6a` is present and
      unclaimed. `sensors/air_quality.py` ports the Foundation kit's relative
      index (`100 × (max − adc) / max`, uncalibrated — higher = more reducing
      gas); `sensors.air_quality.{enabled,warmup_s}` in config (off by default,
      300 s heater warm-up gate); flows through sampler → `Record.air_quality` →
      SQLite → Supabase. `air_quality` column added to `docs/supabase-schema.sql`
      + `docs/supabase-retention.sql` (averaged in the hourly rollup). Dashboard:
      a conditional "Air quality" card on the live panel + a history line chart,
      both hidden until real data lands. **Live:** enabled on the Pi 2026-08-28,
      board mounted away from the Pi, SQL run. Not sent to WU/Windy — neither
      accepts a non-calibrated index.

## Housekeeping

- [ ] Keep `docs/sensors.md`, `plan.MD`, and `claude.md` in sync as things change —
      they now cross-reference each other and will drift if only one is updated
- [ ] `pi/config.yaml` and `pi/.env` must never be committed — enforced by the
      repo-root `.gitignore` (added 2026-08-27; didn't exist before that)
