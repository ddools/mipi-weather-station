// The TGS2600 relative index barely moves — over the week to 2026-09-26 this
// station's median was 69.4 on the Foundation scale, p90 70.9, p98 71.5 (higher =
// more reducing gas: cooking, solvents, smoke). It first sat ~56–65 and drifted
// up after fitting, as new gas sensors do. It is not a particulate (PM2.5) or AQI reading, and it has
// no absolute scale, so the card shows how far the index is above this sensor's
// own normal, with the raw number beside it. Thresholds are percentiles of the
// last week (GOOD_MAX = p90, MODERATE_MAX = p98) — re-tune all three constants
// if the baseline drifts again (cook something and check it reaches "Raised"):
//
//   select percentile_cont(0.5)  within group (order by air_quality) as typical,
//          percentile_cont(0.9)  within group (order by air_quality) as p90,
//          percentile_cont(0.98) within group (order by air_quality) as p98
//   from readings
//   where air_quality is not null and recorded_at > now() - interval '7 days';

export type AirBand = "good" | "moderate" | "poor" | "unknown";

export const AIR_GOOD_MAX = 70.9;
export const AIR_MODERATE_MAX = 71.5;
/** Where the index normally sits, for the caption under the reading. */
export const AIR_USUAL_RANGE = "around 69–71";

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

export function airQualityBand(index: number | null | undefined): AirQuality {
  const band: AirBand =
    index == null || Number.isNaN(index)
      ? "unknown"
      : index <= AIR_GOOD_MAX
        ? "good"
        : index <= AIR_MODERATE_MAX
          ? "moderate"
          : "poor";
  return { band, label: LABELS[band], note: NOTES[band] };
}
