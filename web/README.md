# Web: standalone dashboard site (Astro + shadcn/ui, on Vercel)

The public dashboard, live at **[weather.dermotdooley.com](https://weather.dermotdooley.com)**
(a dedicated domain may come later). This `web/` directory is the whole deployable
Astro project: Vercel project `mipi-weather`, Root Directory `web`, production
branch `main` — every merge to `main` deploys. UI components are **shadcn/ui**
(React + Tailwind + Radix), mounted as Astro React islands.

## Local development

Node ≥22 and **pnpm** (the version is pinned by `packageManager` in `package.json`).

```bash
pnpm install
cp .env.example .env    # PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY
pnpm dev                # or `astro dev --background` (see AGENTS.md)
pnpm check              # astro check (TypeScript) — CI runs this
pnpm build              # CI runs this too
```

The same two variables are set on the Vercel project (Production + Preview). The
key is the Supabase **publishable** key: safe in the browser, since RLS limits it
to `SELECT`. The secret key never goes near this project.

pnpm 11 skips dependency build scripts unless they're listed under `allowBuilds`
in `pnpm-workspace.yaml` (esbuild is); a new dependency that needs one fails
install with `ERR_PNPM_IGNORED_BUILDS`.

## How the page is built

- `src/pages/index.astro` is **prerendered** — a static shell. Anything that
  depends on "now" (current readings, tides, sun, moon, pollen, forecast, bathing
  water) is a **server island** (`server:defer`), rendered per request, with a
  `Skeleton` fallback sized to avoid layout shift. A plain component's
  frontmatter would run once, at build time.
- `src/pages/api/*.ts` (`prerender = false`) — `current`, `summary`, `recent`,
  `history`, `tides`, `health`: thin Supabase / Open-Meteo queries returning JSON,
  which the islands poll to stay live (`/api/current` every 45 s).
- Charts: **ECharts** in the `HistoryCharts` client island — temperature,
  pressure, humidity, wind, rain, air quality, wind rose. Range tabs (shadcn
  `Tabs`): 24h / 7d / 30d / All time.
- Rain radar: `RainRadar.tsx`, a **Leaflet** client island (`client:visible`)
  beside Tides in the *Now* tab. Frames + tiles from the free, keyless
  [RainViewer](https://www.rainviewer.com/api/weather-maps-api.html) Weather Maps
  API (past 2 h + short nowcast), basemap from keyless Esri Gray Canvas.
  Attribution to RainViewer + Esri is required and shown on/under the map.
- Light/dark: a `dark` class on `<html>`, set before paint from a `theme` cookie
  shared with the other dermotdooley.com sites (see `Layout.astro`).

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
each topped up from raw rows for the hours the rollup hasn't reached. Both are
live on the project (checked 2026-09-26). If they're ever missing, `lib/supabase.ts`
falls back to bucketing raw rows, capped at the newest 20k (~14 days).

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
| `lib/bathing.ts` | **EPA** Bathing Water API (`data.epa.ie/bw/api/v1`, CC BY 4.0, attribution required — credited in the site footer, `Layout.astro`) | Bathing water — beach record + latest sample cached 6 h, active alerts 30 min. See [docs/bathing-water.md](../docs/bathing-water.md) |

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
