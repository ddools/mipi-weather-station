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
     wind rose (polar bar), gauge dials. Range tabs (shadcn `Tabs`): 24h / 7d / 30d.
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
For 7d/30d ranges, downsample server-side in the API route (group by hour) to keep
payloads small.

## Dashboard tabs (added 2026-09-01)

`index.astro` is split into three tabs via `DashboardTabs.astro` (an Astro
wrapper with named slots — not the shadcn React `Tabs`, which can't take server
islands as children). A small inline script toggles panel `hidden`, syncs the
URL hash (`#now` / `#history` / `#ahead`) and remembers the last tab in
`localStorage`. All three panels are always in the DOM, so server islands still
stream and SEO is unaffected. Plan + rationale: [`docs/dashboard-tabs.md`](../docs/dashboard-tabs.md).

A **glance hero** (`NowHero.astro`) renders **above** the tab bar, so it stays
visible on every tab: big temp, sky icon + condition, feels-like, H/L,
wind/humidity/pressure/rain, Live/Delayed/Offline; day/night gradient. Its own
compact poll loop (`/api/current` 45 s, `/api/summary` 5 min) keeps it live. The
sky icon/condition come from Open-Meteo `current` (`lib/forecast.ts:getCurrentSky`,
15-min memo); `SkyIcon.astro` maps the basename (day + night variants) to a
Meteocons glyph. The old status bar was removed from `CurrentConditions` — the
hero owns the badge now.

The tab bar carries a per-tab inline icon (activity / line-chart / calendar) and
`text-base` labels.

- **Now in detail** — the detail cards (temp, humidity, pressure, wind, rain
  today, air quality), then `TidesSection` + rain radar. The Wind card carries a
  `WindTrend` island: it polls `/api/recent?minutes=15` every 30 s and shows a
  last-5-minutes read (picking up / easing / steady, plus veering/backing
  direction) as a dual wind+gust sparkline.
- **History** — `HistoryCharts` (`client:only="react"` — SSR added nothing but
  Radix hydration mismatches; `EChart.tsx` defers `init` until its container has
  a size), `RecordsSection`, `StationHealth`.
- **Ahead** — `ForecastSection` (5-day) + Sun / Moon / Pollen.

## External data sources (all Open-Meteo, free, no key)

| Lib | API | Used by |
|-----|-----|---------|
| `lib/tides.ts` | marine-api (`sea_level_height_msl`) | Tides |
| `lib/pollen.ts` | air-quality-api (CAMS pollen) | Pollen |
| `lib/forecast.ts` | forecast (`/v1/forecast` daily) | 5-day forecast — 30-min in-memory cache |
| `lib/forecast.ts:getCurrentSky` | forecast (`/v1/forecast` `current`) | Now-tab hero sky icon + condition — 15-min in-memory cache |
