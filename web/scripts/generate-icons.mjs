#!/usr/bin/env node
// Regenerates the PWA icons in public/icons/ and the link-preview image
// public/og.png from public/favicon.svg.
//
//   pnpm icons        (needs rsvg-convert: brew install librsvg)
//
// One windmill mark on a dark-slate ground, so a single icon reads on both a
// light and a dark home screen. Two shapes are produced:
//
//   any       rounded square, mark at 70% — used as-is by desktop installs
//   maskable  full-bleed square, mark at 52% — Android crops this to whatever
//             shape the launcher uses, and the safe zone is only the central
//             80% circle, so the mark needs the extra margin
//
// og.png is the 1200x630 card chat apps and social sites show for a shared
// link (og:image / twitter:image in Layout.astro).
//
// The generated PNGs are committed; this only needs re-running when the
// favicon or the site's name/description changes.

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

// --- Link preview ------------------------------------------------------------

const OG = { width: 1200, height: 630 };
const MUTED = "#b4b4b4"; // --muted-foreground, dark theme (oklch 0.75)
const ACCENT = "#88c0d0"; // Nord frost

function renderOg() {
  const { width, height } = OG;
  const mark = 150;
  const font = "Helvetica Neue, Helvetica, Arial, sans-serif";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${BACKGROUND}"/>` +
    `<rect y="${height - 12}" width="${width}" height="12" fill="${ACCENT}"/>` +
    `<g transform="translate(90 110) scale(${(mark / 14).toFixed(6)})">` +
    `<path fill="${FOREGROUND}" d="${path}"/></g>` +
    `<text x="90" y="370" font-family="${font}" font-size="76" font-weight="700" ` +
    `fill="${FOREGROUND}">Skerries Weather Station</text>` +
    `<text x="90" y="440" font-family="${font}" font-size="36" fill="${MUTED}">` +
    `Live from a Raspberry Pi in Skerries, Co. Dublin</text>` +
    `<text x="90" y="530" font-family="${font}" font-size="30" fill="${ACCENT}">` +
    `Temperature · Wind · Rain · Tides · Forecast</text>` +
    `</svg>`
  );
}

const ogSource = join(tmpdir(), "ws-og.svg");
writeFileSync(ogSource, renderOg());
execFileSync("rsvg-convert", [
  "-w", String(OG.width), "-h", String(OG.height),
  "-o", join(ROOT, "public", "og.png"), ogSource,
]);
console.log(`og.png  ${OG.width}x${OG.height}`);
