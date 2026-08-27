// Balbriggan, Co. Dublin — nearest coastal town with tide data relevant to
// a Skerries-area station. Open-Meteo's marine model is an ~8km-resolution
// ocean model, not official harmonic tide-gauge predictions — good enough for
// an approximate status display, not for navigation.
const LATITUDE = 53.6094;
const LONGITUDE = -6.1836;

export interface TideEvent {
  time: string;
  heightM: number;
  type: "high" | "low";
}

export interface TideStatus {
  currentHeightM: number;
  trend: "rising" | "falling";
  nextHigh: TideEvent | null;
  nextLow: TideEvent | null;
}

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

  const now = Date.now();
  let nowIndex = 0;
  for (let i = 0; i < time.length; i++) {
    if (new Date(time[i] + "Z").getTime() <= now) nowIndex = i;
    else break;
  }

  const events = findExtrema(time, heights);
  const nextHigh = events.find((e) => e.type === "high" && new Date(e.time + "Z").getTime() > now) ?? null;
  const nextLow = events.find((e) => e.type === "low" && new Date(e.time + "Z").getTime() > now) ?? null;

  const current = heights[nowIndex] ?? 0;
  const next = heights[nowIndex + 1] ?? current;

  return {
    currentHeightM: current,
    trend: next >= current ? "rising" : "falling",
    nextHigh,
    nextLow,
  };
}

function findExtrema(time: string[], heights: (number | null)[]): TideEvent[] {
  const events: TideEvent[] = [];
  for (let i = 1; i < heights.length - 1; i++) {
    const prev = heights[i - 1];
    const curr = heights[i];
    const next = heights[i + 1];
    if (prev === null || curr === null || next === null) continue;

    if (curr > prev && curr > next) {
      events.push({ time: time[i], heightM: curr, type: "high" });
    } else if (curr < prev && curr < next) {
      events.push({ time: time[i], heightM: curr, type: "low" });
    }
  }
  return events;
}
