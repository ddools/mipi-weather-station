// The TGS2600 relative index barely moves — this station sits ~56–65 on the
// Foundation scale, ~62 most of the time (higher = more reducing gas: cooking,
// solvents, smoke). It is not a particulate (PM2.5) or AQI reading, and it has
// no absolute scale, so the card shows how far the index is above this sensor's
// own normal, with the raw number beside it. Thresholds are empirical
// percentiles of its history — re-tune AIR_GOOD_MAX / AIR_MODERATE_MAX if the
// baseline drifts (cook something and check it reaches "Raised").

export type AirBand = "good" | "moderate" | "poor" | "unknown";

export const AIR_GOOD_MAX = 63;
export const AIR_MODERATE_MAX = 64.5;
/** Where the index normally sits, for the caption under the reading. */
export const AIR_USUAL_RANGE = "56–63";

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
