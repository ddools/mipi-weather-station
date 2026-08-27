const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

export function degToCompass(deg: number | null): string {
  if (deg === null) return "—";
  const index = Math.round(deg / 22.5) % 16;
  return COMPASS[index];
}

export function fmt(value: number | null, digits = 1, unit = ""): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}${unit}`;
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

// --- Wind ------------------------------------------------------------------

export const MS_TO_KMH = 3.6;
export const MS_TO_KNOTS = 1.943844;

export function msToKmh(ms: number | null): number | null {
  return ms === null || Number.isNaN(ms) ? null : ms * MS_TO_KMH;
}

// Beaufort scale, keyed on the standard 10 m wind-speed bands (m/s).
const BEAUFORT: { maxMs: number; force: number; label: string }[] = [
  { maxMs: 0.5, force: 0, label: "Calm" },
  { maxMs: 1.5, force: 1, label: "Light air" },
  { maxMs: 3.3, force: 2, label: "Light breeze" },
  { maxMs: 5.5, force: 3, label: "Gentle breeze" },
  { maxMs: 7.9, force: 4, label: "Moderate breeze" },
  { maxMs: 10.7, force: 5, label: "Fresh breeze" },
  { maxMs: 13.8, force: 6, label: "Strong breeze" },
  { maxMs: 17.1, force: 7, label: "Near gale" },
  { maxMs: 20.7, force: 8, label: "Gale" },
  { maxMs: 24.4, force: 9, label: "Strong gale" },
  { maxMs: 28.4, force: 10, label: "Storm" },
  { maxMs: 32.6, force: 11, label: "Violent storm" },
  { maxMs: Infinity, force: 12, label: "Hurricane force" },
];

export function beaufort(ms: number | null): { force: number; label: string } | null {
  if (ms === null || Number.isNaN(ms)) return null;
  return BEAUFORT.find((b) => ms < b.maxMs) ?? BEAUFORT[BEAUFORT.length - 1];
}

// --- Pressure ------------------------------------------------------------------

export type PressureTrendKey = "rising" | "steady" | "falling";

export interface PressureTrend {
  key: PressureTrendKey;
  arrow: string;
  label: string;
  /** Change in hPa over the comparison window (now − past). */
  deltaHpa: number;
}

// Steady band is ±0.5 hPa/3h — roughly the "steady" threshold used on synoptic
// charts. Anything outside it counts as rising/falling.
export function pressureTrend(
  nowHpa: number | null,
  pastHpa: number | null
): PressureTrend | null {
  if (nowHpa === null || pastHpa === null || Number.isNaN(nowHpa) || Number.isNaN(pastHpa)) {
    return null;
  }
  const delta = nowHpa - pastHpa;
  if (delta > 0.5) return { key: "rising", arrow: "↑", label: "rising", deltaHpa: delta };
  if (delta < -0.5) return { key: "falling", arrow: "↓", label: "falling", deltaHpa: delta };
  return { key: "steady", arrow: "→", label: "steady", deltaHpa: delta };
}
