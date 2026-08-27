# product-enhancement.md — dashboard UX handoff

Handoff for the next round of work on the **public dashboard** (`web/`), live at
[weather.dermotdooley.com](https://weather.dermotdooley.com). Written 2026-08-27
after a product review of the live site + the `web/` source.

Scope: the visitor-facing weather page only. Collector/upload work is tracked in
[TODO.md](TODO.md); hardware in [docs/sensors.md](docs/sensors.md). This doc does
**not** re-litigate the architecture decisions in [CLAUDE.md](CLAUDE.md).

## Current page (what a visitor sees today)

Single page, [web/src/pages/index.astro](web/src/pages/index.astro):

- **Status line** — Live / Delayed / Offline dot + "Last updated 27 Aug, 17:49".
- **Six stat cards** ([CurrentConditions.astro](web/src/components/CurrentConditions.astro)):
  Temperature + dewpoint, Humidity, Pressure (sea-level), Wind (speed + gust +
  direction), Wind Direction (animated compass + degrees), Rain (interval).
- **Tides — Balbriggan** card ([TidesSection.astro](web/src/components/TidesSection.astro)).
- **History** — 24h / 7d / 30d tabs, three ECharts
  ([HistoryCharts.tsx](web/src/components/HistoryCharts.tsx)): combined
  temp+humidity+pressure line, rain bars, wind rose.
- Dark mode toggle; current-conditions cards self-refresh every 45s (charts do not).

Data comes from Supabase `readings` via [web/src/lib/supabase.ts](web/src/lib/supabase.ts)
(`getLatestReading`, `getHistory`) and the `/api/current` + `/api/history` routes.
The `Reading` shape: `temp_c, humidity, pressure_hpa, pressure_msl_hpa,
wind_speed_ms, wind_gust_ms, wind_dir_deg, rain_mm, dewpoint_c, recorded_at`.

## Priorities at a glance

| # | Change | Priority | Touches |
|---|--------|----------|---------|
| 1 | Fix the temperature source (shows ~28 °C, should be ~17 °C) | **P0** | Pi, not `web/` |
| 2 | Remove broken-looking `updated —` placeholder on the temp card | **P0** | `web/` |
| 3 | Temp / wind-gust / pressure high–low for **today** | **P1** | `web/` + aggregate |
| 4 | Wind in **km/h** (primary) + m/s + Beaufort | **P1** | `web/` |
| 5 | Pressure **trend** arrow (rising / steady / falling) | **P1** | `web/` + aggregate |
| 6 | Rain: **"today" total** instead of raw interval | **P1** | `web/` + aggregate |
| 7 | Add a **wind speed/gust time-series** chart | **P1** | `web/` |
| 8 | Wind rose by **frequency**, not average speed | **P2** | `web/` |
| 9 | **Merge** the two wind cards | **P2** | `web/` |
| 10 | Per-range **x-axis formatting** on charts | **P2** | `web/` |
| 11 | **Split** the combined temp/humidity/pressure chart | **P2** | `web/` |
| 12 | **Sparklines** on the stat cards | **P2** | `web/` |
| 13 | **Station metadata** line (location, elevation, height AGL) | **P2** | `web/` |
| 14 | **About / footer** — who runs it, update cadence, repo link | **P2** | `web/` |
| 15 | **SEO / OG** meta + current temp in `<title>` | **P2** | `web/` |
| 16 | Feels-like, records strip, chart auto-refresh, a11y table | **P3** | `web/` |

---

## P0 — credibility bugs

### 1. The temperature shown is wrong

Live API right now returns `temp_c: 27.8`, `dewpoint 13.3`, `humidity 41%` on an
August evening in Skerries. This is the BMP085/HTU21D self-heat issue documented
in [CLAUDE.md](CLAUDE.md) "Gotchas" — the air board bakes ~10 °C when it sits near
the Pi. A public page showing 28 °C when it's ~17 °C outside is the first thing a
visitor notices and the reason they never come back.

**Fix (not a `web/` change):** ship the DS18B20 as the air-temp source —
`calibration.air_temp_source: auto` in `config.yaml` on the Pi, driver at
`pi/src/weatherstation/sensors/ds18b20.py`. Confirm the Supabase `temp_c` /
`dewpoint_c` values drop to something plausible before doing any of the UI work
below — everything else is decoration on a broken headline number.

### 2. `updated —` placeholder looks broken

The temp card renders a literal `updated —` server-side
([CurrentConditions.astro:99-101](web/src/components/CurrentConditions.astro#L99-L101))
until the client script replaces it. It's also redundant with the global status
line ("Last updated 27 Aug, 17:49 · 2m ago").

**Fix:** delete the per-card `#updated-label` paragraph and the code in the
refresh script that writes to it. The status line is the single source of "how
fresh is this".

---

## P1 — headline improvements

### 3. Temp / gust / pressure high–low for today

Every weather site shows the day's range. Add beneath the temperature value:

```
17.4 °C
H 21.2°  ·  L 12.8°   (today)
Dewpoint 13.3 °C
```

Same treatment for **Wind** (max gust today) and **Pressure** (24h high/low, or
just the trend arrow from #5).

- "Today" = since local midnight **Europe/Dublin**. Label it `(today)` so a
  visitor at 00:30 isn't confused by a tiny range.
- **Cheap path:** compute min/max client-side from `/api/history?range=24h`,
  which the History section already fetches — the raw 24h rows are returned
  unbucketed ([supabase.ts:64](web/src/lib/supabase.ts#L64)). Filter to
  today-local, `Math.min/max`.
- **Better path:** a Postgres RPC / view returning `temp_min_today`,
  `temp_max_today`, `gust_max_today`, `rain_today`, `pressure_min_24h`,
  `pressure_max_24h`, `pressure_3h_ago`. Add it to
  [docs/supabase-retention.sql](docs/supabase-retention.sql) alongside the
  rollup work, expose via a new `/api/summary` route, fetch once on load and on
  the 45s refresh. Preferred once the table has real history — see the
  "pulling every raw row" caveat in [TODO.md](TODO.md) §2.

### 4. Wind in km/h (primary), plus m/s and Beaufort

Ireland thinks in km/h; Met Éireann publishes km/h. Skerries is a sailing town,
so Beaufort (and possibly knots) genuinely matter to the audience.

Current card shows only `0.0 m/s` / `gust 0.1 m/s · SW`
([CurrentConditions.astro:136-143](web/src/components/CurrentConditions.astro#L136-L143)).
Target:

```
Wind   11 km/h   (3.1 m/s)
       Force 2 · gusting 18 km/h · SW
```

- `km/h = m/s * 3.6`; `kn = m/s * 1.943844`. Beaufort: standard 0–12 band table
  on `m/s` (0–0.5, 0.5–1.5, 1.5–3.3, 3.3–5.5, …). Put helpers in
  [web/src/lib/format.ts](web/src/lib/format.ts) next to `degToCompass`.
- Apply the same conversion in the refresh script's `FIELD_UNITS` map
  ([CurrentConditions.astro:179-187](web/src/components/CurrentConditions.astro#L179-L187))
  and in the wind rose / new wind chart axis labels.
- **Stretch:** a unit toggle (m/s · km/h · kn · bft) persisted to `localStorage`,
  same pattern as the theme toggle in
  [Layout.astro:43-58](web/src/layouts/Layout.astro#L43-L58). km/h-primary alone
  covers most visitors; the toggle is nice-to-have.

### 5. Pressure trend arrow

A barometer reading with no trend is close to useless to a lay reader —
rising / steady / falling is the actual signal. The tides card already does
exactly this (`status.trend`,
[TidesSection.astro:31](web/src/components/TidesSection.astro#L31)).

Add to the pressure card: `↑ rising 1.2 hPa / 3h`, `→ steady`, `↓ falling`.
Compute from `pressure_msl_hpa` now vs ~3h ago (from the 24h history rows, or the
`/api/summary` RPC in #3). Threshold ~±0.5 hPa/3h for "steady".

### 6. Rain: "today" total, not raw interval

"Rain (interval)" showing `0.0 mm`
([CurrentConditions.astro:164-174](web/src/components/CurrentConditions.astro#L164-L174))
means nothing to a visitor — interval of what? The per-60s tip count has no place
on a public page.

Target card:

```
Rain today   2.4 mm
Last hour 0.0 mm  ·  Last 24h 3.1 mm
```

All three are sums of `rain_mm` over the window (`rain_mm` accumulates per
archive record; `bucketHourly` already sums rather than averages it —
[supabase.ts:95-97](web/src/lib/supabase.ts#L95-L97)). Same data-source choice as
#3 (client-side from 24h rows, or `/api/summary`).

### 7. Wind speed/gust time-series chart

The History section has temp/humidity/pressure, rain, and a wind rose — but no
wind speed over time, which is the chart a weather enthusiast opens first. Add a
fourth card to `RangeCharts`
([HistoryCharts.tsx:154-196](web/src/components/HistoryCharts.tsx#L154-L196)):
two line series (`wind_speed_ms`, `wind_gust_ms`), axis in km/h per #4,
`showSymbol: false`, `smooth: true` like the others. Optionally overlay direction
as a faint scatter on a second axis.

---

## P2 — charts, layout, context

### 8. Wind rose should show frequency, not average speed

`windRoseOption` plots **average speed per direction**
([HistoryCharts.tsx:120-152](web/src/components/HistoryCharts.tsx#L120-L152)). One
gust from an otherwise-calm sector makes that sector's petal huge. A real wind
rose shows **how often** the wind blew from each sector, usually stacked by speed
band.

Rework: bucket rows into the 16 compass sectors × N speed bands (e.g. calm /
<10 / 10–20 / 20–30 / 30+ km/h). Petal length = % of observations in that sector;
`stack` the bands with a sequential colour ramp; legend = speed bands. ECharts
polar `bar` supports `stack`.

### 9. Merge the two wind cards

The "Wind" card already shows direction (compass label + degrees). The separate
"Wind Direction" card
([CurrentConditions.astro:146-162](web/src/components/CurrentConditions.astro#L146-L162))
repeats it with the animated compass. Collapse to one wider card: animated
compass on the left, speed / gust / Beaufort / direction stacked on the right.
Keeps the nice needle rotation
([renderCompass](web/src/components/CurrentConditions.astro#L25), and the
`#Pointer` `setAttribute` refresh) without the duplication. Frees a grid slot for
a "feels like" or records card later.

### 10. Per-range x-axis formatting

All three ranges share one formatter (`month, day, hour` —
[HistoryCharts.tsx:69-72](web/src/components/HistoryCharts.tsx#L69-L72) and
[:104-107](web/src/components/HistoryCharts.tsx#L104-L107)). On the 24h view the
axis is cluttered with repeated "Aug 27". Pass the active `range` into the option
builders and switch: 24h → `HH:mm`, 7d → `EEE HH:mm` or `d MMM HH:mm`, 30d →
`d MMM`.

### 11. Split the combined chart

Temp + humidity + pressure on one dual-axis chart
([HistoryCharts.tsx:57-92](web/src/components/HistoryCharts.tsx#L57-L92)) is
cramped on mobile and the `°C / %` axis name is awkward. Minimum: give pressure
its own chart. Better: three stacked charts sharing an x-axis with linked
tooltips (ECharts `axisPointer.link` + `connect`, or a shared `dataZoom`).

### 12. Sparklines on the stat cards

ECharts is already bundled ([EChart.tsx](web/src/components/EChart.tsx)). A 24h
micro-trend line under each big number (temp, pressure, wind) makes the top of
the page feel alive without scrolling to History. Feed from the same 24h rows as
#3. Keep them tiny: no axes, no grid, ~40px tall, one line.

### 13. Station metadata line

The title says "Skerries", the tides card says "Balbriggan", the kit is
physically at Holmpatrick ([TODO.md](TODO.md) §3). Add a small muted line under
the `<h1>` or in the status row:

```
Skerries, Co. Dublin · 53.58°N 6.11°W · sensors ~2 m AGL, XX m ASL · readings every 60s
```

Fill in the real lat/long/elevation. A tiny static map image is a nice touch but
optional.

### 14. About / footer

The page is on a public domain with no author, no explanation, no repo link. Add
a footer in [Layout.astro](web/src/layouts/Layout.astro):

```
Raspberry Pi weather station built by Dermot & son in Dublin.
Data every 60s · open source: github.com/ddools/mipi-weather-station
```

Adds credibility and charm; also satisfies the MIT/attribution spirit and the
"README screenshots" energy in [TODO.md](TODO.md) §5.

### 15. SEO / social meta

[Layout.astro](web/src/layouts/Layout.astro) has no `<meta name="description">`,
no Open Graph / Twitter card tags, no OG image. For a public site worth having.
Also: put the current temperature in the tab title —
`17° · Skerries Weather` — patched client-side in the refresh script for
glanceability.

---

## P3 — nice to have

- **Feels-like / apparent temperature** (wind chill + humidity) on the temp card.
- **Records strip**: "Warmest this month 24 °C · Max gust 47 km/h · Wettest day
  12 mm" — trivial once the `/api/summary` RPC exists.
- **Charts auto-refresh** — only the current-conditions cards poll today; the
  history charts freeze after load. A 5-min `setInterval` re-fetch on the active
  range would do it.
- **Accessibility** — ECharts canvases are invisible to screen readers. Add an
  `aria-label` summary or a visually-hidden `<table>` per chart.
- **Humidity card is bare** — move dewpoint here, or add a comfort descriptor.

---

## Suggested sequence

1. **#1** — fix the temperature source on the Pi. Nothing else matters while the
   headline number is 10° off. (Blocks nothing else technically, but do it first.)
2. **#2** — delete the `updated —` placeholder. Five minutes.
3. **#3 + #5 + #6** — one pass over `CurrentConditions.astro`: today's high/low,
   pressure trend, rain-today. Decide client-side-from-24h vs `/api/summary` RPC
   up front (RPC preferred; put the SQL in
   [docs/supabase-retention.sql](docs/supabase-retention.sql)).
4. **#4 + #9** — wind: km/h + Beaufort, and merge the two wind cards in the same
   edit.
5. **#7 + #8** — wind time-series chart, and fix the wind rose to frequency.
6. **#10 + #11** — chart axis formatting and splitting the combined chart.
7. **#13 + #14 + #15** — metadata line, footer, SEO. Cosmetic, low risk, good
   for the README screenshots.
8. **#12 + #16** — sparklines, records, feels-like, a11y.

## Notes / constraints

- Everything must still build in CI with dummy `PUBLIC_SUPABASE_*` env
  ([TODO.md](TODO.md) §5) — keep live-data paths at request time, not build time.
- New `/api/*` routes need `export const prerender = false` (see
  [web/src/pages/api/history.ts](web/src/pages/api/history.ts)).
- shadcn `CardHeader` is `grid` by default — need `flex` before `flex-row` for
  icon+title rows ([TODO.md](TODO.md) §2, Meteocons note).
- Don't pull 30d of raw rows for new aggregates — reuse / extend the hourly
  rollup plan in [docs/supabase-retention.sql](docs/supabase-retention.sql).
- Benchmark targets still open ([TODO.md](TODO.md) §2): live value updates within
  60s of a new reading; mobile Lighthouse ≥ 90. Re-check after this work.
