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
