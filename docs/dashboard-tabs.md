# Dashboard — three-tab restructure

Plan for splitting the single-scroll dashboard into **Now / History / Ahead**,
adding a **5-day forecast** to *Ahead*, and a **last-5-minute wind trend** to the
Wind tile in *Now*.

Status: **implemented on branch `dashboard-tabs`** 2026-09-01 (phases 1–4; smoke-
tested in a headless browser — tabs switch, forecast + wind-trend render, no
console errors). Not yet deployed. Written 2026-09-01.

---

## 1. Goal

Today [`web/src/pages/index.astro`](../web/src/pages/index.astro) stacks four
blocks in one long scroll:

1. [`CurrentConditions.astro`](../web/src/components/CurrentConditions.astro) —
   live status bar + 5 metric cards + air quality, **and** (bundled inside it)
   Sun, Moon, Pollen, Tides and the rain radar.
2. [`StationHealth.astro`](../web/src/components/StationHealth.astro)
3. [`RecordsSection.astro`](../web/src/components/RecordsSection.astro)
4. [`HistoryCharts.tsx`](../web/src/components/HistoryCharts.tsx) — 24h / 7d / 30d
   ECharts + wind rose.

Split it into three tabs so each answers one question:

| Tab | Question | Default |
|-----|----------|---------|
| **Now** | What is it doing outside right now? | ✅ landing tab |
| **History** | What has it done? | |
| **Ahead** | What is coming? | |

Tab labels in the UI: `Now` · `History` · `Ahead`. (The user's words were
"now / past records / future" — same three buckets, shorter labels.)

---

## 2. Tile distribution

### Always on — above the tabs
| Tile | Component | Notes |
|------|-----------|-------|
| **Glance hero** — big temp + sky icon/condition, feels-like, H/L today, wind/humidity/pressure/rain, Live/Delayed/Offline status; day/night gradient | `NowHero.astro` (own `server:defer` island, rendered above `<DashboardTabs>` so it shows on every tab) | added 2026-09-01, hoisted above the tabs 2026-09-01. Sky icon + condition from Open-Meteo `current` ([`lib/forecast.ts:getCurrentSky`](../web/src/lib/forecast.ts), 15-min memo). Has its own compact poll loop (`/api/current` 45 s, `/api/summary` 5 min). The old status bar was removed from `CurrentConditions` — the hero owns the badge now. |

### → Now in detail  *(tab label changed from "Now" 2026-09-01)*
| Temperature — value, ±/h trend, feels-like, dew point, sparkline | CurrentConditions | keep the "H / L today" line here |
| Humidity — value, trend, sparkline | CurrentConditions | |
| Pressure — value + 3h trend, sparkline | CurrentConditions | |
| **Wind — compass, speed, gust, direction + NEW 5-min trend** | CurrentConditions | see §4b |
| Rain today (today / last hour / 24h) | CurrentConditions | "today so far", but expected in the glance |
| Air quality (conditional on `air_quality`) | CurrentConditions | |
| **Tides — current height + state, next high/low, curve** | TidesSection | kept in Now (leads with a live height); already visual via its inline SVG wave |
| Rain radar (Leaflet + RainViewer nowcast) | RainRadar | the "is it about to rain" tile; sits beside Tides on `lg` |

### → History
| Tile | Currently in | Notes |
|------|--------------|-------|
| History charts — 24h / 7d / 30d: temp+dewpoint, pressure, humidity, wind+gust, rain, air quality, wind rose | HistoryCharts | the range switch stays as a sub-toggle inside this tab |
| Records — all-time + "month so far" | RecordsSection | |
| Station health — completeness, uptime, largest gap, totals, collecting since | StationHealth | it describes the data record itself |
| *(optional)* "Today so far" strip — H/L temp, max gust, rain today | derived from `getTodaySummary()` | small summary row at the top of the tab |

### → Ahead
| Tile | Currently in | Notes |
|------|--------------|-------|
| **5-day forecast** | NEW — `ForecastSection.astro` | see §4a |
| Sun — next sunrise/sunset, daylight, Δ vs yesterday | SunSection | |
| Moon — phase, next full / new | MoonSection | |
| Pollen — CAMS forecast (grains/m³) | PollenSection | it is a forecast model |

*(Tides moved to **Now** 2026-09-01 — a live tide height belongs in the glance.)*

---

## 3. Technical architecture

### 3a. Tab shell — `web/src/components/DashboardTabs.astro` (new)

React islands can't take Astro server islands (`server:defer`) as children, so
**do not** use the shadcn React `<Tabs>` at the top level. Use an Astro wrapper
with **named slots** — slots compose fine with both server and client islands.

```astro
---
// DashboardTabs.astro
const tabs = [
  { id: "now", label: "Now" },
  { id: "history", label: "History" },
  { id: "ahead", label: "Ahead" },
];
---
<div id="dashboard">
  <div role="tablist" aria-label="Dashboard views"
       class="sticky top-0 z-10 -mx-4 mb-8 flex gap-1 border-b border-border
              bg-background/80 px-4 backdrop-blur sm:mx-0 sm:px-0">
    {tabs.map((t, i) => (
      <button role="tab" id={`tab-${t.id}`} data-tab={t.id}
              aria-controls={`panel-${t.id}`}
              aria-selected={i === 0 ? "true" : "false"}
              tabindex={i === 0 ? "0" : "-1"}
              class="-mb-px border-b-2 px-3 py-2 text-sm font-medium
                     aria-selected:border-foreground aria-selected:text-foreground
                     border-transparent text-muted-foreground hover:text-foreground">
        {t.label}
      </button>
    ))}
  </div>

  {tabs.map((t, i) => (
    <div role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`}
         data-panel={t.id} hidden={i !== 0}>
      <slot name={t.id} />
    </div>
  ))}
</div>

<script>
  const root = document.getElementById("dashboard")!;
  const tabsEls = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = new Map(
    [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')].map((p) => [p.dataset.panel!, p]),
  );

  function activate(id: string, focus = false) {
    if (!panels.has(id)) return;
    for (const tab of tabsEls) {
      const on = tab.dataset.tab === id;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    for (const [pid, panel] of panels) panel.hidden = pid !== id;
    if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
    // ECharts in the History panel was hidden with a 0px container — refit.
    window.dispatchEvent(new Event("resize"));
  }

  tabsEls.forEach((tab) => tab.addEventListener("click", () => activate(tab.dataset.tab!)));

  // Roving arrow-key nav across the tablist.
  root.querySelector('[role="tablist"]')!.addEventListener("keydown", (e) => {
    const ev = e as KeyboardEvent;
    const i = tabsEls.findIndex((t) => t.getAttribute("aria-selected") === "true");
    if (ev.key === "ArrowRight") activate(tabsEls[(i + 1) % tabsEls.length].dataset.tab!, true);
    if (ev.key === "ArrowLeft") activate(tabsEls[(i - 1 + tabsEls.length) % tabsEls.length].dataset.tab!, true);
  });

  // Deep-link + restore.
  const initial = location.hash.slice(1) || localStorage.getItem("dashboard-tab") || "now";
  activate(initial);
  window.addEventListener("hashchange", () => activate(location.hash.slice(1) || "now"));
  root.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
    if (t) localStorage.setItem("dashboard-tab", t.dataset.tab!);
  });
</script>
```

Notes:
- All three panels render into the DOM on first load (server islands still
  stream in even while `hidden`) → SEO / OG tags unaffected, the live
  `document.title` updater keeps working.
- Total fetch work on load is unchanged from today. If per-tab lazy loading
  becomes worth it, see §7 "Option B: routes".

### 3b. `CurrentConditions.astro` refactor

Pull the non-"now" pieces out. Remove these imports + their render sites:
`SunSection`, `MoonSection`, `PollenSection`, `TidesSection`. Keep the status
bar, the 5 metric cards, and the air-quality card. `RainRadar` moves to the page
(rendered in the `now` slot next to `<CurrentConditions>`), not inside it.

Result: the bottom two grids in
[`CurrentConditions.astro`](../web/src/components/CurrentConditions.astro)
collapse to just Pressure + Humidity (+ Air quality when present). The
`getLatestReading()` / `getTodaySummary()` fetch and the whole `<script>` block
stay as-is (plus the wind-trend additions in §4b).

### 3c. `index.astro` composition

```astro
---
import Layout from "@/layouts/Layout.astro";
import DashboardTabs from "@/components/DashboardTabs.astro";
import CurrentConditions from "@/components/CurrentConditions.astro";
import { RainRadar } from "@/components/RainRadar";
import StationHealth from "@/components/StationHealth.astro";
import RecordsSection from "@/components/RecordsSection.astro";
import { HistoryCharts } from "@/components/HistoryCharts";
import ForecastSection from "@/components/ForecastSection.astro";
import SunSection from "@/components/SunSection.astro";
import MoonSection from "@/components/MoonSection.astro";
import TidesSection from "@/components/TidesSection.astro";
import PollenSection from "@/components/PollenSection.astro";
import { Skeleton } from "@/components/ui/skeleton";
---
<Layout>
  <DashboardTabs>
    <Fragment slot="now">
      <CurrentConditions server:defer>
        <div slot="fallback" class="space-y-4">…existing skeletons…</div>
      </CurrentConditions>
      <div class="mt-4">
        <RainRadar client:visible />
      </div>
    </Fragment>

    <Fragment slot="history">
      <section class="mb-10">
        <StationHealth server:defer>
          <Skeleton slot="fallback" className="h-40" />
        </StationHealth>
      </section>
      <section class="mb-10">
        <RecordsSection server:defer>
          <Skeleton slot="fallback" className="h-64" />
        </RecordsSection>
      </section>
      <section>
        <h2 class="mb-4 text-base font-semibold text-muted-foreground">History</h2>
        <HistoryCharts client:visible />
      </section>
    </Fragment>

    <Fragment slot="ahead">
      <section class="mb-10">
        <ForecastSection server:defer>
          <Skeleton slot="fallback" className="h-56" />
        </ForecastSection>
      </section>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SunSection />
        <MoonSection />
        <PollenSection />
      </div>
      <div class="mt-4">
        <TidesSection />
      </div>
    </Fragment>
  </DashboardTabs>
</Layout>
```

`HistoryCharts` switches from `client:load` → `client:visible`: it won't hydrate
until the History tab is shown *and* scrolled into view. `EChart.tsx` already
listens for `window.resize`, and `DashboardTabs` fires a synthetic `resize` on
every tab switch, so charts that mounted while their panel was `hidden` (0px
wide) snap to the right size on show.

### 3d. New / changed files

| File | Change |
|------|--------|
| `web/src/components/DashboardTabs.astro` | **new** — tab shell (§3a) |
| `web/src/pages/index.astro` | rewrite as slotted `DashboardTabs` (§3c) |
| `web/src/components/CurrentConditions.astro` | drop Sun/Moon/Pollen/Tides/RainRadar; add wind-trend markup (§4b) |
| `web/src/components/ForecastSection.astro` | **new** — 5-day forecast (§4a) |
| `web/src/lib/forecast.ts` | **new** — Open-Meteo daily fetch + WMO→icon map (§4a) |
| `web/src/components/WindTrend.tsx` | **new** — 5-min wind-trend island (§4b) |
| `web/src/lib/supabase.ts` | add `getRecentReadings(minutes)` (§4b) |
| `web/src/pages/api/recent.ts` | **new** — `/api/recent?minutes=15` (§4b) |
| `web/src/lib/format.ts` | add `circularMean()`, `angularDelta()`, `veerBack()` (§4b) |
| `web/src/lib/spark.ts` | **new** — extract the Catmull-Rom path builder from `Sparkline.astro` so SSR + the island share it |
| `web/README.md` | document the tabs + the two new data sources |
| `docs/sensors.md` / `CLAUDE.md` | note the new Open-Meteo forecast dependency |

---

## 4. New features

### 4a. 5-day forecast (Ahead)

**Source:** Open-Meteo forecast API — free, no key, same provider family as
[`tides.ts`](../web/src/lib/tides.ts) and [`pollen.ts`](../web/src/lib/pollen.ts).

```
GET https://api.open-meteo.com/v1/forecast
  ?latitude=53.5825&longitude=-6.1058
  &daily=weather_code,temperature_2m_max,temperature_2m_min,
         precipitation_sum,precipitation_probability_max,
         wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,
         uv_index_max,sunrise,sunset
  &timezone=Europe%2FDublin&forecast_days=5
```

Response shape: `daily.time: string[]` (`"2026-09-01"`, local dates) plus one
parallel array per field.

**`web/src/lib/forecast.ts`:**

```ts
export interface ForecastDay {
  date: string;            // ISO local date
  weekday: string;         // "Mon", "Tue" — "Today" for index 0
  icon: string;            // meteocons flat basename
  label: string;           // "Light rain", "Partly cloudy"
  tempMax: number;
  tempMin: number;
  precipMm: number;
  precipProbPct: number | null;
  windMaxKmh: number;
  gustMaxKmh: number;
  windDirDeg: number;
}

export async function getForecast(): Promise<ForecastDay[] | null>;
```

- Convert wind m/s→km/h at the edge (API can return km/h directly with
  `&wind_speed_unit=kmh` — prefer that, matches the rest of the UI).
- **WMO `weather_code` → meteocons** (icons verified present in
  `@meteocons/svg/flat/`; daily forecast → always the `-day` variants):

  | WMO codes | icon | label |
  |-----------|------|-------|
  | 0 | `clear-day` | Clear |
  | 1 | `clear-day` | Mainly clear |
  | 2 | `partly-cloudy-day` | Partly cloudy |
  | 3 | `overcast-day` | Overcast |
  | 45, 48 | `fog-day` | Fog |
  | 51, 53, 55 | `drizzle` | Drizzle |
  | 56, 57 | `sleet` | Freezing drizzle |
  | 61, 63, 65 | `rain` | Rain (light/mod/heavy by code) |
  | 66, 67 | `sleet` | Freezing rain |
  | 71, 73, 75, 77 | `snow` | Snow |
  | 80, 81, 82 | `partly-cloudy-day-rain` | Rain showers |
  | 85, 86 | `snow` | Snow showers |
  | 95 | `thunderstorms-day` | Thunderstorm |
  | 96, 99 | `thunderstorms-day-rain` | Thunderstorm + hail |

- **Cache:** module-level memo, 30-min TTL (forecast refreshes hourly upstream;
  a warm serverless instance then serves it for free). `tides.ts`/`pollen.ts`
  currently don't cache — do it here and optionally retrofit them.
- **Failure:** return `null`; the card renders "Forecast unavailable" exactly
  like `PollenSection` / `TidesSection` do.

**`web/src/components/ForecastSection.astro`** (`server:defer`): one `<Card>`, a
`grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5` of day columns — icon, weekday,
`max° / min°`, a precip line (`3 mm · 60%`), and a small wind line
(`24 km/h ↗` using `degToCompass`). Column 0 highlighted as "Today". Attribution
line: "Forecast: Open-Meteo" (their guidance asks for it), matching the
"CAMS European model via Open-Meteo" footnote already in `PollenSection`.

**Not doing (yet):** hourly forecast, "feels like" forecast, a 14-day range.
Keep it one card.

### 4b. Wind tile — last-5-minute trend (Now)

**Why:** the current Wind card shows instantaneous speed/gust/direction plus a
24h sparkline. It can't answer "is it picking up right now / is the wind
backing?" — which is the most useful short-term read for anyone outside.

**Data:** the collector archives every ~60s, so 5 min ≈ 5 samples, 15 min ≈ 15.
Pull a **15-minute window** (enough to draw a line), compute the **headline
delta over the last 5 minutes**.

- **`web/src/lib/supabase.ts`** — add:

  ```ts
  export async function getRecentReadings(minutes = 15): Promise<Reading[]> {
    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    const res = await restFetch(
      `readings?select=${READING_COLUMNS}&recorded_at=gte.${since}&order=recorded_at.asc`
    );
    if (!res.ok) throw new Error(`Supabase error ${res.status}`);
    return res.json(); // < 20 rows, no paging needed
  }
  ```

- **`web/src/pages/api/recent.ts`** — `export const prerender = false`; parse
  `?minutes=` (clamp 5–30, default 15); `Cache-Control: public, max-age=20`.

- **`web/src/lib/format.ts`** — add circular-stats helpers:

  ```ts
  export function circularMean(degs: number[]): number | null;      // vector mean
  export function angularDelta(from: number, to: number): number;   // signed, −180..180
  export function veerBack(delta: number): "veering" | "backing" | "steady";
  //   +ve (clockwise) = veering, −ve = backing, |Δ| < ~8° = steady
  ```

- **`web/src/lib/spark.ts`** — extract the Catmull-Rom `d`-string builder out of
  [`Sparkline.astro`](../web/src/components/Sparkline.astro) into
  `sparkPath(values, { width, height })` so both the SSR component and the
  client island draw identical curves. `Sparkline.astro` imports it; behaviour
  unchanged.

- **`web/src/components/WindTrend.tsx`** — small client island, mounted **inside
  the Wind card** in `CurrentConditions.astro` (client islands hydrate fine
  inside a server island). `client:load`.

  - Fetches `/api/recent?minutes=15` on mount, then every **30 s**.
  - Renders:
    - **Dual mini sparkline** (≈ 200×36): sustained wind (green `#10b981`) and
      gust (amber `#f59e0b`) over 15 min, with a faint vertical marker at −5 min.
    - **Headline**: `trend(last, fiveMinAgo, 3 /* km/h band */)` from
      `format.ts` → `"picking up"` / `"easing"` / `"steady"`, plus the numbers:
      `12 → 19 km/h` (last 5 min).
    - **Direction line**: `veerBack(angularDelta(dir5minAgo, dirNow))` →
      `"backing SW → S"` / `"veering"` / `"steady from W"`, using
      `circularMean` over each half-window to de-noise the vane.
    - **Gustiness**: `max(gust) − min(sustained)` over the window →
      `"gusty (+11 km/h)"` when the spread is large, else omitted.
  - Offline/stale (newest row > 15 min old, mirror `isStale()` in
    `CurrentConditions`) → "No recent wind data", no sparkline.
  - Reduced-motion / empty window → render just the text lines.

  SSR seed: `CurrentConditions.astro` already has `summary.spark.wind` (24h,
  48-pt) — too coarse for 5 min. Either (a) add `windRecent15m: { t, speed, gust,
  dir }[]` to `getTodaySummary()` (it already holds all 24h rows in memory —
  cheap) and pass it as the island's initial prop for a no-flash first paint, or
  (b) let the island show a one-tick skeleton. Prefer (a).

  **Alternative (no new island):** extend the existing vanilla `<script>` in
  `CurrentConditions.astro` — add a `refreshWindTrend()` on a 30 s interval that
  fetches `/api/recent` and redraws a `<polyline>` + updates `data-field` spans.
  Rejected as the primary approach: that script is already ~280 lines; a
  self-contained island is easier to reason about and test. Keep this as the
  fallback if island-in-server-island misbehaves on Vercel.

---

## 5. Data / API summary

| Endpoint | New? | Cadence (client) | Cache |
|----------|------|------------------|-------|
| `/api/current` | existing | 45 s | — |
| `/api/summary` | existing | 5 min | — |
| `/api/recent?minutes=15` | **new** | 30 s (Now tab) | `max-age=20` |
| `/api/history?range=` | existing | on tab open | — |
| Open-Meteo `/v1/forecast` | **new** (server-side) | per render | 30-min memo |

External deps added: **Open-Meteo forecast API** (already using their marine +
air-quality APIs). No new npm packages.

---

## 6. Edge cases & gotchas

- **ECharts mounted while `hidden`** → 0px container. Mitigated by
  `client:visible` on `HistoryCharts` + the synthetic `resize` on tab switch.
  Verify on a real deploy, not just `astro dev`.
- **Client island inside a server island** (`WindTrend` in `CurrentConditions`,
  `RainRadar` already does this) — supported, but confirm hydration on Vercel
  after the refactor. Fallback in §4b.
- **Server islands still fetch while their tab is hidden** — accepted (same load
  cost as today). Don't add `client:only` guards; if it matters, go to routes.
- **Deep links** — `/#history`, `/#ahead` must select the tab on load
  (handled), and `hashchange` from back/forward must too (handled).
- **`document.title`** live updater lives in `CurrentConditions` script — still
  runs because the `now` panel is always in the DOM. Fine.
- **Forecast timezone** — request with `timezone=Europe/Dublin`; `daily.time`
  values are bare local dates, compare against a Dublin-formatted "today" the
  same way `pollen.ts` does (`toLocaleString("sv-SE", { timeZone })`).
- **Wind vane noise** — a single bad vane sample can swing `angularDelta` wildly;
  always feed `circularMean` of a half-window, never raw first/last.
- **Sparse data** — if `/api/recent` returns < 2 rows (station just came up, or a
  gap), `WindTrend` shows text only, no line. `getRecentReadings` must not throw
  on an empty array.
- **Mobile** — 3 short tab labels fit; make the tablist `overflow-x-auto` anyway.
  Forecast grid: 2 cols on phone, 5 on `lg`.

---

## 7. Alternative considered — three routes

`/`, `/history`, `/ahead` as separate pages; tab bar = `<a>` links; add
`<ClientRouter />` for smooth transitions. Each route hydrates only its own
islands → better cold-load. **Rejected for v1** because: (a) instant, no-flicker
tab switching is nicer for a dashboard people leave open; (b) the "Today so far"
numbers would need duplicating across pages; (c) more nav plumbing. Revisit if
island load time on the hidden tabs becomes a measured problem.

---

## 8. Phased checklist

**Phase 1 — decompose (no visual change)**
- [x] Extract `sparkPath()` into `web/src/lib/spark.ts`; point `Sparkline.astro` at it.
- [x] Remove Sun/Moon/Pollen/Tides/RainRadar from `CurrentConditions.astro`
      (RainRadar → `now` slot; the rest → `ahead` slot).
- [x] `astro build` clean; live refresh + `document.title` still work.

**Phase 2 — tab shell**
- [x] Add `DashboardTabs.astro` — with inline Lucide-style icons per tab
      (activity / line-chart / calendar) and `text-base` labels.
- [x] Rewrite `index.astro` with the three named slots (§3c).
- [x] `HistoryCharts` → **`client:only="react"`** (not `client:visible` — SSR only
      produced Radix hydration mismatches; confirmed gone after the switch).
- [x] `EChart.tsx` — defer `echarts.init` until the container has a non-zero
      size (`ResizeObserver`), so mounting inside a `hidden` panel no longer
      logs "Can't get DOM width or height".
- [x] Hash deep-linking, `localStorage` last-tab, arrow-key nav, sticky bar.

**Phase 3 — 5-day forecast**
- [x] `web/src/lib/forecast.ts` (fetch + WMO map + 30-min memo).
- [x] `web/src/components/ForecastSection.astro` (`server:defer`), first in the
      `ahead` slot.
- [x] Attribution line; `null` → "Forecast unavailable".

**Phase 4 — wind 5-min trend**
- [x] `getRecentReadings()` in `supabase.ts`; `/api/recent.ts` (`max-age=20`).
- [x] `circularMean` / `angularDelta` / `veerBack` in `format.ts`.
- [~] SSR seed — **skipped**; `WindTrend` fetches on mount (`client:load`) and
      shows "Last 5 min · reading…" for the one tick before data lands. Add
      `windRecent15m` to `getTodaySummary()` later if the flash bothers.
- [x] `WindTrend.tsx`; mounted in the Wind card; 30 s poll; shared `sparkPath`
      with a `domain` option so wind + gust share a y-scale.
- [x] Stale (>15 min) / sparse (<2 points) handling.

**Phase 5 — docs + polish**
- [x] `web/README.md`, `CLAUDE.md` (new Open-Meteo forecast dependency).
- [x] Tab icons + larger tab labels.
- [x] Tides tile moved to Now.
- [x] Glance hero — `NowHero.astro` (`getCurrentSky` + `SkyIcon.astro`),
      rendered **above `<DashboardTabs>`** so it's visible on every tab, with its
      own poll loop. Redundant status bar removed from `CurrentConditions`.
- [x] "Now" tab relabelled "Now in detail".
- [ ] Optional "Today so far" strip on History.
- [ ] Deploy to Vercel; re-verify chart sizing + island hydration on the preview.
- [ ] README screenshots.

---

## 9. Open questions

1. **Tides in *Now* or *Ahead*?** → **resolved: *Now*** (2026-09-01). It leads
   with a live tide height, so it belongs in the glance; sits beside the rain
   radar on `lg`.
2. **Sun in *Now* or *Ahead*?** Same tension (it's a "today" thing). → *Ahead*
   next to Moon reads well.
3. **Rain radar — *Now* only, or also a nowcast strip in *Ahead*?** → *Now* only
   for v1.
4. **Forecast wind** — show dominant direction only, or a tiny per-day arrow row?
   → dominant direction + arrow, one line per day.
5. Keep the 24h card sparklines in the *Now* tiles, or is that History's job now?
   → keep them; they're the at-a-glance context for the current number.
