# Web: standalone dashboard site (Astro + shadcn/ui, on Vercel)

**Changed 2026-08-27:** this is now a standalone site on its own domain (TBD —
not yet registered), not a `/weather` page inside the dermotdooley.com repo. This
`web/` directory is the real, deployable Astro project — its own Vercel project,
not integration notes for elsewhere. UI components use **shadcn/ui**.

## Setup
1. Scaffold: `npm create astro@latest .` (run inside `web/`).
2. Add adapters: `npx astro add vercel` (SSR for the dynamic bits), `npx astro add
   react` (shadcn/ui components are React, mounted as Astro islands).
3. `npx shadcn init` — sets up Tailwind + the component registry config. Add
   components as needed, e.g. `npx shadcn add card tabs button` — each vendors
   the component source into `src/components/ui/`, so it's yours to edit.
4. Env vars in Vercel: `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`
   (anon key is safe client-side — RLS allows SELECT only).
5. Page structure:
   - `src/pages/index.astro` — static shell, hero card, grid layout.
   - Live panel as a **server island** (`<CurrentConditions server:defer />`) that
     fetches the newest row server-side; a small client timer re-fetches
     `/api/current` every 60 s. It owns the whole top block: three rows on desktop
     — temp/pressure/humidity, then wind + tides, then rain + rain radar — so
     `TidesSection` and the `RainRadar` island render nested inside it (that's
     why the radar's `client:visible` island sits within a server island).
   - `src/pages/api/current.ts` and `src/pages/api/history.ts` with
     `export const prerender = false` — thin Supabase queries returning JSON.
   - Charts: **ECharts** client island — temp/pressure/humidity lines, rain bars,
     wind rose (polar bar), gauge dials. Range tabs (shadcn `Tabs`): 24h / 7d / 30d / All time.
   - Rain radar: `RainRadar.tsx` **Leaflet** client island (`client:visible`),
     rendered in the third row of `CurrentConditions` next to the rain card.
     Frames + tiles from the free, keyless [RainViewer](https://www.rainviewer.com/api/weather-maps-api.html)
     Weather Maps API (past 2 h + short nowcast), basemap from keyless Esri Gray
     Canvas. Attribution to RainViewer + Esri is required and shown on/under the
     map. `leaflet` + `@types/leaflet` are the only added deps.
6. Responsive: CSS grid, multi-column desktop → single column mobile; dark mode
   via shadcn's `ThemeProvider` + CSS variable pattern.
7. Once the domain is decided: register it, add as a custom domain on the Vercel
   project, point DNS per Vercel's instructions.

## Example history query (PostgREST)
```
GET {SUPABASE_URL}/rest/v1/readings
    ?select=recorded_at,temp_c,pressure_msl_hpa,humidity,rain_mm,wind_speed_ms,wind_dir_deg
    &recorded_at=gte.2026-08-25T00:00:00Z
    &order=recorded_at.asc
apikey: {ANON_KEY}
```
7d/30d read hourly averages from `readings_hourly` and "All time" reads daily
averages from the `readings_daily` view (both from `docs/supabase-retention.sql`),
each topped up from raw rows for the hours the rollup hasn't reached. Until that
SQL is run they fall back to bucketing raw rows in `lib/supabase.ts`, capped at
the newest 20k (~14 days).

## Dashboard tabs (added 2026-09-01)

`index.astro` is split into three tabs via `DashboardTabs.astro` (an Astro
wrapper with named slots — not the shadcn React `Tabs`, which can't take server
islands as children). A small inline script toggles panel `hidden`, syncs the
URL hash (`#now` / `#history` / `#ahead`) and remembers the last tab in
`localStorage`. All three panels are always in the DOM, so server islands still
stream and SEO is unaffected. Plan + rationale: [`docs/dashboard-tabs.md`](../docs/dashboard-tabs.md).

A **glance hero** (`NowHero.astro`) renders **above** the tab bar, so it stays
visible on every tab: big temp, sky icon + condition, feels-like, H/L,
wind/humidity/pressure/rain (2×2 below the temperature until `lg`, four across
beside it from there), and a status chip — "Live · last reading 40s ago", ticking
every 5 s, tinted amber once the newest reading is over 3 min old ("Delayed") and
red past 15 min ("Station offline"); day/night gradient. Its own compact poll
loop (`/api/current` 45 s, `/api/summary` 5 min) keeps it live. The sky
icon/condition come from Open-Meteo `current` (`lib/forecast.ts:getCurrentSky`,
15-min memo); `SkyIcon.astro` maps the basename (day + night variants) to a
Meteocons glyph. The old status bar was removed from `CurrentConditions` — the
hero owns the badge now.

**Icons.** Card headers use **Lucide** (`lucide-react`, rendered to static SVG
in `.astro` files — no JS shipped), all at `CARD_ICON` (`lib/utils.ts`: 20 px,
muted). **Meteocons** are kept only for weather conditions (hero + forecast),
served from `public/weather-icons/` — Nord-recoloured copies made by
`pnpm weather-icons` (`scripts/generate-weather-icons.mjs`, transforms in
`lib/meteocons.js`). Each glyph has a still (one frozen frame; stripping the
animation outright hides the raindrops) and a half-speed `-animated` copy. Only
the hero uses the animated one, via `<picture>` with a
`prefers-reduced-motion` still fallback. Re-run the script if `lib/forecast.ts`
gains an icon name.

**Countdowns** ("in 2h 41m", "tomorrow", "in 5 days") all come from
`lib/format.ts:untilLabel` — hours and minutes under a day, then Dublin calendar
days. Server-rendered text is only right at render time, so any element with
`data-until="<ISO>"` is re-rendered in the browser every 15 s by
`lib/live-times.ts` (started from `Layout.astro`).

The tab bar carries a per-tab inline icon (activity / line-chart / calendar) and
`text-base` labels.

- **Now in detail** — the detail cards in one grid: Temperature and Wind first
  (full width on tablet, side by side on desktop), then the compact cards —
  Rain, Pressure, Humidity, Air quality — two or four across (`sm:order-1` moves
  Rain down among them; its running-total sparkline is dropped on a dry day).
  Then `TidesSection` with `BathingSection` (EPA bathing water) stacked under it,
  beside the rain radar. Both are `server:defer`: anything that depends on "now"
  must be a server island, or it is frozen at build time with the static shell
  (Tides, Sun, Moon and Pollen were, until 2026-09-25 — the tide card showed a
  build-time countdown hours out of date). The Wind card carries a
  `WindTrend` island: it polls `/api/recent?minutes=15` every 30 s and shows a
  last-5-minutes read (picking up / easing / steady, plus veering/backing
  direction) as a dual wind+gust sparkline.
- **History** — `HistoryCharts` (`client:only="react"` — SSR added nothing but
  Radix hydration mismatches; `EChart.tsx` defers `init` until its container has
  a size), `RecordsSection`, `StationHealth`.
- **Ahead** — `ForecastSection` (5-day) + Sun / Moon / Pollen, all
  `server:defer`. Pollen collapses to its header row when nothing is in the air.

Each tab panel starts with a visually-hidden `<h2>` naming it, so the document
outline matches the tabs.

## External data sources (free, no key)

| Lib | API | Used by |
|-----|-----|---------|
| `lib/tides.ts` | marine-api (`sea_level_height_msl`) | Tides |
| `lib/pollen.ts` | air-quality-api (CAMS pollen) | Pollen |
| `lib/forecast.ts` | forecast (`/v1/forecast` daily) | 5-day forecast — 30-min in-memory cache |
| `lib/forecast.ts:getCurrentSky` | forecast (`/v1/forecast` `current`) | Now-tab hero sky icon + condition — 15-min in-memory cache |
| `lib/bathing.ts` | **EPA** Bathing Water API (`data.epa.ie/bw/api/v1`, CC BY 4.0, attribution required but **not currently shown** anywhere on the site) | Bathing water — beach record + latest sample cached 6 h, active alerts 30 min. See [docs/bathing-water.md](../docs/bathing-water.md) |

Everything above is Open-Meteo except the EPA row.

## PWA (added 2026-09-08)

The dashboard is installable and works offline. Four pieces:

| File | Role |
|------|------|
| `public/manifest.webmanifest` | Name, `display: standalone`, `start_url: /`, theme/background colours, icon set |
| `public/icons/` | 192/512 `any` + 192/512 `maskable` + a 180px `apple-touch-icon`, all generated from `public/favicon.svg` (dark-slate ground, light windmill, so one icon reads on any home screen) |
| `public/sw.js` | The service worker — caching only, no push or background sync |
| `src/components/ServiceWorker.astro` | Registration, mounted from `Layout.astro` |
| `src/pages/offline.astro` | Prerendered fallback the worker serves when a navigation fails and nothing is cached |

**Caching strategy**, by request kind:

| Kind | Strategy | Why |
|------|----------|-----|
| Navigations | network-first → last page seen → `/offline` | The dashboard must never show a stale page while online |
| `/api/*`, `/_server-islands/*` | network-first → last good response | An offline launch still shows the last readings it saw |
| `/_astro/*` | cache-first | Filenames are content-hashed, so they're immutable |
| Other same-origin static | stale-while-revalidate | Icons, favicons, manifest |
| Cross-origin | not intercepted | Open-Meteo, RainViewer frames, Esri basemap tiles — caching third-party tiles would bloat storage for no gain |

Two things to know before editing it:

- **The worker only registers from a production build.** `ServiceWorker.astro`
  branches on `import.meta.env.PROD`; under `astro dev` it renders the opposite
  script, which unregisters any worker a previous production visit on the same
  origin left behind and drops its `ws-*` caches. A worker in front of the dev
  server would serve cached build output over HMR. To exercise it locally, run
  `astro build` and serve `.vercel/output/static`.
- **Bump `CACHE_VERSION` in `public/sw.js` whenever the strategy changes.** It
  names the caches, and `activate` deletes every cache not in `CURRENT_CACHES`.
  Changing the code without bumping it leaves the old entries in place.

Regenerate the icons after changing `public/favicon.svg`:

```bash
pnpm icons      # needs rsvg-convert (brew install librsvg)
```

The same script renders `public/og.png`, the 1200×630 link-preview image
(`og:image` / `twitter:image`, `summary_large_image` card, set in `Layout.astro`).
