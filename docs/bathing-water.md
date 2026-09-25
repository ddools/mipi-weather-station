# Dashboard — bathing water quality (Skerries, South Beach)

Plan for adding an EPA bathing-water card to the dashboard: the latest sample
result, the annual rating, and any active bathing restriction at the designated
bathing water nearest the station.

Status: **implemented on branch `bathing-water`** 2026-09-25: `lib/bathing.ts`,
`BathingSection.astro`, wired into *Now in detail*. Checked against the live API
and in the browser (all six states in §4b forced via fixtures, light + dark,
390 px and desktop). Not yet deployed. §5 (rain note) not done. Every API fact
below was checked against the live API on 2026-09-25.

---

## 1. Goal

The station sits on the Skerries coast, and the *Now in detail* tab already
answers sea questions: [`TidesSection.astro`](../web/src/components/TidesSection.astro)
shows the tide state. The missing piece for anyone going for a swim is **"is the
water OK?"**. The EPA publishes this for every designated bathing water in Ireland
(the same data behind beaches.ie), keyless and under CC BY 4.0.

One card for **Skerries, South Beach**, showing:

- the **latest sample**: rating (Excellent / Good / Sufficient / Poor) and date
- the **annual classification**, with the three previous years as a trend strip
- a **restriction banner** when a bathing restriction is active at the beach
- an honest **"season ended"** state for the ~8½ months when nobody samples

Out of scope: a national map, a nearest-beach picker, and storing alert history.

---

## 2. Data source — EPA Bathing Water Open Data API

- Docs: <https://data.epa.ie/api-list/bathing-water-open-data/>
- OpenAPI spec: `https://data.epa.ie/bw/swagger/v1/swagger.json`
- Base: `https://data.epa.ie/bw/api/v1/`
- No key, no auth, no stated rate limit. Licence **CC BY 4.0**: attribution required.
- Plain JSON, no `Cache-Control`/`ETag`/CORS headers. We fetch server-side, so
  the missing CORS headers don't matter. `HEAD` returns 405, so use `GET` only.

Every list endpoint takes `page` + `per_page` and returns the same envelope:

```json
{ "count": 25978, "length": 1000, "page": 26, "list": [ ... ], "_links": { ... } }
```

| Endpoint | Returns | Per-beach filter? |
|---|---|---|
| `GET /locations/{beach_id}` | one beach's full record (~3 KB) | ✅ path param |
| `GET /locations` | all 243 bathing waters | ❌ |
| `GET /measurements` | every **in-season** sample since 2014 (25,978 rows), oldest first | ❌ **`?beach_id=` is silently ignored** |
| `GET /measurements/in-season`, `/out-season` | the two halves (out-season: 997 rows, 21 beaches, **none in Fingal**) | ❌ |
| `GET /alerts` | **currently active** incidents only (2 nationally on 2026-09-25) | ❌ |
| `GET /alerts/{incident_id}` | one incident; 404 once it has ended | — |

`per_page` accepts at least 5000 (1.6 MB, ~0.4 s). 1000 rows is ~320 KB, ~0.3–0.7 s.

### Our beach

| Field | Value (2026-09-25) |
|---|---|
| `beach_id` | **`IEEABWC020_0000_0500`** |
| `beach_name` | Skerries, South Beach |
| Annual classification | Excellent (2025) · Good (2024) · Sufficient (2023) · Sufficient (2022) |
| Latest sample | 2026-09-07: **Excellent** (E. coli `20`, enterococci `3` cfu/100 ml) |
| Sampling cadence | ~fortnightly in season (Jul 27, Aug 10, Aug 24, Sep 7) |
| `short_term_pollution_risk` | `Yes` |
| `previous_year_stp_closure_days` | `6` |
| `has_all_season_bathing_restriction_in_place` | `No` |
| `next_monitoring_date` | `null` (season over) |
| `beach_profile_url` | beaches.ie PDF profile |

Nearby alternatives if we ever want a second beach: Loughshinny
(`IEEABWC020_0000_0400`, Good, ~4 km), Rush North Beach (`IEEABWC020_0000_0350`,
Excellent).

### Relevant fields

**`/locations/{beach_id}`**: `beach_name`, `current_annual_water_quality_classification`
+ `current_annual_classification_year`, `year{1,2,3}_annual_water_quality_classification`
+ `year{1,2,3}_annual_classification_year`, `next_monitoring_date`,
`short_term_pollution_risk`, `has_all_season_bathing_restriction_in_place`,
`reason_for_all_season_bathing_restriction`, `beach_profile_url`, `last_updated`.

**`/measurements` rows**: `monitoring_result_id`, `beach_id`, `result_date`
(`YYYY-MM-DD`), `e_coli_result`, `intestinal_enterococci_result`,
`sample_water_quality_status`.

**`/alerts` rows**: `incident_id`, `beach_id`, `has_bathing_restriction_in_place`,
`bathing_restriction_type` (e.g. "Bathing is temporarily prohibited"),
`incident_description`, `incident_start_date`, `incident_expected_duration`
(days), `incident_end_date`, `bathing_notice_pdf`, `last_updated`.

---

## 3. Gotchas

1. **You can't ask for one beach's samples.** `?beach_id=` on `/measurements` is
   ignored and returns the national list. To get the latest Skerries sample,
   read `count`, fetch the **tail** of the list, and filter client-side (§4a).
2. **Don't trust row order.** The tail was sorted by `result_date` on
   2026-09-25, but results entered late could arrive with old dates and high
   ids. Sort by `result_date` ourselves and take the max.
3. **Results are strings**, and some are censored: `"<10"`, `"<1"`. Display
   them as-is, and don't parse them into numbers for anything that matters.
4. **There are two rating vocabularies.** A sample is rated `Excellent` /
   `Good` / `Sufficient` / `Poor`; the annual classification is worded
   `Excellent Quality` etc. Normalise both to one `Rating` type, but keep them
   **labelled differently** in the UI ("Latest sample" vs "2025 rating"): they
   mean different things. A single sample is a spot check; the annual rating is
   a four-year statistical assessment.
5. **The season is 1 June – 15 September.** Skerries has no out-of-season
   samples and `next_monitoring_date` goes `null`. For most of the year the card
   shows last season's final sample. It must say so ("Season ended · last
   sampled 7 Sep") rather than look like a stale live reading.
6. **Alerts have no history.** An incident disappears from `/alerts` (and
   `/alerts/{id}` returns 404) when it ends. We can show *active* restrictions
   only; "last closed on…" would need our own storage. Out of scope.
7. **Coordinates are Irish Grid**, not lat/lon (`easting`/`northing`, e.g.
   325700 / 260845). Another reason to hard-code the `beach_id` rather than
   look up the nearest beach.
8. **The API sends no cache headers or ETags,** so the cache is ours (§4a).
9. **This card is not safety advice.** The EPA / Fingal County Council notice
   is the authority. The card links to the beaches.ie profile and any notice
   PDF, and must never say "safe to swim".

---

## 4. Technical architecture

### 4a. `web/src/lib/bathing.ts` (new)

Mirrors [`lib/forecast.ts`](../web/src/lib/forecast.ts): module-level memo cache,
and it returns the last good copy on any fetch failure, so an EPA outage shows
slightly old data instead of an empty card.

```ts
const BEACH_ID = "IEEABWC020_0000_0500"; // Skerries, South Beach
const BASE = "https://data.epa.ie/bw/api/v1";

export type Rating = "excellent" | "good" | "sufficient" | "poor";

export interface BathingSample {
  date: string;            // YYYY-MM-DD
  rating: Rating | null;
  eColi: string;           // raw, may be "<10"
  enterococci: string;     // raw, may be "<1"
}

export interface BathingAlert {
  type: string;            // bathing_restriction_type
  description: string;
  startDate: string;
  expectedDays: number | null;
  noticeUrl: string | null;
}

export interface BathingReport {
  beachName: string;
  annual: { year: number; rating: Rating | null }[]; // newest first, up to 4
  lastSample: BathingSample | null;
  alert: BathingAlert | null;          // active incident at this beach
  allSeasonRestriction: string | null; // reason, when has_all_season_... = "Yes"
  inSeason: boolean;
  nextSampleDate: string | null;
  shortTermPollutionRisk: boolean;
  profileUrl: string | null;
}

export async function getBathingReport(): Promise<BathingReport | null>;
```

Three fetches, cached on two timescales, run in parallel:

| Piece | Request | TTL | Why |
|---|---|---|---|
| Beach record | `GET /locations/{BEACH_ID}` | 6 h | changes a few times a year |
| Latest sample | `GET /measurements?per_page=1` → `count`; then the last **two** pages at `per_page=1000` in parallel | 6 h | samples arrive fortnightly; two pages so a near-empty last page (e.g. `count` = 26001) still covers ~6 weeks |
| Active alerts | `GET /alerts?per_page=500` | 30 min | restrictions can go up any day in season |

Latest-sample steps: fetch the tail pages, filter `beach_id === BEACH_ID`, sort by
`result_date`, take the last. Out of season the tail doesn't move, so it still
holds last season's final Skerries samples. If none are found (e.g. early June,
before the first sample of a new season has pushed the old ones out of the two-page window), return
`lastSample: null`. Don't page further back.

`inSeason`: `next_monitoring_date !== null` **or** today (Europe/Dublin) is
within 1 Jun – 15 Sep. The calendar is a fallback in case the EPA field lags at
the start of the season (not yet observed; `null` on 2026-09-25 was after the season).

Normalise ratings with one helper: lower-case, strip a trailing `" quality"`,
map to `Rating`, anything else → `null`.

### 4b. `web/src/components/BathingSection.astro` (new)

A **`server:defer` server island**, not a build-time section. Pollen/Sun/Moon
render at build time, which is fine for them, but an active restriction must show
up without a redeploy. The service worker already caches `/_server-islands/*`
network-first, so the offline copy comes for free.

Uses the shadcn `Card` (same header pattern as `PollenSection`). Icon: Meteocons
`water.svg` (waves), scaled 150% because the glyph only fills the middle of its
128 px box. Meteocons has no beach/swim icon.

Layout (top to bottom):

1. **Header**: icon + "Bathing water" + sub-title "Skerries, South Beach".
2. **Restriction banner** (only if `alert` or `allSeasonRestriction`): red,
   `bathing_restriction_type` as the headline, description, "since {start}", link
   to the notice PDF. This replaces the "ok" visual weight, so nothing green
   shows alongside it.
3. **Latest sample**: coloured dot + rating word + "sampled {7 Sep}". Small
   secondary line: `E. coli 20 · enterococci 3 per 100 ml`.
   Out of season: prefix with a muted "Season ended ·" badge.
   In season: "Next sample {date}" when `nextSampleDate` is set.
4. **Annual rating strip**: four chips, newest first
   (`2025 Excellent · 2024 Good · 2023 Sufficient · 2022 Sufficient`), same
   colour scale.
5. **Footer**: "Source: EPA · beaches.ie" links (attribution requirement), plus
   the beach profile PDF.

Colour scale (matches `PollenSection`'s dot/text pairs):

| Rating | Dot | Text |
|---|---|---|
| Excellent | `bg-sky-500` | `text-sky-600 dark:text-sky-400` |
| Good | `bg-emerald-500` | `text-emerald-600 dark:text-emerald-400` |
| Sufficient | `bg-amber-500` | `text-amber-600 dark:text-amber-400` |
| Poor | `bg-red-500` | `text-red-600 dark:text-red-400` |

(Unverified: check which colours beaches.ie uses for the four ratings and match
them if they differ, so the card reads the same as the official source.)

States to handle:

| State | Shows |
|---|---|
| In season, no alert | sample + next sample date + annual strip |
| Season ended | "Season ended ·" + last sample + annual strip |
| Active alert | red banner on top, sample underneath (de-emphasised) |
| All-season restriction | red banner with `reason_for_all_season_bathing_restriction` |
| No sample in window | annual strip only + "No samples yet this season" |
| `getBathingReport()` → `null` | "Bathing water data unavailable." (same as Pollen) |

### 4c. Placement

Into the **Now in detail** tab in
[`index.astro`](../web/src/pages/index.astro), in the grid with Tides and the
rain radar. Tides + bathing are the "going in the sea" pair:

```astro
<div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
  <TidesSection />
  <RainRadar client:visible />
  <BathingSection server:defer>
    <Skeleton slot="fallback" className="h-56" />
  </BathingSection>
</div>
```

**As built:** the first try (above) left bathing alone on a third row with a
big gap under the short Tides card, so bathing is **stacked under Tides** in the
left column instead. Tides + bathing together roughly match the radar's height
on `lg`; on phones the order is Tides → Bathing → Radar.

---

## 5. Optional: rain context from our own gauge

Skerries is flagged `short_term_pollution_risk: Yes` (6 closure days last
season). Short-term pollution at Irish beaches is typically linked to heavy rain
(runoff and sewer overflows). We have the
rain gauge right there. `getTodaySummary()` in
[`lib/supabase.ts`](../web/src/lib/supabase.ts) already returns `rain24h`.

In season, when `rain24h` is above a threshold (say ≥ 10 mm), add a muted note:

> 14 mm of rain in the last 24 h at the station. Skerries is prone to
> short-term pollution after heavy rain; check beaches.ie before swimming.

This states a measured fact and points to the authority. It doesn't predict
water quality. Leave it for a second PR; the threshold is a guess until we've
watched a season of EPA alerts against our rain record.

---

## 6. Build order

1. **`lib/bathing.ts`**: types, three fetchers, caches, rating normaliser,
   season logic. Verify by logging `getBathingReport()` from a scratch script
   against the live API.
2. **`BathingSection.astro`**: all six states. Force each one temporarily with
   a hard-coded report to check the layout in light and dark.
3. **Wire into `index.astro`** with the skeleton fallback.
4. **Verify**: `npm run build`, serve `web/.vercel/output/static` (server
   islands need the build, see CLAUDE.md), check the card at phone width, and
   check the offline copy via the service worker.
5. **Docs**: the "Now in detail" row in
   [`dashboard-tabs.md`](dashboard-tabs.md) §2, a CLAUDE.md "Current state" line,
   and a Gotchas entry for the unfilterable `/measurements`. Note that this makes
   a **new external dependency** (EPA) alongside the Open-Meteo ones.
6. *(Later)* §5 rain note.

No Pi changes, no Supabase changes, no new npm dependencies.

---

## 7. Decisions

Made while building (2026-09-25); revisit if they read wrong in use.

- **One beach**: Skerries South Beach only. Loughshinny would be a second
  `BEACH_ID` and a compact row, if wanted.
- **Icon**: Meteocons `water.svg`.
- **Off-season**: the card stays visible all year with a "Season ended" badge.
- **Pollution-risk line**: in season, with no restriction active, the card
  repeats the EPA's own `short_term_pollution_risk` flag as one muted line. It
  quotes the EPA and doesn't use our rain data, so it isn't §5.
- **Rain note (§5)**: still open. It needs a threshold we don't have yet.
- **Colours**: sky/emerald/amber/red as in §4b. Not checked against beaches.ie
  (its homepage exposes no rating colours to scrape).
