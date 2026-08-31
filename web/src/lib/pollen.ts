// Pollen for Skerries from the Open-Meteo Air Quality API (CAMS European model,
// hourly, grains/m³). No key. Same provider family as tides.ts. Europe-only —
// fine for Dublin.

const LATITUDE = 53.5846;
const LONGITUDE = -6.1398;

const SPECIES: { key: string; label: string; group: PollenGroup }[] = [
  { key: "alder_pollen", label: "Alder", group: "tree" },
  { key: "birch_pollen", label: "Birch", group: "tree" },
  { key: "olive_pollen", label: "Olive", group: "tree" },
  { key: "grass_pollen", label: "Grass", group: "grass" },
  { key: "mugwort_pollen", label: "Mugwort", group: "weed" },
  { key: "ragweed_pollen", label: "Ragweed", group: "weed" },
];

type PollenGroup = "tree" | "grass" | "weed";
export type PollenLevel = "none" | "low" | "moderate" | "high" | "very-high";

// Upper bounds (grains/m³) for low / moderate / high; above "high" is very-high.
// Rough consensus bands — tree counts run an order of magnitude higher than weed.
const BANDS: Record<PollenGroup, { low: number; moderate: number; high: number }> = {
  tree: { low: 10, moderate: 90, high: 1500 },
  grass: { low: 20, moderate: 50, high: 200 },
  weed: { low: 10, moderate: 50, high: 500 },
};

const LEVEL_RANK: Record<PollenLevel, number> = {
  none: 0,
  low: 1,
  moderate: 2,
  high: 3,
  "very-high": 4,
};

function levelFor(group: PollenGroup, value: number): PollenLevel {
  if (value <= 0) return "none";
  const b = BANDS[group];
  if (value < b.low) return "low";
  if (value < b.moderate) return "moderate";
  if (value < b.high) return "high";
  return "very-high";
}

export interface PollenSpecies {
  key: string;
  label: string;
  group: PollenGroup;
  now: number;
  peakToday: number;
  level: PollenLevel;
}

export interface PollenReport {
  overall: PollenLevel;
  headline: string;
  /** Species with a non-zero count today, worst level first. Empty when nothing is in the air. */
  active: PollenSpecies[];
  updated: string;
}

interface AirQualityResponse {
  hourly: Record<string, (number | null)[]> & { time: string[] };
}

export async function getPollen(): Promise<PollenReport | null> {
  const hourly = SPECIES.map((s) => s.key).join(",");
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LATITUDE}` +
    `&longitude=${LONGITUDE}&hourly=${hourly}&timezone=Europe%2FDublin&forecast_days=1`;

  let data: AirQualityResponse;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }

  const times = data.hourly?.time;
  if (!times?.length) return null;

  // Timestamps are local (timezone=Europe/Dublin), no zone suffix. Find the row
  // for the current local hour.
  const nowLocal = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Dublin" }); // "YYYY-MM-DD HH:mm:ss"
  const nowHourKey = nowLocal.slice(0, 13).replace(" ", "T");
  let idx = times.findIndex((t) => t.slice(0, 13) === nowHourKey);
  if (idx < 0) idx = times.length - 1;

  const species: PollenSpecies[] = SPECIES.map(({ key, label, group }) => {
    const col = data.hourly[key] ?? [];
    const now = col[idx] ?? 0;
    const peakToday = col.reduce((m: number, v) => Math.max(m, v ?? 0), 0);
    return { key, label, group, now, peakToday, level: levelFor(group, Math.max(now, 0)) };
  });

  const active = species
    .filter((s) => s.peakToday > 0)
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.now - a.now);

  const overall =
    active.reduce<PollenLevel>(
      (worst, s) => (LEVEL_RANK[s.level] > LEVEL_RANK[worst] ? s.level : worst),
      "none"
    ) ?? "none";

  const top = active[0];
  const headline =
    overall === "none"
      ? "Nothing significant in the air"
      : overall === "low"
        ? "Low across the board"
        : `${top.label} pollen ${overall.replace("-", " ")}`;

  return { overall, headline, active, updated: times[idx] };
}
