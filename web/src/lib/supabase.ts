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

async function restFetch(path: string): Promise<Response> {
  const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  return fetch(restUrl(path), {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
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

export type HistoryRange = "24h" | "7d" | "30d";

const RANGE_HOURS: Record<HistoryRange, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

export async function getHistory(range: HistoryRange): Promise<Reading[]> {
  const hours = RANGE_HOURS[range] ?? 24;
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const res = await restFetch(
    `readings?select=${READING_COLUMNS}&recorded_at=gte.${since}&order=recorded_at.asc&limit=10000`
  );
  if (!res.ok) throw new Error(`Supabase error ${res.status}`);
  const rows: Reading[] = await res.json();

  // 24h is small enough to return raw. Longer ranges get bucketed into hourly
  // averages here so the client payload stays small. This does mean pulling
  // every raw row for 7d/30d first — fine at today's volume, but revisit with
  // a server-side aggregate (Postgres view/RPC) once the table has real history.
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
  /** rain accumulation, in mm, over three windows. */
  rainToday: number;
  rainLastHour: number;
  rain24h: number;
  /** sea-level pressure now and ~3h ago, for the trend indicator. */
  pressureNow: number | null;
  pressure3hAgo: number | null;
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
function sumRain(rows: Reading[]): number {
  return rows.reduce((acc, r) => acc + (r.rain_mm ?? 0), 0);
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

  // Row nearest to 3h ago, for the pressure trend.
  const target = now - 3 * 3600_000;
  let pressure3hAgo: number | null = null;
  let bestGap = Infinity;
  for (const r of rows) {
    if (r.pressure_msl_hpa === null) continue;
    const gap = Math.abs(new Date(r.recorded_at).getTime() - target);
    if (gap < bestGap) {
      bestGap = gap;
      pressure3hAgo = r.pressure_msl_hpa;
    }
  }
  // Only trust it if we actually have a reading within ±45 min of the 3h mark.
  if (bestGap > 45 * 60_000) pressure3hAgo = null;

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
    pressure3hAgo,
    spark: {
      temp: downsample(rows.map((r) => r.temp_c), 48),
      pressure: downsample(rows.map((r) => r.pressure_msl_hpa), 48),
      humidity: downsample(rows.map((r) => r.humidity), 48),
      wind: downsample(rows.map((r) => r.wind_speed_ms), 48),
    },
  };
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
        // rain accumulates — sum the bucket, don't average it
        avg[field] = values.reduce((a, b) => a + b, 0);
      } else {
        avg[field] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      }
    }
    return avg as Reading;
  });
}
