#!/usr/bin/env node
// Writes Nord-coloured copies of the Meteocons weather glyphs the site uses into
// public/weather-icons/.
//
//   pnpm weather-icons
//
// Two files per glyph:
//
//   <name>.svg           still: one frozen frame of the animation (stripping it
//                        outright hides the raindrops, which only fade in while
//                        moving). Used everywhere by default, and by the hero
//                        under prefers-reduced-motion
//   <name>-animated.svg  animated at half speed. Only the hero uses it, so at
//                        most one icon on the page is moving
//
// The output is committed; re-run after bumping @meteocons/svg or changing the
// list below (which must cover every name lib/forecast.ts can produce).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freezeAnimation, nordify, slowAnimation } from "../src/lib/meteocons.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "node_modules", "@meteocons", "svg", "flat");
const OUT = join(ROOT, "public", "weather-icons");

const NAMES = [
  "clear-day",
  "clear-night",
  "partly-cloudy-day",
  "partly-cloudy-night",
  "partly-cloudy-day-rain",
  "partly-cloudy-night-rain",
  "overcast-day",
  "overcast-night",
  "fog-day",
  "fog-night",
  "drizzle",
  "sleet",
  "rain",
  "snow",
  "thunderstorms-day",
  "thunderstorms-night",
  "thunderstorms-day-rain",
  "thunderstorms-night-rain",
];

const SLOWDOWN = 2;
// The moment (seconds into the loop) the still frame is taken at. Multiples of
// 0.75 s leave the sun's rays square (8 rays, one turn per 6 s); of those, 1.5 s
// catches the lightning lit and the most raindrops visible.
const STILL_AT = 1.5;

mkdirSync(OUT, { recursive: true });
for (const name of NAMES) {
  const svg = nordify(readFileSync(join(SRC, `${name}.svg`), "utf8"));
  writeFileSync(join(OUT, `${name}.svg`), freezeAnimation(svg, STILL_AT));
  writeFileSync(join(OUT, `${name}-animated.svg`), slowAnimation(svg, SLOWDOWN));
  console.log(name);
}
