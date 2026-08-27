// Skerries Harbour, Co. Dublin. Open-Meteo's marine model is an ~8 km-resolution
// ocean model (hourly, mean-sea-level datum) — good enough for an approximate
// status display, not for navigation.
const LATITUDE = 53.5825;
const LONGITUDE = -6.1058;

// The model runs consistently early and low versus the Skerries Harbour harmonic
// prediction. Calibrated 2026-08-27 against tidetime.org — see
// `web/scripts/verify-tides.mjs`, which re-checks both numbers:
//
//   timing: model peaks land ~22 min early   → shift predicted times +22 min
//   datum:  model sits ~2.8 m below chart datum → add 2.8 m to every height
//
// These are coarse single-day fits, not a substitute for an official table.
// Re-run the verify script against a fresh reference day to re-tune.
const MODEL_LAG_CORRECTION_MIN = 22;
const CHART_DATUM_OFFSET_M = 2.8;

export interface TideEvent {
  /** ISO 8601 instant, UTC (with the trailing Z), model correction already applied. */
  time: string;
  heightM: number;
  type: "high" | "low";
}

export interface TidePoint {
  /** ISO 8601 instant, UTC, model timing correction already applied. */
  time: string;
  heightM: number;
}

export interface TideStatus {
  currentHeightM: number;
  trend: "rising" | "falling";
  nextHigh: TideEvent | null;
  nextLow: TideEvent | null;
  /** Most recent high/low before now — lets the card say "High tide" for the
   *  ~45 min around slack water on either side of the turn, not just before it. */
  lastExtreme: TideEvent | null;
  /** Hourly heights from ~4 h ago to ~16 h ahead, for drawing the tide curve. */
  curve: TidePoint[];
  /** Min/max height across `curve` — the visible tidal range, for the y-scale
   *  and for deciding "high/low tide now" vs "rising/falling". */
  rangeM: { min: number; max: number };
}

// How much of the curve to expose: a little history for context, then the day
// ahead. `now` lands ~20% from the left at these values.
const CURVE_BEFORE_MS = 4 * 3600_000;
const CURVE_AFTER_MS = 16 * 3600_000;

interface MarineResponse {
  hourly: {
    time: string[];
    sea_level_height_msl: (number | null)[];
  };
}

export async function getTideStatus(): Promise<TideStatus | null> {
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${LATITUDE}&longitude=${LONGITUDE}&hourly=sea_level_height_msl&forecast_days=3`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const data: MarineResponse = await res.json();
  const { time, sea_level_height_msl: heights } = data.hourly;
  if (!time?.length) return null;

  // Model timestamps have no zone suffix and are GMT/UTC — parse as such.
  const ms = time.map((t) => new Date(t + "Z").getTime());
  const now = Date.now();

  let nowIndex = 0;
  for (let i = 0; i < ms.length; i++) {
    if (ms[i] <= now) nowIndex = i;
    else break;
  }

  // Current height: linear-interpolate between the bracketing hourly samples
  // rather than snapping to the top of the hour.
  const h0 = heights[nowIndex];
  const h1 = heights[nowIndex + 1] ?? h0;
  let currentHeightM = 0;
  let trend: "rising" | "falling" = "rising";
  if (h0 !== null && h1 !== null) {
    const frac = (now - ms[nowIndex]) / (ms[nowIndex + 1] - ms[nowIndex] || 3600_000);
    const interp = h0 + (h1 - h0) * Math.max(0, Math.min(1, frac));
    currentHeightM = interp + CHART_DATUM_OFFSET_M;
    trend = h1 >= interp ? "rising" : "falling";
  }

  const events = findExtrema(ms, heights);
  const nextHigh = events.find((e) => e.type === "high" && new Date(e.time).getTime() > now) ?? null;
  const nextLow = events.find((e) => e.type === "low" && new Date(e.time).getTime() > now) ?? null;
  const lastExtreme =
    [...events].reverse().find((e) => new Date(e.time).getTime() <= now) ?? null;

  // Windowed hourly curve, same timing/datum corrections as the extrema so the
  // "now" dot and the high/low markers sit consistently on the drawn line.
  const curve: TidePoint[] = [];
  for (let i = 0; i < ms.length; i++) {
    const h = heights[i];
    if (h === null) continue;
    const t = ms[i] + MODEL_LAG_CORRECTION_MIN * 60_000;
    if (t < now - CURVE_BEFORE_MS || t > now + CURVE_AFTER_MS) continue;
    curve.push({ time: new Date(t).toISOString(), heightM: h + CHART_DATUM_OFFSET_M });
  }
  const inWindow = curve.map((p) => p.heightM);
  const rangeM = inWindow.length
    ? { min: Math.min(...inWindow), max: Math.max(...inWindow) }
    : { min: currentHeightM - 1, max: currentHeightM + 1 };

  return { currentHeightM, trend, nextHigh, nextLow, lastExtreme, curve, rangeM };
}

/**
 * Turning points of the hourly series, refined to sub-hourly precision by
 * fitting a parabola through each candidate and its two neighbours, then
 * applying the model's timing/datum corrections.
 */
function findExtrema(ms: number[], heights: (number | null)[]): TideEvent[] {
  const events: TideEvent[] = [];
  for (let i = 1; i < heights.length - 1; i++) {
    const prev = heights[i - 1];
    const curr = heights[i];
    const next = heights[i + 1];
    if (prev === null || curr === null || next === null) continue;

    const isHigh = curr > prev && curr > next;
    const isLow = curr < prev && curr < next;
    if (!isHigh && !isLow) continue;

    // Parabola y = a·x² + b·x + c through x = -1, 0, 1 (c = curr).
    const a = (prev + next) / 2 - curr;
    const b = (next - prev) / 2;
    const dx = a === 0 ? 0 : Math.max(-1, Math.min(1, -b / (2 * a)));
    const peakHeight = a * dx * dx + b * dx + curr;

    const peakMs =
      ms[i] + dx * (ms[i + 1] - ms[i]) + MODEL_LAG_CORRECTION_MIN * 60_000;

    events.push({
      time: new Date(peakMs).toISOString(),
      heightM: peakHeight + CHART_DATUM_OFFSET_M,
      type: isHigh ? "high" : "low",
    });
  }
  return events;
}
