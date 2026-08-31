// Quantities derived from a single reading — no extra data source, just physics.

export type FeelsLikeKind = "wind-chill" | "humidex" | "actual";

export interface FeelsLike {
  /** "Feels like" temperature, °C. */
  value: number;
  /** value − actual air temperature, °C. */
  delta: number;
  kind: FeelsLikeKind;
  caption: string;
}

/** Environment Canada wind chill, °C. Only meaningful for T ≤ 10 °C, wind > 4.8 km/h. */
function windChillC(tempC: number, windKmh: number): number {
  const v = Math.pow(windKmh, 0.16);
  return 13.12 + 0.6215 * tempC - 11.37 * v + 0.3965 * tempC * v;
}

/** Environment Canada humidex, °C — how warm it feels once humidity is added in. */
function humidexC(tempC: number, dewPointC: number): number {
  const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / (273.15 + dewPointC)));
  return tempC + 0.5555 * (e - 10);
}

/**
 * "Feels like" temperature, presented the way weather apps do: wind chill when
 * it's cold and breezy, humidex when it's warm and muggy, and the actual air
 * temperature the rest of the time (so a calm mild day doesn't read as colder
 * than it is). `dewPointC` drives the humidex; pass the reading's own value.
 */
export function feelsLike(
  tempC: number | null,
  windMs: number | null,
  dewPointC: number | null
): FeelsLike | null {
  if (tempC === null || Number.isNaN(tempC)) return null;
  const windKmh = windMs !== null && !Number.isNaN(windMs) ? Math.max(0, windMs) * 3.6 : 0;

  if (tempC <= 10 && windKmh > 4.8) {
    const wc = windChillC(tempC, windKmh);
    if (wc < tempC - 0.4) {
      return { value: wc, delta: wc - tempC, kind: "wind-chill", caption: "wind chill" };
    }
  }

  if (tempC >= 20 && dewPointC !== null && !Number.isNaN(dewPointC)) {
    const hx = humidexC(tempC, dewPointC);
    if (hx > tempC + 0.4) {
      return { value: hx, delta: hx - tempC, kind: "humidex", caption: "humidity making it feel warmer" };
    }
  }

  return { value: tempC, delta: 0, kind: "actual", caption: "same as the air temperature" };
}

// --- Dew-point comfort -------------------------------------------------------

const DEWPOINT_BANDS: { maxC: number; label: string }[] = [
  { maxC: 10, label: "dry" },
  { maxC: 13, label: "comfortable" },
  { maxC: 16, label: "becoming sticky" },
  { maxC: 18, label: "humid" },
  { maxC: 21, label: "very humid" },
  { maxC: Infinity, label: "oppressive" },
];

/** Plain-language humidity comfort from the dew point (°C). */
export function dewPointComfort(dewC: number | null): string | null {
  if (dewC === null || Number.isNaN(dewC)) return null;
  return (DEWPOINT_BANDS.find((b) => dewC < b.maxC) ?? DEWPOINT_BANDS.at(-1)!).label;
}
