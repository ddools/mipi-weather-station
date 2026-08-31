// All-time and this-month extremes, plus a couple of rain comparisons. Each
// single-value record is one tiny `order=…&limit=1` query, so this works over
// the whole table regardless of how much history exists (no aggregate/RPC
// needed). Rain-by-day figures come from the 30-day hourly rollup.

import { getHistory, restFetch } from "./supabase";

const MONTH_FMT = new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", month: "long" });

// Ignore the station bring-up: the BMP085/HTU21D self-heated ~10 °C until the
// DS18B20 became the air-temp source (2026-08-27). Records before this date are
// instrument noise, not weather. Harmless once real history dwarfs it.
const RECORDS_SINCE = "2026-08-28T00:00:00";

// Dublin Airport 1991–2020 monthly rainfall normals (mm), Met Éireann. Index 0 = Jan.
const DUBLIN_RAIN_NORMALS_MM = [64.4, 47.9, 51.7, 53.6, 56.7, 58.5, 55.4, 74.8, 57.4, 78.9, 72.5, 74.1];

export interface ExtremeRecord {
  label: string;
  value: number;
  unit: string;
  /** ISO timestamp of the reading that set it. */
  at: string | null;
}

export interface RecordsReport {
  monthName: string;
  allTime: ExtremeRecord[];
  thisMonth: ExtremeRecord[];
  rain: {
    monthToDateMm: number | null;
    normalMm: number;
    /** wettest single day in the last 30 days */
    wettestDay: { dateISO: string; mm: number } | null;
    /** consecutive days (ending today) with < 0.2 mm */
    dryStreakDays: number | null;
  };
}

interface ExtremeSpec {
  label: string;
  column: string;
  unit: string;
  dir: "desc" | "asc";
}

const EXTREMES: ExtremeSpec[] = [
  { label: "Warmest", column: "temp_c", unit: "°C", dir: "desc" },
  { label: "Coldest", column: "temp_c", unit: "°C", dir: "asc" },
  { label: "Strongest gust", column: "wind_gust_ms", unit: "m/s", dir: "desc" },
  { label: "Highest pressure", column: "pressure_msl_hpa", unit: "hPa", dir: "desc" },
  { label: "Lowest pressure", column: "pressure_msl_hpa", unit: "hPa", dir: "asc" },
];

async function extreme(spec: ExtremeSpec, sinceISO?: string): Promise<ExtremeRecord | null> {
  const since = sinceISO && sinceISO > RECORDS_SINCE ? sinceISO : RECORDS_SINCE;
  const filter = `&recorded_at=gte.${since}`;
  const path =
    `readings?select=${spec.column},recorded_at` +
    `&${spec.column}=not.is.null${filter}` +
    `&order=${spec.column}.${spec.dir}&limit=1`;
  try {
    const res = await restFetch(path);
    if (!res.ok) return null;
    const rows = (await res.json()) as Record<string, number | string>[];
    const row = rows[0];
    if (!row) return null;
    return {
      label: spec.label,
      value: row[spec.column] as number,
      unit: spec.unit,
      at: (row.recorded_at as string) ?? null,
    };
  } catch {
    return null;
  }
}

function dublinMonthStartISO(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Dublin",
    year: "numeric",
    month: "2-digit",
  }).format(now); // "YYYY-MM"
  return `${parts}-01T00:00:00`;
}

export async function getRecords(): Promise<RecordsReport> {
  const now = new Date();
  const monthStart = dublinMonthStartISO(now);

  const [allTime, thisMonth, days] = await Promise.all([
    Promise.all(EXTREMES.map((s) => extreme(s))),
    Promise.all(EXTREMES.map((s) => extreme(s, monthStart))),
    rainByDay(),
  ]);

  const monthIdx = Number(monthStart.slice(5, 7)) - 1; // Dublin month, 0-based
  const monthDayCutoff = monthStart.slice(0, 10);
  const monthToDateMm = days.length
    ? days.filter((d) => d.dateISO >= monthDayCutoff).reduce((a, d) => a + d.mm, 0)
    : null;

  const wettestDay = days.length
    ? days.reduce((a, b) => (b.mm > a.mm ? b : a))
    : null;

  let dryStreakDays: number | null = days.length ? 0 : null;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].mm >= 0.2) break;
    dryStreakDays = (dryStreakDays ?? 0) + 1;
  }

  return {
    monthName: MONTH_FMT.format(now),
    allTime: allTime.filter((r): r is ExtremeRecord => r !== null),
    thisMonth: thisMonth.filter((r): r is ExtremeRecord => r !== null),
    rain: {
      monthToDateMm,
      normalMm: DUBLIN_RAIN_NORMALS_MM[monthIdx],
      wettestDay: wettestDay && wettestDay.mm > 0 ? wettestDay : null,
      dryStreakDays,
    },
  };
}

/** Daily rain totals for the last 30 days, from the hourly-bucketed history. */
async function rainByDay(): Promise<{ dateISO: string; mm: number }[]> {
  const rows = await getHistory("30d"); // already hourly-bucketed, rain summed per hour
  const byDay = new Map<string, number>();
  for (const r of rows) {
    if (r.rain_mm === null) continue;
    const day = r.recorded_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + r.rain_mm);
  }
  return [...byDay.entries()]
    .map(([dateISO, mm]) => ({ dateISO, mm }))
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO));
}
