const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/** Shown wherever a sensor value is missing — a genuine gap, never a stand-in number. */
export const NO_VALUE = "N/A";

export function degToCompass(deg: number | null): string {
  if (deg === null) return NO_VALUE;
  const index = Math.round(deg / 22.5) % 16;
  return COMPASS[index];
}

export function fmt(value: number | null, digits = 1, unit = ""): string {
  if (value === null || Number.isNaN(value)) return NO_VALUE;
  return `${value.toFixed(digits)}${unit}`;
}

/**
 * Words for a current rain rate in mm/h. `null` (no recent readings) reads as a
 * gap; `0` is a genuinely dry spell. Bands follow the usual met-service cuts
 * (light < 2.5, moderate < 7.6, heavy above).
 */
export function rainIntensity(mmPerHour: number | null): string {
  if (mmPerHour === null || Number.isNaN(mmPerHour)) return "no recent data";
  if (mmPerHour <= 0) return "dry";
  if (mmPerHour < 0.5) return "a trace";
  if (mmPerHour < 2.5) return "light rain";
  if (mmPerHour < 7.6) return "moderate rain";
  return "heavy rain";
}

// --- Countdowns ------------------------------------------------------------
//
// One rule for every "in …" on the site: hours and minutes under a day, then
// "tomorrow" or "in N days" by the Dublin calendar. Server-rendered text is
// only right at render time, so anything marked `data-until` is re-rendered in
// the browser every few seconds by lib/live-times.ts.

const DAY_MS = 86_400_000;

/** Calendar date in Dublin as a day number, for counting midnights crossed. */
function dublinDayNumber(ms: number): number {
  const ymd = new Date(ms).toLocaleDateString("en-CA", { timeZone: "Europe/Dublin" });
  return Date.parse(`${ymd}T00:00:00Z`) / DAY_MS;
}

export function untilLabel(target: string | number | Date, now: number = Date.now()): string {
  const t = new Date(target).getTime();
  const mins = Math.ceil((t - now) / 60_000);
  if (Number.isNaN(mins)) return "";
  if (mins <= 0) return "now";
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `in ${h}h ${m}m` : `in ${m}m`;
  }
  const days = dublinDayNumber(t) - dublinDayNumber(now);
  return days <= 1 ? "tomorrow" : `in ${days} days`;
}

/** Age of a reading: "40s ago", "6m ago", "2h 5m ago", "3 days ago". */
export function ageLabel(iso: string | number | Date, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m ago` : `${h}h ago`;
  const days = Math.floor(h / 24);
  return days === 1 ? "a day ago" : `${days} days ago`;
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

/** Vector (circular) mean of a set of compass bearings in degrees, 0–360.
 *  Returns null for an empty list. De-noises a jittery wind vane. */
export function circularMean(degs: number[]): number | null {
  if (degs.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const d of degs) {
    const r = (d * Math.PI) / 180;
    x += Math.cos(r);
    y += Math.sin(r);
  }
  if (x === 0 && y === 0) return null;
  const mean = (Math.atan2(y, x) * 180) / Math.PI;
  return (mean + 360) % 360;
}

/** Signed smallest angle from `from` to `to`, in degrees, −180..180.
 *  Positive = clockwise (veering), negative = anticlockwise (backing). */
export function angularDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

export type VeerBack = "veering" | "backing" | "steady";

/** Classify an `angularDelta` result. Under ~8° of movement reads as steady. */
export function veerBack(delta: number, steadyBand = 8): VeerBack {
  if (delta > steadyBand) return "veering";
  if (delta < -steadyBand) return "backing";
  return "steady";
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

// --- Generic trend -----------------------------------------------------------

export type TrendKey = "up" | "flat" | "down";

export interface Trend {
  key: TrendKey;
  /** ↑ ↗ → ↘ ↓ depending on magnitude relative to `steadyBand`. */
  arrow: string;
  /** now − past, signed, in the value's own unit. */
  delta: number;
}

/**
 * Direction of change between a past and a current value. `steadyBand` is the
 * ± window (same unit as the values) inside which the change reads as "flat";
 * a change of more than 3× the band gets the steeper arrow.
 */
export function trend(
  now: number | null,
  past: number | null,
  steadyBand: number
): Trend | null {
  if (now === null || past === null || Number.isNaN(now) || Number.isNaN(past)) return null;
  const delta = now - past;
  const mag = Math.abs(delta);
  if (mag <= steadyBand) return { key: "flat", arrow: "→", delta };
  const steep = mag > steadyBand * 3;
  if (delta > 0) return { key: "up", arrow: steep ? "↑" : "↗", delta };
  return { key: "down", arrow: steep ? "↓" : "↘", delta };
}
