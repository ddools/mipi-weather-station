// The TGS2600 relative index barely moves — this station sits ~56–65 on the
// Foundation scale, ~62 most of the time (higher = more reducing gas: cooking,
// solvents, smoke). A raw number that close together tells a viewer nothing, so
// the card shows a band instead. Thresholds are empirical percentiles of this
// sensor's own history, not an absolute scale — re-tune GOOD_MAX / MODERATE_MAX
// if its baseline drifts (cook something and check it reaches "Poor").

export type AirBand = "good" | "moderate" | "poor" | "unknown";

export const AIR_GOOD_MAX = 63;
export const AIR_MODERATE_MAX = 64.5;

export interface AirQuality {
  band: AirBand;
  label: string;
  note: string;
}

const NOTES: Record<AirBand, string> = {
  good: "nothing unusual in the air",
  moderate: "slightly raised — cooking or solvents nearby",
  poor: "raised — a strong nearby source",
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
  const label = band === "unknown" ? "—" : band[0].toUpperCase() + band.slice(1);
  return { band, label, note: NOTES[band] };
}
