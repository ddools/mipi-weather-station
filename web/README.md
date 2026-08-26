# Web: /weather page (Astro on Vercel)

The dashboard lives in the main dermotdooley.com Astro repo; this folder holds the
reusable pieces and integration notes.

## Setup in the site repo
1. `npx astro add vercel` (SSR adapter for the dynamic bits).
2. Env vars in Vercel: `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`
   (anon key is safe client-side — RLS allows SELECT only).
3. Page structure:
   - `src/pages/weather.astro` — static shell, hero card, grid layout.
   - Live panel as a **server island** (`<CurrentConditions server:defer />`) that
     fetches the newest row server-side; a small client timer re-fetches
     `/api/current` every 60 s.
   - `src/pages/api/current.ts` and `src/pages/api/history.ts` with
     `export const prerender = false` — thin Supabase queries returning JSON.
   - Charts: **ECharts** client island — temp/pressure/humidity lines, rain bars,
     wind rose (polar bar), gauge dials. Range tabs: 24h / 7d / 30d.
4. Responsive: CSS grid, multi-column desktop → single column mobile; dark mode via
   `prefers-color-scheme`.

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
