// Station-pipeline health from the Supabase feed: is data arriving, how complete
// is it, how big are the gaps. This is the view the dashboard actually has —
// per-service upload status (WU/Windy/…) lives only on the Pi.

import { getHistory, restFetch } from "./supabase";

const NOMINAL_INTERVAL_S = 60; // sampling.archive_interval_s
const EXPECTED_24H = Math.round((24 * 3600) / NOMINAL_INTERVAL_S); // 1440
// A gap wider than this counts as the station being *off*, not as a dropped
// sample. It is what separates the two percentages below, so the UI prints it.
const GAP_ALLOWANCE = 2.5;

export interface StationHealth {
  lastReadingAgeSec: number | null;
  status: "live" | "delayed" | "offline";
  readings24h: number;
  expected24h: number;
  completeness24hPct: number;
  largestGap24hMin: number | null;
  uptime24hPct: number;
  /** Minutes without a reading before the station counts as offline rather than
   *  as having dropped a sample. Captions the difference between the two
   *  percentages: completeness counts readings, uptime counts time. */
  gapAllowanceMin: number;
  totalReadings: number | null;
  collectingSince: string | null;
  daysCollecting: number | null;
}

async function totalReadings(): Promise<number | null> {
  try {
    const res = await restFetch("readings?select=id&limit=1", { Prefer: "count=exact" });
    // PostgREST returns the total after the slash: "0-0/12345"
    const range = res.headers.get("content-range");
    const total = range?.split("/")[1];
    return total && total !== "*" ? Number(total) : null;
  } catch {
    return null;
  }
}

async function firstReadingISO(): Promise<string | null> {
  try {
    const res = await restFetch("readings?select=recorded_at&order=recorded_at.asc&limit=1");
    if (!res.ok) return null;
    const rows = (await res.json()) as { recorded_at: string }[];
    return rows[0]?.recorded_at ?? null;
  } catch {
    return null;
  }
}

export async function getStationHealth(): Promise<StationHealth> {
  const [rows, total, firstISO] = await Promise.all([
    getHistory("24h"),
    totalReadings(),
    firstReadingISO(),
  ]);

  const now = Date.now();
  const times = rows
    .map((r) => new Date(r.recorded_at).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);

  const lastReadingAgeSec = times.length ? (now - times[times.length - 1]) / 1000 : null;
  const status: StationHealth["status"] =
    lastReadingAgeSec === null || lastReadingAgeSec > 900
      ? "offline"
      : lastReadingAgeSec > 180
        ? "delayed"
        : "live";

  // Gaps between consecutive readings across the 24h window.
  let largestGapMs = 0;
  let downtimeMs = 0;
  const gapAllowanceMs = NOMINAL_INTERVAL_S * 1000 * GAP_ALLOWANCE;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > largestGapMs) largestGapMs = gap;
    if (gap > gapAllowanceMs) downtimeMs += gap - NOMINAL_INTERVAL_S * 1000;
  }
  // Also count the stretch from the last reading to now as downtime if it's stale.
  if (lastReadingAgeSec !== null && lastReadingAgeSec * 1000 > gapAllowanceMs) {
    downtimeMs += lastReadingAgeSec * 1000 - NOMINAL_INTERVAL_S * 1000;
  }

  const windowMs = 24 * 3600 * 1000;
  const uptime24hPct = Math.max(0, Math.min(100, 100 * (1 - downtimeMs / windowMs)));
  const completeness24hPct = Math.max(
    0,
    Math.min(100, (times.length / EXPECTED_24H) * 100)
  );

  const daysCollecting = firstISO
    ? Math.max(1, Math.round((now - new Date(firstISO).getTime()) / 86_400_000))
    : null;

  return {
    lastReadingAgeSec,
    status,
    readings24h: times.length,
    expected24h: EXPECTED_24H,
    completeness24hPct,
    largestGap24hMin: times.length > 1 ? largestGapMs / 60_000 : null,
    uptime24hPct,
    gapAllowanceMin: (NOMINAL_INTERVAL_S * GAP_ALLOWANCE) / 60,
    totalReadings: total,
    collectingSince: firstISO,
    daysCollecting,
  };
}
