// Meteocons ship in their own palette (sun #F8AF18, rain #0A5AD4, …) and every
// glyph animates forever. This recolours them onto the site's Nord palette and
// either strips the animation (every icon but the hero's) or slows it down.
//
// Plain JS so both scripts/generate-weather-icons.mjs (Node, no TS loader) and
// the Astro components (the wind-card compass is inlined) can import it.

/** Meteocons flat palette → Nord. The slate greys (#B0BCCD, #94A3B8, …) are
 *  left alone: they are neutral cool greys that already sit well beside Nord. */
const NORD = {
  "#F8AF18": "#EBCB8B", // sun            → aurora yellow
  "#F6A823": "#D08770", // lightning bolt → aurora orange
  "#0A5AD4": "#5E81AC", // raindrops      → frost 4
  "#86C3DB": "#88C0D0", // sky / sleet    → frost 2
  "#72B9D5": "#81A1C1", //                → frost 3
  "#F3F7FE": "#ECEFF4", // cloud fill     → snow storm 3
  "#E2E8F0": "#E5E9F0", //                → snow storm 2
  "#D6DFE9": "#D8DEE9", //                → snow storm 1
  "#EF4444": "#BF616A", // compass needle → aurora red
  "#475569": "#4C566A", //                → polar night 4
  "#334155": "#3B4252", //                → polar night 2
};

/** @param {string} svg */
export function nordify(svg) {
  return svg.replace(/#[0-9a-f]{6}\b/gi, (hex) => NORD[hex.toUpperCase()] ?? hex);
}

/** Drops every SMIL element, leaving each part at its base position. Fine for
 *  the compass (whose needle we rotate ourselves) but not for weather glyphs:
 *  their raindrops rest at opacity 0 and only appear while animating.
 *  Meteocons only use the self-closing form.
 *  @param {string} svg */
export function stripAnimation(svg) {
  return svg.replace(/<animate(?:Transform|Motion)?\b[^>]*\/>/g, "");
}

/** Replaces every animation with the value it would have `atSeconds` into a
 *  looping run — a still frame of the animated icon, drops mid-fall and
 *  staggered as they would be. Linear interpolation between keyframes (spline
 *  easing is ignored; close enough for a still). Handles the numeric
 *  `values` lists Meteocons use (translate, rotate, opacity).
 *  @param {string} svg
 *  @param {number} atSeconds */
export function freezeAnimation(svg, atSeconds) {
  return svg.replace(/<(animate(?:Transform)?)\b([^>]*)\/>/g, (_, tag, attrs) => {
    /** @param {string} name */
    const attr = (name) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    const values = attr("values");
    const dur = parseFloat(attr("dur") ?? "");
    if (!values || !(dur > 0)) return "";

    const frames = values.split(";").map((v) => v.trim().split(/[\s,]+/).map(Number));
    if (frames.length === 1) frames.push(frames[0]);
    const keyTimes =
      attr("keyTimes")?.split(";").map(Number) ??
      frames.map((_, i) => i / (frames.length - 1));

    const begin = parseFloat(attr("begin") ?? "0") || 0;
    const phase = ((((atSeconds - begin) / dur) % 1) + 1) % 1;
    let i = 0;
    while (i < keyTimes.length - 2 && phase > keyTimes[i + 1]) i++;
    const span = keyTimes[i + 1] - keyTimes[i] || 1;
    const u = Math.min(1, Math.max(0, (phase - keyTimes[i]) / span));
    const value = frames[i].map((a, k) => +(a + (frames[i + 1][k] - a) * u).toFixed(2)).join(" ");

    // A two-identical-value animation, frozen: holds `value` over the
    // attribute's base value (which is what the original was animating from).
    const type = attr("type");
    return (
      `<${tag} attributeName="${attr("attributeName")}"${type ? ` type="${type}"` : ""} ` +
      `values="${value};${value}" dur="1s" fill="freeze"/>`
    );
  });
}

/** Stretches every animation `dur` by `factor`.
 *  @param {string} svg
 *  @param {number} factor */
export function slowAnimation(svg, factor) {
  return svg.replace(/\bdur="([\d.]+)s"/g, (_, s) => `dur="${+(Number(s) * factor).toFixed(2)}s"`);
}
