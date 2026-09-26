// Bathing water quality for Skerries, South Beach from the EPA Bathing Water Open
// Data API (https://data.epa.ie/api-list/bathing-water-open-data/) — free, no
// key, CC BY 4.0 (attribution required). The data behind beaches.ie.
// Plan and API notes: docs/bathing-water.md.
//
// The awkward part: /measurements can't be filtered by beach (`?beach_id=` is
// silently ignored) and runs oldest-first across every beach in the country, so
// the latest Skerries sample is found by fetching the tail of that list and
// filtering it here.

const BEACH_ID = "IEEABWC020_0000_0500"; // Skerries, South Beach
const BASE = "https://data.epa.ie/bw/api/v1";
const TIMEZONE = "Europe/Dublin";

// The Irish bathing season. Nobody samples Skerries outside it (the EPA's
// out-of-season feed has no Fingal beaches), so the card says "season ended"
// rather than presenting September's sample as current.
const SEASON_START = "06-01";
const SEASON_END = "09-15";

// The beach record changes a few times a year and samples arrive fortnightly;
// restrictions can go up any day in season.
const SLOW_TTL_MS = 6 * 3600_000;
const ALERTS_TTL_MS = 30 * 60_000;

// Rows per page when reading the tail of /measurements. Two pages (~640 KB) so
// a near-empty last page still leaves ~6 weeks of in-season samples to search.
const TAIL_PAGE_SIZE = 1000;

export type Rating = "excellent" | "good" | "sufficient" | "poor";

export const RATING_LABEL: Record<Rating, string> = {
  excellent: "Excellent",
  good: "Good",
  sufficient: "Sufficient",
  poor: "Poor",
};

export interface BathingSample {
  /** ISO local date, "YYYY-MM-DD". */
  date: string;
  rating: Rating | null;
  /** Raw result strings, cfu/100 ml — censored values like "<10" pass through. */
  eColi: string;
  enterococci: string;
}

export interface BathingAlert {
  /** e.g. "Bathing is temporarily prohibited". */
  type: string;
  description: string;
  /** ISO local date, "YYYY-MM-DD". */
  startDate: string;
  expectedDays: number | null;
  noticeUrl: string | null;
}

export interface BathingReport {
  beachName: string;
  lastSample: BathingSample | null;
  /** Active incident at this beach — /alerts only ever lists live ones. */
  alert: BathingAlert | null;
  /** Reason, when the beach carries a restriction for the whole season. */
  allSeasonRestriction: string | null;
  inSeason: boolean;
  nextSampleDate: string | null;
  shortTermPollutionRisk: boolean;
}

interface Page<T> {
  count: number;
  list: T[];
}

interface LocationRecord {
  beach_name: string;
  next_monitoring_date: string | null;
  short_term_pollution_risk: string | null;
  has_all_season_bathing_restriction_in_place: string | null;
  reason_for_all_season_bathing_restriction: string | null;
}

interface MeasurementRecord {
  beach_id: string;
  result_date: string;
  e_coli_result: string | null;
  intestinal_enterococci_result: string | null;
  sample_water_quality_status: string | null;
}

interface AlertRecord {
  beach_id: string;
  has_bathing_restriction_in_place: string | null;
  bathing_restriction_type: string | null;
  incident_description: string | null;
  incident_start_date: string;
  incident_expected_duration: number | null;
  incident_end_date: string | null;
  bathing_notice_pdf: string | null;
}

/**
 * Samples are rated "Excellent", annual classifications "Excellent Quality" —
 * one scale, two spellings. Anything else (null, "Not classified", new
 * wording) comes back null rather than guessed at.
 */
export function normaliseRating(raw: string | null | undefined): Rating | null {
  const key = raw?.trim().toLowerCase().replace(/\s+quality$/, "");
  return key && key in RATING_LABEL ? (key as Rating) : null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`EPA ${path}: HTTP ${res.status}`);
  return res.json();
}

/** Memo cache that falls back to the last good value when a refresh fails. */
function cached<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T | null> {
  let entry: { at: number; data: T } | null = null;
  return async () => {
    if (entry && Date.now() - entry.at < ttlMs) return entry.data;
    try {
      entry = { at: Date.now(), data: await load() };
    } catch {
      // Keep serving the stale copy; an EPA outage shouldn't blank the card.
    }
    return entry?.data ?? null;
  };
}

const getLocation = cached(SLOW_TTL_MS, () =>
  getJson<LocationRecord>(`/locations/${BEACH_ID}`),
);

const getLatestSample = cached(SLOW_TTL_MS, async (): Promise<BathingSample | null> => {
  const { count } = await getJson<Page<MeasurementRecord>>("/measurements?per_page=1");
  const last = Math.max(1, Math.ceil(count / TAIL_PAGE_SIZE));
  const pages = await Promise.all(
    [last - 1, last]
      .filter((p) => p >= 1)
      .map((p) =>
        getJson<Page<MeasurementRecord>>(`/measurements?page=${p}&per_page=${TAIL_PAGE_SIZE}`),
      ),
  );

  // Row order is id order, which only happens to track date; a result entered
  // late would sit out of place. Take the max date ourselves.
  const ours = pages
    .flatMap((p) => p.list)
    .filter((m) => m.beach_id === BEACH_ID)
    .sort((a, b) => a.result_date.localeCompare(b.result_date));
  const m = ours.at(-1);
  if (!m) return null;

  return {
    date: m.result_date.slice(0, 10),
    rating: normaliseRating(m.sample_water_quality_status),
    eColi: m.e_coli_result?.trim() || "—",
    enterococci: m.intestinal_enterococci_result?.trim() || "—",
  };
});

const getActiveAlerts = cached(ALERTS_TTL_MS, async () => {
  const page = await getJson<Page<AlertRecord>>("/alerts?per_page=500");
  return page.list;
});

/** Today's date in Dublin as "YYYY-MM-DD" (server islands render in UTC). */
function dublinToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
}

function yes(v: string | null | undefined): boolean {
  return v?.trim().toLowerCase() === "yes";
}

export async function getBathingReport(): Promise<BathingReport | null> {
  const [loc, lastSample, alerts] = await Promise.all([
    getLocation(),
    getLatestSample(),
    getActiveAlerts(),
  ]);
  // The beach record carries the name and season/restriction flags — without it
  // there's no card worth drawing.
  if (!loc) return null;

  const a = alerts?.find(
    (x) => x.beach_id === BEACH_ID && !x.incident_end_date && yes(x.has_bathing_restriction_in_place),
  );
  const alert: BathingAlert | null = a
    ? {
        type: a.bathing_restriction_type?.trim() || "Bathing restriction in place",
        description: a.incident_description?.trim() ?? "",
        startDate: a.incident_start_date.slice(0, 10),
        expectedDays: a.incident_expected_duration,
        noticeUrl: a.bathing_notice_pdf,
      }
    : null;

  // The calendar backs up next_monitoring_date in case the EPA fills it in late
  // at the start of a season.
  const nextSampleDate = loc.next_monitoring_date?.slice(0, 10) ?? null;
  const md = dublinToday().slice(5);
  const inSeason = nextSampleDate !== null || (md >= SEASON_START && md <= SEASON_END);

  return {
    beachName: loc.beach_name,
    lastSample,
    alert,
    allSeasonRestriction: yes(loc.has_all_season_bathing_restriction_in_place)
      ? loc.reason_for_all_season_bathing_restriction?.trim() || "Bathing restricted all season"
      : null,
    inSeason,
    nextSampleDate,
    shortTermPollutionRisk: yes(loc.short_term_pollution_risk),
  };
}
