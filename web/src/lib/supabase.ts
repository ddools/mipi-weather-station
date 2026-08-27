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
}

const READING_COLUMNS =
  "id,recorded_at,temp_c,humidity,pressure_hpa,pressure_msl_hpa,wind_speed_ms,wind_gust_ms,wind_dir_deg,rain_mm,dewpoint_c";

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
