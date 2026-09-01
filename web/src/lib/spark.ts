// Shared sparkline geometry. Builds a smooth Catmull-Rom → cubic-Bézier `d`
// string from a series of values (nulls are skipped but still hold their x
// slot, so gaps read as gaps). Used by the zero-JS `Sparkline.astro` and by the
// client-side `WindTrend` island so both draw identical curves.

export interface SparkOpts {
  width?: number;
  height?: number;
  /** Padding inside the viewBox, in px. */
  pad?: number;
  /** Curve tension, < 1 keeps the line close to the data (less overshoot). */
  tension?: number;
  /** Explicit `[lo, hi]` y-domain. Omit to fit each series to its own extent;
   *  pass a shared domain to plot several series on the same scale. */
  domain?: [number, number];
}

interface Pt {
  x: number;
  y: number;
}

/**
 * @returns the SVG path `d` string, or `""` when there are fewer than two
 * finite values to draw.
 */
export function sparkPath(values: (number | null)[], opts: SparkOpts = {}): string {
  const { width = 120, height = 32, pad = 3, tension = 0.65, domain } = opts;

  const raw = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v !== null && !Number.isNaN(p.v));

  if (raw.length < 2) return "";

  const xs = values.length - 1 || 1;
  const lo = domain ? domain[0] : Math.min(...raw.map((p) => p.v));
  const hi = domain ? domain[1] : Math.max(...raw.map((p) => p.v));
  const span = hi - lo || 1;
  const clampY = (y: number) => Math.max(pad, Math.min(height - pad, y));

  const pts: Pt[] = raw.map((p) => ({
    x: pad + (p.i / xs) * (width - 2 * pad),
    y: pad + (1 - (p.v - lo) / span) * (height - 2 * pad),
  }));

  const f = (n: number) => n.toFixed(1);
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension;
    const c1y = clampY(p1.y + ((p2.y - p0.y) / 6) * tension);
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension;
    const c2y = clampY(p2.y - ((p3.y - p1.y) / 6) * tension);
    d += ` C${f(c1x)} ${f(c1y)}, ${f(c2x)} ${f(c2y)}, ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}
