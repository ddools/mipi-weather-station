# Architecture

## Data flow
1. **Sample** — wind is sampled every `wind_sample_s` (default 5 s) for gust detection;
   rain tips and vane direction are accumulated alongside. Each sample divides its
   pulse count by the real elapsed time, not the nominal window.
2. **Archive** — every `archive_interval_s` (default 60 s) an archive `Record` is built:
   air temperature from the DS18B20 probe (the onboard chips self-heat — see
   [sensors.md](sensors.md)), BMP085 pressure, HTU21D humidity corrected to the real
   air temperature, wind avg/gust + direction mode, rain total, the TGS2600 air-quality
   index when fitted, plus derived dewpoint and sea-level pressure. The loop sleeps to
   an absolute deadline, so time spent reading sensors comes out of the interval
   instead of adding to it (records land exactly 60 s apart — before 2026-09-26 they
   drifted to ~65 s and lost ~110 a day).
3. **Buffer** — the record is written to local SQLite *first*. This is the source of
   truth; the Pi keeps logging through any outage. Each stored record also fires the
   heartbeat, if `HEARTBEAT_URL` is set (see [alerting.md](alerting.md)).
4. **Upload** — on a background thread, never the sampling one. Each enabled uploader
   tracks its own `last_sent_id` cursor in SQLite and replays everything newer,
   stopping at the first failure. Retry happens next archive tick — automatic
   catch-up after outages. Every realtime destination drops records past an age
   bound so one rejected record can't wedge its cursor (see [uploads.md](uploads.md)).

## Why per-uploader cursors?
Supabase might be up while Weather Underground is down. Independent cursors mean one
slow/broken destination never blocks another, and each destination receives every
record exactly once (or harmlessly re-sends on ambiguous failures). The flip side:
one destination can sit stuck for days while the website looks healthy —
`weatherstation-doctor --uploads` shows each cursor's backlog and last error.

## Cloud & web
- **Supabase**: `readings` table, RLS enabled — anonymous `SELECT` only; the Pi inserts
  with the service-role key. Unique index on `recorded_at` (makes retries idempotent).
  `readings_hourly` rollup + `readings_daily` view from
  [supabase-retention.sql](supabase-retention.sql) back the 7d / 30d / All-time charts.
- **Astro on Vercel** (weather.dermotdooley.com): a prerendered shell, with every
  panel that depends on "now" as a server island (`server:defer`) rendered per
  request; `/api/*` SSR routes for polling; ECharts client island for history charts.
  Details in [web/README.md](../web/README.md).
- **Alerting**: the Pi's heartbeat to an external watcher (fast), plus a GitHub
  Actions watchdog on the newest Supabase row (slow backstop) — [alerting.md](alerting.md).

## Calibration notes (Oracle kit defaults)

See [sensors.md](sensors.md) for the full verified hardware reference.

- Anemometer: radius 9.0 cm, 2 pulses/rotation, adjustment factor 2.36
- Rain gauge: 0.2794 mm per bucket tip
- Wind vane: 16 reed positions via an MCP342X I2C ADC + a fixed resistor-divider
  network built into the board — same for every unit of this kit, no per-unit
  measurement needed. Table lives in `calibration.wind_vane` in config.yaml.
