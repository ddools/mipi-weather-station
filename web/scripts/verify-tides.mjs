#!/usr/bin/env node
// Accuracy check for the Tides card.
//
// Fetches Open-Meteo's marine model for Skerries Harbour, derives high/low
// events with the SAME parabola + correction math as src/lib/tides.ts, and
// diffs them against a hardcoded harmonic reference (tidetime.org). Prints a
// table and exits non-zero if the fit has drifted.
//
//   node web/scripts/verify-tides.mjs
//
// The MODEL_LAG_CORRECTION_MIN / CHART_DATUM_OFFSET_M constants below must stay
// in sync with src/lib/tides.ts. When the reference window is in the past and
// the marine API stops serving it, swap in a fresh day from tidetime.org and
// re-tune the two constants until this passes.

const LATITUDE = 53.5825;
const LONGITUDE = -6.1058;
const MODEL_LAG_CORRECTION_MIN = 22;
const CHART_DATUM_OFFSET_M = 2.8;

// tidetime.org — Skerries, tide times given in IST (UTC+1 in August).
const REFERENCE = [
  { type: "low", time: "2026-08-27T05:26:00+01:00", heightM: 0.87 },
  { type: "high", time: "2026-08-27T12:08:00+01:00", heightM: 3.84 },
  { type: "low", time: "2026-08-27T17:35:00+01:00", heightM: 1.0 },
  { type: "high", time: "2026-08-28T00:16:00+01:00", heightM: 4.15 },
  { type: "low", time: "2026-08-28T05:59:00+01:00", heightM: 0.72 },
  { type: "high", time: "2026-08-28T12:41:00+01:00", heightM: 3.95 },
  { type: "low", time: "2026-08-28T18:07:00+01:00", heightM: 0.86 },
];
const START = "2026-08-27";
const END = "2026-08-29";

const TIME_TOLERANCE_MIN = 20;
const HEIGHT_TOLERANCE_M = 0.6;

function findExtrema(ms, heights) {
  const events = [];
  for (let i = 1; i < heights.length - 1; i++) {
    const [prev, curr, next] = [heights[i - 1], heights[i], heights[i + 1]];
    if (prev == null || curr == null || next == null) continue;
    const isHigh = curr > prev && curr > next;
    const isLow = curr < prev && curr < next;
    if (!isHigh && !isLow) continue;

    const a = (prev + next) / 2 - curr;
    const b = (next - prev) / 2;
    const dx = a === 0 ? 0 : Math.max(-1, Math.min(1, -b / (2 * a)));
    const peakHeight = a * dx * dx + b * dx + curr;
    const peakMs = ms[i] + dx * (ms[i + 1] - ms[i]) + MODEL_LAG_CORRECTION_MIN * 60_000;

    events.push({
      type: isHigh ? "high" : "low",
      time: new Date(peakMs),
      heightM: peakHeight + CHART_DATUM_OFFSET_M,
    });
  }
  return events;
}

const ist = (d) =>
  d.toLocaleString("en-IE", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Dublin",
  });

const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${LATITUDE}&longitude=${LONGITUDE}&hourly=sea_level_height_msl&start_date=${START}&end_date=${END}`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`Open-Meteo request failed: ${res.status} ${res.statusText}`);
  process.exit(2);
}
const { hourly } = await res.json();
const ms = hourly.time.map((t) => new Date(t + "Z").getTime());
const predicted = findExtrema(ms, hourly.sea_level_height_msl);

let timeErrors = [];
let heightErrors = [];

console.log("\nevent   reference (IST)      predicted (IST)      Δ time   ref h   pred h   Δ h");
console.log("-".repeat(84));
for (const ref of REFERENCE) {
  const refDate = new Date(ref.time);
  const match = predicted
    .filter((p) => p.type === ref.type)
    .sort((x, y) => Math.abs(x.time - refDate) - Math.abs(y.time - refDate))[0];
  if (!match) {
    console.log(`${ref.type.padEnd(6)}  ${ist(refDate).padEnd(20)} (no model match)`);
    timeErrors.push(999);
    continue;
  }
  const dtMin = Math.round((match.time - refDate) / 60_000);
  const dh = match.heightM - ref.heightM;
  timeErrors.push(Math.abs(dtMin));
  heightErrors.push(Math.abs(dh));
  console.log(
    `${ref.type.padEnd(6)}  ${ist(refDate).padEnd(20)} ${ist(match.time).padEnd(20)} ` +
      `${String(dtMin >= 0 ? "+" + dtMin : dtMin).padStart(5)}m   ` +
      `${ref.heightM.toFixed(2)}    ${match.heightM.toFixed(2)}    ${dh >= 0 ? "+" : ""}${dh.toFixed(2)}`
  );
}

const meanTime = timeErrors.reduce((a, b) => a + b, 0) / timeErrors.length;
const maxTime = Math.max(...timeErrors);
const meanHeight = heightErrors.reduce((a, b) => a + b, 0) / heightErrors.length;

console.log("-".repeat(84));
console.log(
  `mean |Δ time| ${meanTime.toFixed(1)} min   max ${maxTime} min   mean |Δ height| ${meanHeight.toFixed(2)} m\n`
);

const pass = meanTime <= TIME_TOLERANCE_MIN && meanHeight <= HEIGHT_TOLERANCE_M;
console.log(pass ? "PASS — tide calibration within tolerance" : "FAIL — recalibrate constants in src/lib/tides.ts");
process.exit(pass ? 0 : 1);
