// Moon phase & illumination — computed locally, no API. Port of SunCalc's
// getMoonIllumination (Vladimir Agafonkin, BSD-2-Clause): the standard
// low-precision lunar-position model, accurate to well within what a phase
// display needs.

const rad = Math.PI / 180;
const dayMs = 86_400_000;
const J1970 = 2_440_588;
const J2000 = 2_451_545;
const e = rad * 23.4397; // obliquity of the ecliptic

const SYNODIC_MONTH_DAYS = 29.530588853;

const toDays = (date: Date) => date.valueOf() / dayMs - 0.5 + J1970 - J2000;

const rightAscension = (l: number, b: number) =>
  Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const declination = (l: number, b: number) =>
  Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));

function sunCoords(d: number) {
  const M = rad * (357.5291 + 0.98560028 * d);
  const L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
  return { ra: rightAscension(L, 0), dec: declination(L, 0) };
}

function moonCoords(d: number) {
  const L = rad * (218.316 + 13.176396 * d);
  const M = rad * (134.963 + 13.064993 * d);
  const F = rad * (93.272 + 13.22935 * d);
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  const dt = 385001 - 20905 * Math.cos(M);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
}

export interface MoonIllumination {
  /** Illuminated fraction of the disc, 0–1. */
  fraction: number;
  /** 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. */
  phase: number;
  /** Midpoint angle of the bright limb (radians); sign gives waxing/waning. */
  angle: number;
}

export function getMoonIllumination(date: Date = new Date()): MoonIllumination {
  const d = toDays(date);
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sdist = 149_598_000; // Earth–Sun distance, km

  const phi = Math.acos(
    Math.sin(s.dec) * Math.sin(m.dec) +
      Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra)
  );
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) -
      Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra)
  );

  return {
    fraction: (1 + Math.cos(inc)) / 2,
    phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI,
    angle,
  };
}

const PHASE_NAMES: { max: number; name: string; icon: string }[] = [
  { max: 0.0125, name: "New moon", icon: "moon-new" },
  { max: 0.2375, name: "Waxing crescent", icon: "moon-waxing-crescent" },
  { max: 0.2625, name: "First quarter", icon: "moon-first-quarter" },
  { max: 0.4875, name: "Waxing gibbous", icon: "moon-waxing-gibbous" },
  { max: 0.5125, name: "Full moon", icon: "moon-full" },
  { max: 0.7375, name: "Waning gibbous", icon: "moon-waning-gibbous" },
  { max: 0.7625, name: "Last quarter", icon: "moon-last-quarter" },
  { max: 0.9875, name: "Waning crescent", icon: "moon-waning-crescent" },
  { max: 1.0001, name: "New moon", icon: "moon-new" },
];

export interface MoonInfo {
  illuminationPct: number;
  phase: number;
  phaseName: string;
  /** Meteocons flat icon basename for this phase. */
  icon: string;
  waxing: boolean;
  /** Days since the last new moon. */
  ageDays: number;
  nextFull: Date;
  nextNew: Date;
}

// `phase` advances ~monotonically with time, so the signed distance to a target
// phase crosses zero exactly once per lunation. Wrapped to (−0.5, 0.5].
const signedPhaseDelta = (p: number, target: number) => {
  let d = p - target;
  if (d > 0.5) d -= 1;
  if (d <= -0.5) d += 1;
  return d;
};

/** Next time the moon reaches `targetPhase` (0 = new, 0.5 = full), after `from`. */
function nextPhaseCrossing(from: Date, targetPhase: number): Date {
  const stepMs = 6 * 3600_000;
  let prevT = from.getTime();
  // prevD < 0 → target still ahead this lunation (found within days);
  // prevD >= 0 → already past it, so we roll on to next lunation's crossing.
  let prevD = signedPhaseDelta(getMoonIllumination(from).phase, targetPhase);

  for (let t = prevT + stepMs; t <= from.getTime() + 31 * dayMs; t += stepMs) {
    const d = signedPhaseDelta(getMoonIllumination(new Date(t)).phase, targetPhase);
    if (prevD < 0 && d >= 0) {
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        if (signedPhaseDelta(getMoonIllumination(new Date(mid)).phase, targetPhase) < 0) lo = mid;
        else hi = mid;
      }
      return new Date((lo + hi) / 2);
    }
    prevT = t;
    prevD = d;
  }
  return new Date(from.getTime() + SYNODIC_MONTH_DAYS * dayMs);
}

export function getMoonInfo(date: Date = new Date()): MoonInfo {
  const ill = getMoonIllumination(date);
  const band = PHASE_NAMES.find((b) => ill.phase < b.max) ?? PHASE_NAMES.at(-1)!;
  return {
    illuminationPct: ill.fraction * 100,
    phase: ill.phase,
    phaseName: band.name,
    icon: band.icon,
    waxing: ill.phase < 0.5,
    ageDays: ill.phase * SYNODIC_MONTH_DAYS,
    nextFull: nextPhaseCrossing(date, 0.5),
    nextNew: nextPhaseCrossing(date, 0),
  };
}
