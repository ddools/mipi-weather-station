import { circularMean } from "./format";

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

export type HistoryRange = "24h" | "7d" | "30d" | "all";

const RANGE_HOURS: Record<Exclude<HistoryRange, "all">, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

// Before the station's first reading, so "all" means the Pi's whole life.
const LIFETIME_START = "2000-01-01T00:00:00Z";

// Rollup columns named like `readings` (PostgREST `alias:column`), so their rows
// are Readings as far as the charts are concerned. See docs/supabase-retention.sql.
const ROLLUP_FIELDS =
  "temp_c,humidity,pressure_hpa,pressure_msl_hpa,wind_speed_ms,wind_gust_ms,wind_dir_deg,rain_mm,dewpoint_c,air_quality";
const HOURLY_COLUMNS = `recorded_at:bucket,${ROLLUP_FIELDS}`;
const DAILY_COLUMNS = `recorded_at,${ROLLUP_FIELDS}`;

// PostgREST caps a single response at 1000 rows regardless of `limit`, so a
// `gte`-filtered range has to be paged or it silently truncates. Page size
// matches that cap. Raw rows also have a ceiling (~14 days at our cadence):
// anything longer should come from the rollup tables, and if those are missing
// the raw fallback keeps the newest rows rather than the oldest.
const PAGE = 1000;
const MAX_RAW_ROWS = 20000;

/**
 * Every row of `table` with `timeCol` >= `sinceISO`, oldest→newest (or
 * newest→oldest for `desc`), paged by keyset on `timeCol` rather than offset so
 * rows inserted mid-read can't shift a page boundary and duplicate a row.
 */
async function fetchPaged<T extends { recorded_at: string }>(
  table: string,
  columns: string,
  timeCol: string,
  sinceISO: string,
  { desc = false, maxRows = Infinity } = {}
): Promise<T[]> {
  const rows: T[] = [];
  const dir = desc ? "desc" : "asc";
  let cursor = "";
  while (rows.length < maxRows) {
    const res = await restFetch(
      `${table}?select=${columns}&${timeCol}=gte.${encodeURIComponent(sinceISO)}${cursor}` +
        `&order=${timeCol}.${dir}&limit=${PAGE}`
    );
    if (!res.ok) throw new Error(`Supabase error ${res.status} reading ${table}`);
    const page: T[] = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
    const last = page[page.length - 1].recorded_at;
    cursor = `&${timeCol}=${desc ? "lt" : "gt"}.${encodeURIComponent(last)}`;
  }
  console.warn(`fetchPaged: hit the ${maxRows}-row ceiling on ${table}; older data omitted`);
  return rows;
}

async function fetchRange(sinceISO: string): Promise<Reading[]> {
  const rows = await fetchPaged<Reading>("readings", READING_COLUMNS, "recorded_at", sinceISO, {
    desc: true,
    maxRows: MAX_RAW_ROWS,
  });
  return rows.reverse();
}

/** A rollup table/view, or [] if it doesn't exist yet (retention SQL not run). */
async function fetchRollup(table: string, columns: string, timeCol: string, sinceISO: string) {
  try {
    return await fetchPaged<Reading>(table, columns, timeCol, sinceISO);
  } catch (err) {
    console.warn(`getHistory: ${table} unavailable, falling back to raw rows`, err);
    return [];
  }
}

/**
 * Hourly averages from `sinceISO` to now: readings_hourly for the hours the
 * rollup has done, then raw rows bucketed here for the rest. The rollup runs at
 * five past each hour, so it always trails now by an hour or two — and until
 * the retention SQL is applied it doesn't exist, and this is all raw.
 */
async function getHourlyHistory(sinceISO: string): Promise<Reading[]> {
  const hourly = await fetchRollup("readings_hourly", HOURLY_COLUMNS, "bucket", sinceISO);
  const last = hourly[hourly.length - 1];
  const tailSince = last
    ? new Date(new Date(last.recorded_at).getTime() + 3600_000).toISOString()
    : sinceISO;
  const tail = bucketHourly(await fetchRange(tailSince));
  return renumber([...hourly, ...tail]);
}

/**
 * Daily averages over the station's whole life: the readings_daily view for
 * every finished Irish day, then today (and anything the view is missing)
 * built from the hourly history.
 */
async function getDailyHistory(): Promise<Reading[]> {
  const daily = await fetchRollup("readings_daily", DAILY_COLUMNS, "recorded_at", LIFETIME_START);
  const last = daily[daily.length - 1];
  const lastDay = last ? dublinDate.format(new Date(last.recorded_at)) : "";
  // Start the tail a little before the next local midnight (DST moves it by an
  // hour) and drop whatever still falls on a day the view already has.
  const tailSince = last
    ? new Date(new Date(last.recorded_at).getTime() + 22 * 3600_000).toISOString()
    : LIFETIME_START;
  const tail = (await getHourlyHistory(tailSince)).filter(
    (r) => dublinDate.format(new Date(r.recorded_at)) > lastDay
  );
  return renumber([...daily, ...bucketDaily(tail)]);
}

export async function getHistory(range: HistoryRange): Promise<Reading[]> {
  if (range === "all") return getDailyHistory();
  const hours = RANGE_HOURS[range] ?? 24;
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  // 24h is small enough to return raw. Longer ranges are hourly averages so the
  // client payload stays small.
  if (range === "24h") return fetchRange(since);
  return getHourlyHistory(since);
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
  /** current rain intensity in mm/h, from the rain measured over the last
   *  ~15 minutes scaled to an hourly rate. null when no rows cover that window. */
  rainRateNow: number | null;
  /** sea-level pressure now and ~3h ago, for the trend indicator. */
  pressureNow: number | null;
  pressure3hAgo: number | null;
  /** current + past values for the temperature / humidity trend arrows. */
  tempNow: number | null;
  temp1hAgo: number | null;
  temp24hAgo: number | null;
  humidityNow: number | null;
  humidity1hAgo: number | null;
  /** ~48-point downsample of the last 24h, oldest→newest, for card sparklines.
   *  `rain` is the odd one out: rainfall is an accumulation, not a level, so it
   *  is the running total since local midnight (matching the `rainToday`
   *  headline, which is its last point) rather than a 24h series of rates. */
  spark: {
    temp: (number | null)[];
    pressure: (number | null)[];
    humidity: (number | null)[];
    wind: (number | null)[];
    rain: (number | null)[];
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
/**
 * Running rain total across the rows, oldest→newest — the shape of the day's
 * accumulation. Rows with no rain reading carry the total forward unchanged
 * rather than breaking the line: a failed sensor cycle is not a reset to zero.
 */
function cumulativeRain(rows: Reading[]): number[] {
  let total = 0;
  return rows.map((r) => {
    if (r.rain_mm !== null && !Number.isNaN(r.rain_mm)) total += r.rain_mm;
    return total;
  });
}

/**
 * Current rain intensity in mm/h: the rain measured across `rows` scaled from the
 * window `minutes` to an hourly rate. null when none of the rows carry a rain
 * reading (a gap) — distinct from 0, a genuinely dry window.
 */
function rainRate(rows: Reading[], minutes: number): number | null {
  const total = sumRain(rows);
  if (total === null) return null;
  return (total / minutes) * 60;
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

  const RATE_WINDOW_MIN = 15;
  const rateWindowAgo = now - RATE_WINDOW_MIN * 60_000;
  const rateWindowRows = rows.filter((r) => new Date(r.recorded_at).getTime() >= rateWindowAgo);

  const latest = rows[rows.length - 1] ?? null;

  return {
    tempMin: min(todayRows.map((r) => r.temp_c)),
    tempMax: max(todayRows.map((r) => r.temp_c)),
    gustMax: max(todayRows.map((r) => r.wind_gust_ms)),
    windMax: max(todayRows.map((r) => r.wind_speed_ms)),
    rainToday: sumRain(todayRows),
    rainLastHour: sumRain(lastHourRows),
    rain24h: sumRain(rows),
    rainRateNow: rainRate(rateWindowRows, RATE_WINDOW_MIN),
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
      rain: downsample(cumulativeRain(todayRows), 48),
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

function renumber(rows: Reading[]): Reading[] {
  return rows.map((r, i) => ({ ...r, id: i }));
}

/** Raw rows → one averaged row per UTC hour. */
function bucketHourly(rows: Reading[]): Reading[] {
  return bucketRows(
    rows,
    (r) => r.recorded_at.slice(0, 13), // "YYYY-MM-DDTHH"
    (key) => `${key}:00:00.000Z`
  );
}

/** Hourly rows → one averaged row per Irish calendar day, stamped with its first hour. */
function bucketDaily(rows: Reading[]): Reading[] {
  return bucketRows(
    rows,
    (r) => dublinDate.format(new Date(r.recorded_at)),
    (_key, first) => first.recorded_at
  );
}

function bucketRows(
  rows: Reading[],
  keyOf: (r: Reading) => string,
  stampOf: (key: string, first: Reading) => string
): Reading[] {
  const buckets = new Map<string, Reading[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
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

  return [...buckets.entries()].map(([key, bucketRows], i) => {
    const avg: Partial<Reading> = { id: i, recorded_at: stampOf(key, bucketRows[0]) };
    for (const field of numericFields) {
      const values = bucketRows
        .map((r) => r[field])
        .filter((v): v is number => v !== null);
      if (field === "rain_mm") {
        // rain accumulates — sum the bucket, don't average it; null if the hour
        // has no rain readings at all (a data gap, not a dry hour)
        avg[field] = values.length ? values.reduce((a, b) => a + b, 0) : null;
      } else if (field === "wind_gust_ms") {
        // the peak gust in the bucket, as readings_hourly/readings_daily do
        avg[field] = values.length ? Math.max(...values) : null;
      } else if (field === "wind_dir_deg") {
        // Bearings wrap at 360°, so the arithmetic mean is wrong wherever an
        // hour straddles north: 350° and 10° average to 180° — the exact
        // opposite of the true direction — which silently spun the 7d/30d wind
        // rose. Take the vector mean instead.
        avg[field] = circularMean(values);
      } else {
        avg[field] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      }
    }
    return avg as Reading;
  });
}
