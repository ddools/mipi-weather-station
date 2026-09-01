// 5-day forecast for Skerries from the Open-Meteo forecast API — free, no key,
// same provider family as tides.ts and pollen.ts. Daily aggregates only (one
// card per day); hourly is deliberately out of scope.

const LATITUDE = 53.5825;
const LONGITUDE = -6.1058;
const TIMEZONE = "Europe/Dublin";

const DAILY_FIELDS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_sum",
  "precipitation_probability_max",
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
  "wind_direction_10m_dominant",
] as const;

export interface ForecastDay {
  /** ISO local date, "YYYY-MM-DD". */
  date: string;
  /** "Today", then "Mon", "Tue", … */
  weekday: string;
  /** meteocons flat icon basename, e.g. "partly-cloudy-day". */
  icon: string;
  label: string;
  tempMax: number | null;
  tempMin: number | null;
  precipMm: number | null;
  precipProbPct: number | null;
  windMaxKmh: number | null;
  gustMaxKmh: number | null;
  windDirDeg: number | null;
}

// WMO weather-interpretation codes → (day-variant) meteocons + a short label.
// https://open-meteo.com/en/docs — "Weather variable documentation".
const WMO: Record<number, { icon: string; label: string }> = {
  0: { icon: "clear-day", label: "Clear" },
  1: { icon: "clear-day", label: "Mainly clear" },
  2: { icon: "partly-cloudy-day", label: "Partly cloudy" },
  3: { icon: "overcast-day", label: "Overcast" },
  45: { icon: "fog-day", label: "Fog" },
  48: { icon: "fog-day", label: "Rime fog" },
  51: { icon: "drizzle", label: "Light drizzle" },
  53: { icon: "drizzle", label: "Drizzle" },
  55: { icon: "drizzle", label: "Heavy drizzle" },
  56: { icon: "sleet", label: "Freezing drizzle" },
  57: { icon: "sleet", label: "Freezing drizzle" },
  61: { icon: "rain", label: "Light rain" },
  63: { icon: "rain", label: "Rain" },
  65: { icon: "rain", label: "Heavy rain" },
  66: { icon: "sleet", label: "Freezing rain" },
  67: { icon: "sleet", label: "Freezing rain" },
  71: { icon: "snow", label: "Light snow" },
  73: { icon: "snow", label: "Snow" },
  75: { icon: "snow", label: "Heavy snow" },
  77: { icon: "snow", label: "Snow grains" },
  80: { icon: "partly-cloudy-day-rain", label: "Light showers" },
  81: { icon: "partly-cloudy-day-rain", label: "Showers" },
  82: { icon: "partly-cloudy-day-rain", label: "Heavy showers" },
  85: { icon: "snow", label: "Snow showers" },
  86: { icon: "snow", label: "Snow showers" },
  95: { icon: "thunderstorms-day", label: "Thunderstorm" },
  96: { icon: "thunderstorms-day-rain", label: "Thunderstorm, hail" },
  99: { icon: "thunderstorms-day-rain", label: "Thunderstorm, hail" },
};
const WMO_FALLBACK = { icon: "overcast-day", label: "—" };

// Day-icon basename → its night counterpart, where Meteocons has one.
const NIGHT: Record<string, string> = {
  "clear-day": "clear-night",
  "partly-cloudy-day": "partly-cloudy-night",
  "partly-cloudy-day-rain": "partly-cloudy-night-rain",
  "overcast-day": "overcast-night",
  "fog-day": "fog-night",
  "thunderstorms-day": "thunderstorms-night",
  "thunderstorms-day-rain": "thunderstorms-night-rain",
};

export interface CurrentSky {
  /** Meteocons flat icon basename, day or night variant. */
  icon: string;
  label: string;
  isDay: boolean;
}

interface ForecastResponse {
  daily?: Record<string, (number | null)[]> & { time: string[] };
  current?: { weather_code?: number; is_day?: number };
}

let skyCache: { at: number; data: CurrentSky } | null = null;

/** Current sky condition (icon + label) from Open-Meteo's `current` block. The
 *  station has no cloud/condition sensor, so this is the one outside input a
 *  "current conditions" hero needs. 15-min memo. */
export async function getCurrentSky(): Promise<CurrentSky | null> {
  if (skyCache && Date.now() - skyCache.at < 15 * 60_000) return skyCache.data;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&current=weather_code,is_day&timezone=${encodeURIComponent(TIMEZONE)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return skyCache?.data ?? null;
    const data: ForecastResponse = await res.json();
    const code = data.current?.weather_code ?? null;
    const isDay = data.current?.is_day !== 0;
    const base = code != null ? (WMO[code] ?? WMO_FALLBACK) : WMO_FALLBACK;
    const icon = isDay ? base.icon : (NIGHT[base.icon] ?? base.icon);
    const sky: CurrentSky = { icon, label: base.label, isDay };
    skyCache = { at: Date.now(), data: sky };
    return sky;
  } catch {
    return skyCache?.data ?? null;
  }
}

let cache: { at: number; data: ForecastDay[] } | null = null;
const TTL_MS = 30 * 60_000;

export async function getForecast(): Promise<ForecastDay[] | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&daily=${DAILY_FIELDS.join(",")}&wind_speed_unit=kmh` +
    `&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=5`;

  let data: ForecastResponse;
  try {
    const res = await fetch(url);
    if (!res.ok) return cache?.data ?? null;
    data = await res.json();
  } catch {
    return cache?.data ?? null;
  }

  const daily = data.daily;
  if (!daily?.time?.length) return cache?.data ?? null;

  const todayStr = new Date()
    .toLocaleString("sv-SE", { timeZone: TIMEZONE })
    .slice(0, 10);

  const at = (field: string, i: number): number | null => {
    const v = daily[field]?.[i];
    return typeof v === "number" && !Number.isNaN(v) ? v : null;
  };

  const days: ForecastDay[] = daily.time.map((date, i) => {
    const code = at("weather_code", i);
    const wmo = code != null ? (WMO[code] ?? WMO_FALLBACK) : WMO_FALLBACK;
    const weekday =
      date === todayStr
        ? "Today"
        : new Date(`${date}T12:00:00`).toLocaleDateString("en-IE", {
            weekday: "short",
            timeZone: TIMEZONE,
          });
    return {
      date,
      weekday,
      icon: wmo.icon,
      label: wmo.label,
      tempMax: at("temperature_2m_max", i),
      tempMin: at("temperature_2m_min", i),
      precipMm: at("precipitation_sum", i),
      precipProbPct: at("precipitation_probability_max", i),
      windMaxKmh: at("wind_speed_10m_max", i),
      gustMaxKmh: at("wind_gusts_10m_max", i),
      windDirDeg: at("wind_direction_10m_dominant", i),
    };
  });

  cache = { at: Date.now(), data: days };
  return days;
}
