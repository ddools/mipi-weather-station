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
     `/api/current` every 60 s.
   - `src/pages/api/current.ts` and `src/pages/api/history.ts` with
     `export const prerender = false` — thin Supabase queries returning JSON.
   - Charts: **ECharts** client island — temp/pressure/humidity lines, rain bars,
     wind rose (polar bar), gauge dials. Range tabs (shadcn `Tabs`): 24h / 7d / 30d.
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
