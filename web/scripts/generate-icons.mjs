#!/usr/bin/env node
// Regenerates the PWA icons in public/icons/ from public/favicon.svg.
//
//   npm run icons        (needs rsvg-convert: brew install librsvg)
//
// One windmill mark on a dark-slate ground, so a single icon reads on both a
// light and a dark home screen. Two shapes are produced:
//
//   any       rounded square, mark at 70% — used as-is by desktop installs
//   maskable  full-bleed square, mark at 52% — Android crops this to whatever
//             shape the launcher uses, and the safe zone is only the central
//             80% circle, so the mark needs the extra margin
//
// The generated PNGs are committed; this only needs re-running when the
// favicon changes.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "icons");

const BACKGROUND = "#2b303b"; // --background, dark theme
const FOREGROUND = "#fafafa"; // --foreground, dark theme

const ICONS = [
  { name: "icon-192.png", size: 192, scale: 0.7, rounded: true },
  { name: "icon-512.png", size: 512, scale: 0.7, rounded: true },
  { name: "icon-maskable-192.png", size: 192, scale: 0.52, rounded: false },
  { name: "icon-maskable-512.png", size: 512, scale: 0.52, rounded: false },
  { name: "apple-touch-icon.png", size: 180, scale: 0.66, rounded: false },
];

const favicon = readFileSync(join(ROOT, "public", "favicon.svg"), "utf8");
const path = favicon.match(/<path d="([\s\S]*?)"\s*\/>/)?.[1];
if (!path) throw new Error("no <path d> found in public/favicon.svg");

/** The favicon's mark is drawn in a 14x14 viewBox; centre it on a `size` canvas. */
function render({ size, scale, rounded }) {
  const span = size * scale;
  const offset = (size - span) / 2;
  const radius = rounded ? ` rx="${(size * 0.18).toFixed(1)}"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}"${radius} fill="${BACKGROUND}"/>` +
    `<g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) ` +
    `scale(${(span / 14).toFixed(6)})"><path fill="${FOREGROUND}" d="${path}"/></g></svg>`
  );
}

mkdirSync(OUT_DIR, { recursive: true });
for (const icon of ICONS) {
  const source = join(tmpdir(), `ws-${icon.name}.svg`);
  writeFileSync(source, render(icon));
  execFileSync("rsvg-convert", [
    "-w", String(icon.size), "-h", String(icon.size),
    "-o", join(OUT_DIR, icon.name), source,
  ]);
  console.log(`${icon.name}  ${icon.size}x${icon.size}`);
}
