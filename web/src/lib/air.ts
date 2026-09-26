// The TGS2600 relative index barely moves, and it drifts: it first sat ~56–65 on
// the Foundation scale, then crept up to a ~69 median within a month, as new gas
// sensors do (higher = more reducing gas: cooking, solvents, smoke). It is not a
// particulate (PM2.5) or AQI reading and has no absolute scale, so the card
// compares each reading with this sensor's own recent normal: the bands are
// fixed *margins* above a rolling 7-day median (lib/supabase.ts:getAirBaseline),
// so they follow the drift with no hand re-tuning.
//
// The margins come from the week to 2026-09-26, when the median was 69.4, p90
// 70.9 and p98 71.5 — i.e. ~10% of readings more than 1.5 above normal, ~2% more
// than 2.1. If "Raised" fires too often or never (cook something and check it
// reaches "Raised"), re-derive them from the same query and change the margins:
//
//   select percentile_cont(0.5)  within group (order by air_quality) as typical,
//          percentile_cont(0.9)  within group (order by air_quality) as p90,
//          percentile_cont(0.98) within group (order by air_quality) as p98
//   from readings
//   where air_quality is not null and recorded_at > now() - interval '7 days';

export type AirBand = "good" | "moderate" | "poor" | "unknown";

/** Above the baseline by at most this much is "Normal" (p90 − median). */
const GOOD_MARGIN = 1.5;
/** …and by at most this much "Slightly raised" (p98 − median); beyond is "Raised". */
const MODERATE_MARGIN = 2.1;
/** Used when there's no rolling baseline to hand (the week-to-2026-09-26 median). */
export const AIR_FALLBACK_BASELINE = 69.4;

export interface AirThresholds {
  /** The sensor's recent normal — rolling 7-day median. */
  baseline: number;
  goodMax: number;
  moderateMax: number;
}

export function airThresholds(baseline: number | null | undefined): AirThresholds {
  const b = baseline ?? AIR_FALLBACK_BASELINE;
  return { baseline: b, goodMax: b + GOOD_MARGIN, moderateMax: b + MODERATE_MARGIN };
}

/** Where the index normally sits, for the caption under the reading: "around 69–71". */
export function airUsualRange(t: AirThresholds): string {
  return `around ${Math.floor(t.baseline)}–${Math.round(t.goodMax)}`;
}

export interface AirQuality {
  band: AirBand;
  label: string;
  note: string;
}

const LABELS: Record<AirBand, string> = {
  good: "Normal",
  moderate: "Slightly raised",
  poor: "Raised",
  unknown: "—",
};

const NOTES: Record<AirBand, string> = {
  good: "about usual for this spot",
  moderate: "a little above usual — cooking or a car idling nearby",
  poor: "well above usual — smoke or fumes close to the station",
  unknown: "sensor warming up",
};

export function airQualityBand(
  index: number | null | undefined,
  t: AirThresholds = airThresholds(null)
): AirQuality {
  const band: AirBand =
    index == null || Number.isNaN(index)
      ? "unknown"
      : index <= t.goodMax
        ? "good"
        : index <= t.moderateMax
          ? "moderate"
          : "poor";
  return { band, label: LABELS[band], note: NOTES[band] };
}
