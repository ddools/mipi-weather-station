# Building the Software for a Raspberry Pi Weather Station (Oracle Kit → standalone site, domain TBD)

> **Update (2026-08-27):** the site plan changed from a `/weather` page bolted
> onto the existing dermotdooley.com site to a **standalone site on its own
> domain** (name not yet decided — placeholder used below). Its Astro app now
> lives fully in this repo's `web/` directory as its own deployable project
> (its own Vercel project), not just integration notes for another repo. UI
> components use **[shadcn/ui](https://ui.shadcn.com)** (React, Tailwind, Radix)
> mounted as Astro React islands — Astro itself is unchanged; shadcn is an
> unusual pairing with Astro (it's built for React meta-frameworks like Next.js)
> but works via Astro's `@astrojs/react` integration. See Details/C below.

> **Errata (2026-08-27):** the "Sensor reading specifics" section below described
> generic BYOWS (Build-Your-Own-Weather-Station) hardware — BME280 + MCP3008 SPI
> ADC. Bringing the sensors up on the real Pi over SSH showed this kit is actually
> the official Raspberry Pi Foundation/Oracle HAT, which uses **different chips**:
> BMP085/BMP180 + HTU21D (I2C) for temp/humidity/pressure, and an MCP342X I2C ADC
> (not SPI) for the wind vane. The anemometer calibration factor was also wrong
> (1.18, should be 2.36). Corrected below inline; full verified reference is
> **[docs/sensors.md](docs/sensors.md)**. The cloud/upload architecture is
> unaffected; the web/site plan changed separately — see the update note above.

## TL;DR
- **Build a small, custom Python service on the Pi** (BMP085 + HTU21D over I2C for temp/humidity/pressure, anemometer/rain gauge via GPIO pulse counting, wind vane via an MCP342X I2C ADC — see [docs/sensors.md](docs/sensors.md) for the verified chip set) that logs to a local SQLite buffer and pushes readings to a free-tier **Supabase (Postgres) cloud database**; your Astro site on Vercel reads from Supabase via a server island / SSR API route and renders live conditions + history charts with **ECharts or Chart.js**. This is the most practical, publishable architecture for a father-son project.
- **For weather-service sharing, prioritise Weather Underground** (still free for PWS uploads in 2026 via `weatherstation.wunderground.com/weatherstation/updateweatherstation.php`), plus **CWOP** (feeds NOAA MADIS) and **Windy** (new Stations API v2, effective January 2026). Do **not** build around Met Office/Met Éireann WOW — it is being **decommissioned in late 2026**.
- **Publish as open source from day one** with a clean monorepo (`/pi` Python collector, `/web` Astro app, `/docs`), an OSI licence (**MIT**, already chosen), and a strong README. Build in stages: sensors → local logging → cloud push → website → weather-service uploads → polish.

## Key Findings

### The existing official software is dated and the Oracle backend is effectively dead
The official Raspberry Pi Foundation code (`github.com/RaspberryPiFoundation/weather-station`) is a data-logging stack built around a **local MariaDB/MySQL database** with Python sensor scripts, uploading to a central **Oracle Apex database**. The Raspberry Pi Learning setup guide itself warns: "The SD card that was originally shipped with the Weather Station kit contains a version of Raspbian… which is now extremely out of date and should not be used." Community reports confirm the Oracle crowd-sourcing backend is unresponsive — one teacher reported trying to register and "never heard back." **Conclusion: treat the official code as a reference for sensor math (anemometer radius, bucket size, wind-vane voltage mapping) but rewrite the stack.**

### WeeWX + BYOWS is a mature path — but for different hardware than this kit has
`jardiamj/BYOWS_RPi` is a WeeWX driver (GPLv3) written for the *generic*
Build-Your-Own-Weather-Station hardware — BME280 + GPIO + MCP3008 (SPI). WeeWX
itself is described as "the most mature open-source weather station software for
Linux," with built-in "StdRESTful" uploaders for Weather Underground, PWSweather,
CWOP, Windy and (formerly) WOW, plus an MQTT publish extension — genuinely good
software. But bringing the actual sensors up (see
[docs/sensors.md](docs/sensors.md)) showed this specific kit uses different chips
(BMP085/BMP180 + HTU21D + MCP342X), which `BYOWS_RPi` doesn't support. There's no
existing WeeWX driver for this exact chip set, so WeeWX is no longer a fork in the
road for this project — see "Alternative architecture" in Details/A below.

### Sensor reading specifics (confirmed on real hardware, 2026-08-27)
- **Temp/pressure — BMP085/BMP180**, not BME280: I2C, fixed address `0x77`, chip ID
  `0x55`. No CircuitPython driver exists for this discontinued chip; talk to it
  directly over `smbus2` using the Bosch compensation formula (ported from the
  official kit driver — see `pi/src/weatherstation/sensors/bmp085.py`).
- **Humidity — HTU21D**, a separate chip: I2C, fixed address `0x40`. Not bundled
  with pressure as a BME280 would be. Includes a CRC-8 check on each reading.
- **Anemometer:** reed switch on a GPIO pin (GPIO 5 on this kit) counted with
  `gpiozero.Button`; wind speed derived from rotations × circumference over a
  sample interval. `radius_cm = 9.0`, and the real Foundation calibration constant
  is **`2.36`**, not 1.18 (a documentation error in an earlier draft of this plan —
  1.18 belongs to a different kit's docs).
- **Rain gauge:** tipping bucket on GPIO 6, each tip = a fixed volume,
  `BUCKET_SIZE = 0.2794` mm — this value was already correct.
- **Wind vane:** analogue, but reads via an **MCP342X I2C ADC** (`0x69`, channel 0)
  — **not** an MCP3008 over SPI. The 16 reed-switch positions map to a *fixed*
  resistor-divider network built into the kit board (`Vin = 3.268V`, divider
  `75kΩ`), so — unlike a generic vane — the ADC-value-to-degrees table is a known
  manufacturing constant, not something to measure per-unit. Full resistor table
  in `docs/sensors.md`.

### Data pipeline: a cloud Postgres push is the best fit
The Pi sits behind a home NAT in Dublin, so the cleanest pattern is **the Pi pushing outbound to a cloud database** (no port-forwarding, no dynamic-DNS). Free-tier options compared (2026):
- **Supabase** — 500 MB Postgres, auto-generated REST API (PostgREST), Python client, up to 2 active projects free; **free projects pause after 7 days of no database activity** (a resumed project takes ~30 seconds to wake). For an always-on station uploading every minute, the project never goes idle, so the pause rule is not a practical problem.
- **Neon** — serverless Postgres, 0.5 GB storage/project, 100 CU-hours/month compute, scale-to-zero; no realtime. Excellent as a pure database.
- **InfluxDB Cloud / Upstash / Vercel Postgres** — viable but either narrower free tiers or time-series-specific.

**Recommendation: Supabase**, because it bundles the database + an instant REST API + a JS client that the Astro/Vercel front end can query directly, minimising glue code. Postgres easily handles weather time-series at this volume (one row/minute ≈ 525k rows/year, well within 500 MB with sensible columns).

### Astro on Vercel: use the Vercel adapter + server islands / SSR API routes
- Astro 5 defaults to `output: 'static'`; add `@astrojs/vercel` and opt individual routes into on-demand rendering. **Server islands** (`server:defer`) are the ideal primitive: the page ships instantly as static/cached HTML, and the live-conditions panel renders on-demand from the server, fetching the latest Supabase row. Historical charts can be a client island that calls an Astro API route (`src/pages/api/history.ts` with `export const prerender = false`).
- Vercel's free (Hobby) tier serves the SSR functions; keep the static shell CDN-cached and only defer the dynamic panels.

### Charting: ECharts or Chart.js
- **Chart.js** — smallest bundle, Canvas, easiest setup, ideal for standard temp/pressure/wind line charts; excellent mobile performance.
- **ECharts** — more chart types (gauges, wind rose/polar, heatmaps), progressive rendering for large series; better for an "impressive" dashboard (wind-direction rose, gauge dials).
- **Recommendation:** ECharts for the flagship dashboard (gauges + wind rose look striking and are responsive), or Chart.js if you want minimal footprint. Both are open-source and Canvas-based (good for frequent updates).

### Weather-service integration status in 2026 (important, time-sensitive)
- **Weather Underground — RECOMMENDED, still free.** Upload via HTTP GET to `https://weatherstation.wunderground.com/weatherstation/updateweatherstation.php` with `ID`, `PASSWORD` (station key, not account password), `dateutc`, `action=updateraw` and observation fields. The official protocol also offers a real-time "RapidFire" endpoint: per Weather.com's PWS Upload Protocol, "RapidFire Updates allow you to update weather station conditions at a frequency up to once observation every 2.5 seconds" via `rtupdate.wunderground.com` with `&realtime=1&rtfreq=2.5`. Register a free station at wunderground.com → My Devices → Add a New PWS (no branded hardware required) to get the Station ID + Station Key. **Units are imperial:** °F, inHg, mph, inches of rain. Server replies `success` or `INVALIDPASSWORDID|…`.
- **CWOP (Citizen Weather Observer Program) — RECOMMENDED.** Free; data flows to NOAA MADIS and is used by National Weather Service forecasters. Register at the NOAA CWOP signup for a non-ham `CW`/`DW` station ID (use your ham callsign if licensed); data is sent as APRS packets to `cwop.aprs.net:14580`, preferred interval ~5 min. WeeWX has native CWOP support; a custom Python client must format an APRS weather packet.
- **Windy — RECOMMENDED (new API).** Per Windy's official API reference: "This is a new API, effective from January 2026… The legacy API will remain operational only until the end of 2026, after which it will be fully shut down." Host `https://stations.windy.com/`; register a station for an API key and POST observations to the v2 API. Note the upload API's default pressure unit is Pascals (while Windy's download API uses hectoPascals).
- **PWSWeather (AerisWeather)** — free; near-identical protocol to WU (same parameter names, different endpoint). Easy to add as a bonus target.
- **Met Office WOW / Met Éireann WOW-IE — DO NOT rely on.** Per the official Met Office WOW Blog (Dec 2025) and Met Éireann's wow.met.ie/about-wow, "the UK Met Office will start retiring WOW in January, with full decommissioning planned for late 2026." The WOW home page already states "DataPoint API service has now been retired which means that Met Office Automated Weather Station observations are no longer flowing into WOW," and Met Éireann says observations "will no longer be uploaded and displayed on WOW-IE" once decommissioned; it is only "exploring an alternative." A community successor exists — **WOW-BE reboot** run by the Royal Meteorological Institute of Belgium: per the WeeWX-user group, the endpoint changes to `http://wow.meteo.be/api/v2/send?`, owners "re-register their station (they receive a new UUID)," the upload protocol is unchanged, and the back end is open source at `github.com/rmibelgium/wowbe` under GPL. This is the migration path if you want WOW-style national/European sharing.
- **Weathercloud** — accepts uploads and has a RESTful API on paid plans, but there is **no official public data-retrieval API** for the free tier (community integrations are reverse-engineered), so it is a weak fit for feeding your own website. Fine as an extra publish target only.

## Details

### A. Pi software setup and architecture

**OS & prerequisites**
1. Flash current Raspberry Pi OS (Lite is fine) — do **not** use the old bundled SD image.
2. `sudo raspi-config nonint do_i2c 0` → enable **I2C** (BMP085, HTU21D, both MCP342X
   ADCs including the wind vane all sit on I2C — SPI is not needed for this kit),
   and 1-Wire if you use a DS18B20 ground/soil probe.
3. Create a Python virtual environment; install `smbus2` (talks to the BMP085,
   HTU21D, and MCP342X directly — no CircuitPython/Blinka needed), `gpiozero`,
   `requests`, `paho-mqtt` (optional), and the `supabase` Python client.
4. Verify sensors with `i2cdetect -y 1` (expect `77` for BMP085/180, `40` for
   HTU21D, `69`/`6A` for the two MCP342X ADCs — see `docs/sensors.md`).

**Recommended architecture (custom Python — the publishable path)**
Structure the collector as a small package rather than one script:
- `sensors/bmp085.py`, `sensors/humidity.py`, `sensors/air.py` (combines the two
  into one temp/humidity/pressure reading), `sensors/mcp342x.py`, `sensors/anemometer.py`,
  `sensors/rain.py`, `sensors/wind_vane.py` — one module per sensor, each returning
  clean SI values.
- `core/sampler.py` — schedules sampling: high-frequency wind sampling (e.g. every few seconds for gusts), aggregated into an **archive record** every 1–5 minutes (mirroring WeeWX's loop/archive model).
- `store/local_buffer.py` — writes every archive record to a **local SQLite database first** (this is the source of truth and the store-and-forward buffer).
- `upload/` — one uploader per destination: `supabase.py`, `wunderground.py`, `cwop.py`, `windy.py`. Each reads unsent rows from SQLite, posts them, and marks them sent only on success. This gives **automatic catch-up after network/power outages**.
- `config.yaml` + `.env` — station metadata (lat/lon/elevation), calibration constants, and secrets (API keys) kept out of git.
- Run as a **systemd service** (`weatherstation.service`) so it starts on boot and restarts on failure; gate start on network availability.

**Store-and-forward detail:** because home broadband and power are not 100% reliable, the SQLite-first design means the Pi keeps logging locally even when offline, and each uploader replays the backlog when connectivity returns — the same principle WeeWX uses when it catches up its database and re-emits records.

**Alternative architecture (WeeWX + BYOWS driver — no longer applicable)**
An earlier draft of this plan proposed `BYOWS_RPi` as a "fast path" WeeWX driver
shortcut. That driver is written for BME280 + MCP3008 hardware, which is **not**
what's on this board (see [docs/sensors.md](docs/sensors.md): real chips are
BMP085/BMP180 + HTU21D + MCP342X). Using it would require writing a new WeeWX
driver for the real chip set from scratch — strictly more work than the custom
Python service already built and verified on real hardware, not a shortcut. There
is no existing WeeWX driver (or other library) for this exact combination of
chips; the closest prior art is the official
[RaspberryPiFoundation/weather-station](https://github.com/RaspberryPiFoundation/weather-station)
repo itself, which is what the current sensor drivers were ported from.

**Which to choose?** Custom Python — this is now the only realistic path for this
hardware, not one option among several. It's also already done: all four sensors
are implemented, verified on real hardware, and committed. See
[TODO.md](TODO.md) for what's left to deliver the rest of the plan.

### B. Cloud / data layer setup (Supabase)
1. Create a Supabase project; note the project URL and keys (Settings → API). Store the **service role key only on the Pi** (never in the front end); use the **anon key with Row Level Security** for the website's read path.
2. Create a `readings` table: `id bigserial`, `recorded_at timestamptz` (indexed), `temp_c`, `humidity`, `pressure_hpa`, `wind_speed_ms`, `wind_gust_ms`, `wind_dir_deg`, `rain_mm`, plus derived fields (dewpoint, sea-level pressure). Add an index on `recorded_at` for fast range queries.
3. Enable **RLS**: a policy allowing anonymous `SELECT` only (read-only public data), while the Pi inserts using the service key. This is the fix for the common "401 Unauthorized with RLS on" problem.
4. The Pi's `upload/supabase.py` inserts new rows via the Python client or a REST POST; batch-insert backlog rows after outages.
5. Optional retention: a scheduled SQL job to downsample rows older than N months (e.g. keep 1-minute data for 90 days, hourly averages forever) to stay within the 500 MB free tier.

### C. Astro site on its own domain (impressive, responsive)

**Changed 2026-08-27:** this is now a standalone site at its own domain (not yet
registered — TBD), not a `/weather` page inside the dermotdooley.com repo. The
Astro app lives fully in **this repo's `web/`**, deployed as its own Vercel
project. UI components use **shadcn/ui** (React + Tailwind + Radix, copied into
the repo rather than installed as an opaque dependency — that's how shadcn
works: `npx shadcn add <component>` vendors the component source into `web/`).

1. Scaffold: `npm create astro@latest` in `web/`; add the adapter
   (`npx astro add vercel`) and React support (`npx astro add react`) since
   shadcn/ui components are React, mounted as **client islands**
   (`client:load`/`client:visible`) inside otherwise-static `.astro` pages.
2. `npx shadcn init` inside `web/` (needs Tailwind, which its init sets up);
   add components as needed (`card`, `tabs`, `button`, a theme/dark-mode toggle,
   etc.) — each pulls the component source into `web/src/components/ui/`, so it's
   yours to edit, not a black-box dependency.
3. **Live conditions panel** as a **server island** (`server:defer`): a `.astro`
   component that queries Supabase for the newest row on the server, with a
   static fallback skeleton shown instantly, styled with shadcn `Card`
   components. Add a light client-side `fetch` on a timer (e.g. every 30–60 s)
   to a `/api/current` route for live refresh without a full reload.
4. **History charts** as a client island: an API route `src/pages/api/history.ts`
   (`export const prerender = false`) returns JSON for a requested range
   (24 h / 7 d / 30 d), and ECharts/Chart.js renders line charts (temp, pressure,
   humidity, rain), a **wind rose** (ECharts polar bar), and **gauge dials** for
   current temp/wind. shadcn's `Tabs` component is a natural fit for switching
   between ranges.
5. **Design for impact + responsiveness:** a CSS grid dashboard (shadcn ships
   Tailwind utility classes, which compose naturally with a grid layout) that
   reflows from multi-column (desktop) to single-column (mobile); large "hero"
   current-temperature card; card-based tiles; dark-mode support (shadcn has a
   documented dark-mode pattern via a `ThemeProvider` + CSS variables — reuse it
   rather than hand-rolling one); use `PUBLIC_`-prefixed env vars only for the
   anon key, keep secrets server-side. Keep the static shell CDN-cached and defer
   only the data panels for fast Lighthouse scores.
6. Store secrets in Vercel project environment variables; the anon key + RLS
   means the browser can safely read data.
7. Once the domain is decided: register it, add it as a custom domain on the
   Vercel project, point DNS (Vercel's dashboard gives the exact records).

### D. Weather-service integration (concrete)
**Weather Underground (do first — biggest audience, free):**
- Register: wunderground.com → sign up (free) → My Devices → **Add a New PWS** (you don't need to own branded hardware) → get **Station ID** and **Station Key**.
- Upload (batch/standard): `GET https://weatherstation.wunderground.com/weatherstation/updateweatherstation.php?ID=XXXX&PASSWORD=KEY&dateutc=YYYY-MM-DD+HH%3AMM%3ASS&tempf=..&humidity=..&baromin=..&windspeedmph=..&winddir=..&rainin=..&dailyrainin=..&action=updateraw`. Convert your SI values to °F, inHg, mph, inches. `dateutc` must be UTC and URL-escaped (or `now`). Response is `success` or `INVALIDPASSWORDID|…`.
- Optional live: RapidFire endpoint `rtupdate.wunderground.com` with `&realtime=1&rtfreq=2.5` for near-real-time updates.

**CWOP (do second — scientific value):**
- Register at the NOAA CWOP signup to get a `CW`/`DW` ID (use your ham callsign if licensed).
- Send APRS weather packets to `cwop.aprs.net:14580` every ~5 minutes with lat/lon and observation in APRS format. WeeWX handles this natively; for custom Python, build the APRS packet string (mph, °F, inHg-hundredths, rain hundredths-of-inch).

**Windy (do third):**
- Register a station at `stations.windy.com` for an API key; POST observations to the v2 API (`https://stations.windy.com/api/v2/...`), the supported path from January 2026 (legacy shuts down end of 2026). Send pressure in Pascals on upload.

**PWSWeather (bonus):** register at pwsweather.com, reuse the WU-style parameters against the AerisWeather endpoint.

**WOW:** skip the UK/IE WOW network (decommissioning late 2026). If you want WOW-style national sharing, use **WOW-BE reboot** (`wow.meteo.be`, `/api/v2/send`, same protocol, new UUID per station).

Design the uploaders as pluggable modules so adding/removing a service is a config change — this also makes the open-source project more valuable to others.

### E. Open-sourcing the project
- **Repo layout (monorepo):**
  ```
  weather-station/
  ├── pi/                 # Python collector package
  │   ├── src/weatherstation/{sensors,core,store,upload}
  │   ├── tests/
  │   ├── config.example.yaml
  │   └── pyproject.toml
  ├── web/                # Astro app — full standalone site, own Vercel project
  ├── docs/               # setup guide, wiring, architecture diagram
  ├── LICENSE
  ├── README.md
  ├── CONTRIBUTING.md
  └── .github/            # issue templates, CI
  ```
- **Licensing:** **MIT** (already chosen — see LICENSE). The official Foundation
  driver this project's sensor code was ported from is BSD-style licensed
  (Adafruit/Raspberry Pi Foundation), which is compatible with MIT; no GPLv3
  entanglement since the project doesn't use the GPLv3-licensed BYOWS driver.
- **Documentation:** a copy-paste-ready README (what it is, wiring diagram, install commands, config, screenshots of the dashboard), plus `docs/` for the deeper build. Add badges (licence, build). Keep secrets in `.env`/Vercel env vars, commit only `config.example.yaml`.
- **Quality:** PEP 8 / a formatter (Black/Ruff), a `tests/` folder mirroring the package, and GitHub Actions CI. Separate source from tests; keep config files at the root.
- **Publish incrementally:** it's fine to open the repo early with a clear roadmap; a short, clear README beats none.

## Recommendations
1. ~~**Weekend 1 — hardware validation.**~~ Done 2026-08-27 — all four sensors
   (BMP085, HTU21D, anemometer, rain gauge, wind vane) verified returning plausible
   values on real hardware. See [docs/sensors.md](docs/sensors.md).
2. **Weekend 2 — local logging + cloud push.** Write the SQLite-first collector and the Supabase uploader; get one row/minute landing in Postgres with RLS read-only. *Benchmark:* 24 h of continuous rows with no gaps after a deliberate network-unplug test (store-and-forward works).
3. **Weekend 3 — the website.** Ship the standalone site on Vercel (domain TBD):
   Astro + shadcn/ui, server-island live panel + one history chart. *Benchmark:*
   live value updates within 60 s; mobile Lighthouse ≥ 90.
4. **Weekend 4 — weather services.** Add Weather Underground first, then CWOP, then Windy. *Benchmark:* your station visible on the wunderground.com dashboard and findU (CWOP).
5. **Ongoing — polish + open source.** Add wind rose + gauges, dark mode, retention/downsampling, README + licence, CI.
- **Decision thresholds:** the WeeWX fallback originally suggested here no longer
  applies — no WeeWX driver exists for this kit's real chips (BMP085/HTU21D/MCP342X),
  so "falling back to WeeWX" would mean writing a new WeeWX driver, not adopting an
  existing one. If the sensor layer becomes a time sink, the sensors already work
  (see docs/sensors.md) so there's little left to fall back from. If Supabase's
  free tier limits bite (unlikely at this volume), switch the uploader target to
  Neon (pure Postgres) — the Astro read layer barely changes.

## Caveats
- **WOW is going away:** any plan that centres on Met Office/Met Éireann WOW will break in late 2026. Use WU/CWOP/Windy; consider WOW-BE only if you specifically want a European public map.
- **Weather Underground read vs. upload:** *uploading* your own PWS data remains free; *pulling* WU data/forecasts via api.weather.com generally needs a paid/limited API key. Your site should read from your own Supabase, not from WU.
- **Windy & legacy APIs:** the Windy legacy upload API is deprecated and shuts down at the end of 2026 — build against Stations API v2 from the start.
- **Supabase free-tier pause** applies after 7 days of no database activity; a station uploading every minute stays active, but if you pause the Pi for a long holiday the project can be paused (restorable within 90 days; ~30 s to wake).
- **Sensor calibration is site-specific:** anemometer factor, rain-bucket size, and especially the 16 wind-vane voltage thresholds vary per unit and need tuning; expect noisy vane readings and map to the nearest known value.
- **Weathercloud** has no official free data-retrieval API — treat it as a publish-only target, not a data source for your site.
- Some figures (free-tier limits, API cut-off dates) are current as of mid-2026 and set by third parties; re-check before relying on them long-term.