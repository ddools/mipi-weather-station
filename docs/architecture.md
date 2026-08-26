# Architecture

## Data flow
1. **Sample** — wind is sampled every `wind_sample_s` (default 5 s) for gust detection;
   rain tips and vane direction are accumulated alongside.
2. **Archive** — every `archive_interval_s` (default 60 s) an archive `Record` is built:
   BME280 snapshot + wind avg/gust + direction mode + rain total, plus derived
   dewpoint and sea-level pressure.
3. **Buffer** — the record is written to local SQLite *first*. This is the source of
   truth; the Pi keeps logging through any outage.
4. **Upload** — each enabled uploader tracks its own `last_sent_id` cursor in SQLite
   and replays everything newer, stopping at the first failure. Retry happens next
   archive tick — automatic catch-up after outages.

## Why per-uploader cursors?
Supabase might be up while Weather Underground is down. Independent cursors mean one
slow/broken destination never blocks another, and each destination receives every
record exactly once (or harmlessly re-sends on ambiguous failures).

## Cloud & web
- **Supabase**: `readings` table, RLS enabled — anonymous `SELECT` only; the Pi inserts
  with the service-role key. Index on `recorded_at`.
- **Astro on Vercel**: static shell + server island for the live panel (reads latest
  row), `/api/history` SSR route + ECharts client island for charts.

## Calibration notes (Oracle kit defaults)
- Anemometer: radius 9.0 cm, 2 pulses/rotation, adjustment factor 1.18
- Rain gauge: 0.2794 mm per bucket tip
- Wind vane: 16 reed positions via MCP3008 + voltage divider — the ADC values differ
  per unit; measure yours and fill `calibration.vane_table` in config.yaml.
