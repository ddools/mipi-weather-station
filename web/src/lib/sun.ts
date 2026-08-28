// Sunrise / sunset for Skerries, Co. Dublin — computed locally, no API call.
// Port of the core of SunCalc (Vladimir Agafonkin, BSD-2-Clause): the standard
// low-precision solar-position algorithm, good to ~1 min for our latitude.

const LATITUDE = 53.5825;
const LONGITUDE = -6.1058;

const PI = Math.PI;
const rad = PI / 180;
const dayMs = 86_400_000;
const J1970 = 2_440_588;
const J2000 = 2_451_545;

const toJulian = (date: Date) => date.valueOf() / dayMs - 0.5 + J1970;
const fromJulian = (j: number) => new Date((j + 0.5 - J1970) * dayMs);
const toDays = (date: Date) => toJulian(date) - J2000;

const e = rad * 23.4397; // obliquity of the Earth

const solarMeanAnomaly = (d: number) => rad * (357.5291 + 0.98560028 * d);

function eclipticLongitude(M: number) {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = rad * 102.9372; // perihelion of the Earth
  return M + C + P + PI;
}

const declination = (l: number) => Math.asin(Math.sin(e) * Math.sin(l));

const J0 = 0.0009;
const julianCycle = (d: number, lw: number) => Math.round(d - J0 - lw / (2 * PI));
const approxTransit = (Ht: number, lw: number, n: number) => J0 + (Ht + lw) / (2 * PI) + n;
const solarTransitJ = (ds: number, M: number, L: number) =>
  J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

const hourAngle = (h: number, phi: number, d: number) =>
  Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));

export interface SunTimes {
  sunrise: Date;
  sunset: Date;
  solarNoon: Date;
  /** Seconds between sunrise and sunset. */
  daylightSeconds: number;
  /** daylight today minus daylight yesterday, in seconds (negative = shortening). */
  deltaVsYesterdaySeconds: number;
}

function timesFor(date: Date): { sunrise: Date; sunset: Date; solarNoon: Date } {
  const lw = rad * -LONGITUDE;
  const phi = rad * LATITUDE;
  const d = toDays(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const Jnoon = solarTransitJ(ds, M, L);

  const h0 = -0.833 * rad; // centre of the sun at the horizon, allowing for refraction
  const Jset = solarTransitJ(approxTransit(hourAngle(h0, phi, dec), lw, n), M, L);
  const Jrise = Jnoon - (Jset - Jnoon);

  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset), solarNoon: fromJulian(Jnoon) };
}

export function getSunTimes(now: Date = new Date()): SunTimes {
  const today = timesFor(now);
  const yesterday = timesFor(new Date(now.getTime() - dayMs));

  const daylightSeconds = (today.sunset.getTime() - today.sunrise.getTime()) / 1000;
  const yesterdayDaylight = (yesterday.sunset.getTime() - yesterday.sunrise.getTime()) / 1000;

  return {
    ...today,
    daylightSeconds,
    deltaVsYesterdaySeconds: daylightSeconds - yesterdayDaylight,
  };
}

/** "6h 12m", "14m", "0m" — coarse human duration from a second count. */
export function humanDuration(totalSeconds: number): string {
  const totalMin = Math.max(0, Math.round(totalSeconds / 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
