export interface Reading {
  id: number;
  recorded_at: string;
  temp_c: number | null;
  humidity: number | null;
  pressure_hpa: number | null;
  pressure_msl_hpa: number | null;
  wind_speed_ms: number | null;
  wind_gust_ms: number | null;
  wind_dir_deg: number | null;
  rain_mm: number | null;
  dewpoint_c: number | null;
  /** TGS2600 relative contaminants index, 0–100, uncalibrated. null unless the sensor is fitted. */
  air_quality: number | null;
}

const READING_COLUMNS =
  "id,recorded_at,temp_c,humidity,pressure_hpa,pressure_msl_hpa,wind_speed_ms,wind_gust_ms,wind_dir_deg,rain_mm,dewpoint_c,air_quality";

function restUrl(path: string): string {
  const base = import.meta.env.PUBLIC_SUPABASE_URL;
  const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !key) {
    throw new Error("PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY are not set");
  }
  return `${base}/rest/v1/${path}`;
}

export async function restFetch(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  return fetch(restUrl(path), {
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...headers },
  });
}

export async function getLatestReading(): Promise<Reading | null> {
  const res = await restFetch(
    `readings?select=${READING_COLUMNS}&order=recorded_at.desc&limit=1`
  );
  if (!res.ok) throw new Error(`Supabase error ${res.status}`);
  const rows: Reading[] = await res.json();
  return rows[0] ?? null;
}

/** Raw rows from the last `minutes` minutes, oldest→newest. Small window
 *  (< ~20 rows at a 60s archive interval), so no paging. Used by the Wind
 *  tile's 5-minute trend. Returns [] when nothing covers the window. */
export async function getRecentReadings(minutes = 15): Promise<Reading[]> {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const res = await restFetch(
    `readings?select=${READING_COLUMNS}&recorded_at=gte.${since}&order=recorded_at.asc`
  );
  if (!res.ok) throw new Error(`Supabase error ${res.status}`);
  return res.json();
}

export type HistoryRange = "24h" | "7d" | "30d";

const RANGE_HOURS: Record<HistoryRange, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

// PostgREST caps a single response at 1000 rows regardless of `limit`, so a
// `gte`-filtered range has to be paged or it silently truncates to the oldest
// 1000 (≈ 17 h at our cadence). Page size matches that cap; the ceiling stops a
// 30-day pull from fanning out unboundedly before the hourly rollup exists.
const PAGE = 1000;
const MAX_ROWS = 20000;

async function fetchRange(sinceISO: string): Promise<Reading[]> {
  const rows: Reading[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const res = await restFetch(
      `readings?select=${READING_COLUMNS}&recorded_at=gte.${sinceISO}` +
        `&order=recorded_at.asc&limit=${PAGE}&offset=${offset}`
    );
    if (!res.ok) throw new Error(`Supabase error ${res.status}`);
    const page: Reading[] = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
  console.warn(`getHistory: hit the ${MAX_ROWS}-row ceiling; older data omitted`);
  return rows;
}

export async function getHistory(range: HistoryRange): Promise<Reading[]> {
  const hours = RANGE_HOURS[range] ?? 24;
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = await fetchRange(since);

  // 24h is small enough to return raw. Longer ranges get bucketed into hourly
  // averages here so the client payload stays small. This still pulls every raw
  // row first — fine at today's volume, but revisit with a server-side aggregate
  // (Postgres view/RPC) once the table has real history.
  if (range === "24h") return rows;
  return bucketHourly(rows);
}

export interface TodaySummary {
  /** min/max of instantaneous temperature since local midnight (Europe/Dublin). */
  tempMin: number | null;
  tempMax: number | null;
  /** highest gust and highest sustained wind since local midnight. */
  gustMax: number | null;
  windMax: number | null;
  /** rain accumulation, in mm, over three windows. null when no readings cover the window. */
  rainToday: number | null;
  rainLastHour: number | null;
  rain24h: number | null;
  /** sea-level pressure now and ~3h ago, for the trend indicator. */
  pressureNow: number | null;
  pressure3hAgo: number | null;
  /** current + past values for the temperature / humidity trend arrows. */
  tempNow: number | null;
  temp1hAgo: number | null;
  temp24hAgo: number | null;
  humidityNow: number | null;
  humidity1hAgo: number | null;
  /** ~48-point downsample of the last 24h, oldest→newest, for card sparklines. */
  spark: {
    temp: (number | null)[];
    pressure: (number | null)[];
    humidity: (number | null)[];
    wind: (number | null)[];
  };
}

const dublinDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Dublin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function max(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null && !Number.isNaN(v));
  return nums.length ? Math.max(...nums) : null;
}
function min(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null && !Number.isNaN(v));
  return nums.length ? Math.min(...nums) : null;
}
/** Total rain over the rows, or null if none of them actually carry a rain reading. */
function sumRain(rows: Reading[]): number | null {
  const measured = rows.filter((r) => r.rain_mm !== null && !Number.isNaN(r.rain_mm));
  if (measured.length === 0) return null;
  return measured.reduce((acc, r) => acc + (r.rain_mm as number), 0);
}

/**
 * Derived "today so far" figures for the current-conditions cards. Computed from
 * the raw 24h rows (always ~1,440 at a 60s archive interval, regardless of how
 * much history exists) — no server-side aggregate needed at this scale.
 */
export async function getTodaySummary(): Promise<TodaySummary> {
  const rows = await getHistory("24h");
  const now = Date.now();
  const todayStr = dublinDate.format(new Date(now));
  const todayRows = rows.filter((r) => dublinDate.format(new Date(r.recorded_at)) === todayStr);

  const hourAgo = now - 3600_000;
  const lastHourRows = rows.filter((r) => new Date(r.recorded_at).getTime() >= hourAgo);

  const latest = rows[rows.length - 1] ?? null;

  return {
    tempMin: min(todayRows.map((r) => r.temp_c)),
    tempMax: max(todayRows.map((r) => r.temp_c)),
    gustMax: max(todayRows.map((r) => r.wind_gust_ms)),
    windMax: max(todayRows.map((r) => r.wind_speed_ms)),
    rainToday: sumRain(todayRows),
    rainLastHour: sumRain(lastHourRows),
    rain24h: sumRain(rows),
    pressureNow: latest?.pressure_msl_hpa ?? null,
    // Row nearest each offset, but only if it lands within a tolerance window —
    // otherwise a data gap would produce a bogus "trend".
    pressure3hAgo: valueNear(rows, "pressure_msl_hpa", now - 3 * 3600_000, 45 * 60_000),
    tempNow: latest?.temp_c ?? null,
    temp1hAgo: valueNear(rows, "temp_c", now - 3600_000, 20 * 60_000),
    temp24hAgo: valueNear(rows, "temp_c", now - 24 * 3600_000, 90 * 60_000),
    humidityNow: latest?.humidity ?? null,
    humidity1hAgo: valueNear(rows, "humidity", now - 3600_000, 20 * 60_000),
    spark: {
      temp: downsample(rows.map((r) => r.temp_c), 48),
      pressure: downsample(rows.map((r) => r.pressure_msl_hpa), 48),
      humidity: downsample(rows.map((r) => r.humidity), 48),
      wind: downsample(rows.map((r) => r.wind_speed_ms), 48),
    },
  };
}

/**
 * The value of `field` in the row whose timestamp is closest to `targetMs`,
 * provided that row is within `toleranceMs` of the target. Returns null if the
 * nearest reading is too far off (a data gap) — callers use this for trends,
 * where a stale anchor is worse than no anchor.
 */
function valueNear(
  rows: Reading[],
  field: keyof Reading,
  targetMs: number,
  toleranceMs: number
): number | null {
  let best: number | null = null;
  let bestGap = Infinity;
  for (const r of rows) {
    const v = r[field];
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    const gap = Math.abs(new Date(r.recorded_at).getTime() - targetMs);
    if (gap < bestGap) {
      bestGap = gap;
      best = v;
    }
  }
  return bestGap <= toleranceMs ? best : null;
}

/** Take every Nth-ish point so a long series renders as a compact sparkline. */
function downsample(values: (number | null)[], target: number): (number | null)[] {
  if (values.length <= target) return values;
  const step = values.length / target;
  const out: (number | null)[] = [];
  for (let i = 0; i < target; i++) out.push(values[Math.floor(i * step)]);
  return out;
}

function bucketHourly(rows: Reading[]): Reading[] {
  const buckets = new Map<string, Reading[]>();
  for (const row of rows) {
    const hourKey = row.recorded_at.slice(0, 13); // "YYYY-MM-DDTHH"
    const bucket = buckets.get(hourKey);
    if (bucket) bucket.push(row);
    else buckets.set(hourKey, [row]);
  }

  const numericFields = [
    "temp_c",
    "humidity",
    "pressure_hpa",
    "pressure_msl_hpa",
    "wind_speed_ms",
    "wind_gust_ms",
    "wind_dir_deg",
    "rain_mm",
    "dewpoint_c",
    "air_quality",
  ] as const;

  return [...buckets.entries()].map(([hourKey, bucketRows], i) => {
    const avg: Partial<Reading> = { id: i, recorded_at: `${hourKey}:00:00.000Z` };
    for (const field of numericFields) {
      const values = bucketRows
        .map((r) => r[field])
        .filter((v): v is number => v !== null);
      if (field === "rain_mm") {
        // rain accumulates — sum the bucket, don't average it; null if the hour
        // has no rain readings at all (a data gap, not a dry hour)
        avg[field] = values.length ? values.reduce((a, b) => a + b, 0) : null;
      } else {
        avg[field] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      }
    }
    return avg as Reading;
  });
}
