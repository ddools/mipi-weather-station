import { useEffect, useRef, useState } from "react";
import type { Reading } from "@/lib/supabase";
import { MS_TO_KMH, circularMean, angularDelta, veerBack, degToCompass } from "@/lib/format";
import { sparkPath } from "@/lib/spark";

// Last-5-minutes wind trend for the Wind tile. Polls the short raw window and
// answers "is it picking up / is the wind backing right now?" — the most useful
// near-term read for anyone about to step outside. Distinct from the card's 24h
// sparkline, which is day-shape context.

const WINDOW_MIN = 15; // fetched span (enough to draw a line)
const HEADLINE_MIN = 5; // the "last N minutes" the text talks about
const POLL_MS = 30_000;
const STALE_MS = 15 * 60_000;

const W = 220;
const H = 40;

interface Pt {
  t: number;
  speed: number | null;
  gust: number | null;
  dir: number | null;
}

function avg(ns: number[]): number | null {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
}
const kmh = (ms: number | null) =>
  ms === null || Number.isNaN(ms) ? null : ms * MS_TO_KMH;
const finite = (xs: (number | null)[]) => xs.filter((v): v is number => v !== null);

export function WindTrend() {
  const [rows, setRows] = useState<Reading[] | null>(null);
  const [failed, setFailed] = useState(false);
  const everLoaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/recent?minutes=${WINDOW_MIN}`);
        if (!res.ok) throw new Error(String(res.status));
        const data: Reading[] = await res.json();
        if (!cancelled) {
          everLoaded.current = true;
          setRows(data);
          setFailed(false);
        }
      } catch {
        // Only surface a failure before the first successful load; after that,
        // keep showing the last good data through a transient network blip.
        if (!cancelled && !everLoaded.current) setFailed(true);
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (failed) return null;

  if (rows === null) {
    return (
      <p className="mt-1 basis-full border-t border-border/60 pt-3 text-xs text-muted-foreground">
        Last 5 min · reading…
      </p>
    );
  }

  const pts: Pt[] = rows.map((r) => ({
    t: new Date(r.recorded_at).getTime(),
    speed: kmh(r.wind_speed_ms),
    gust: kmh(r.wind_gust_ms),
    dir: r.wind_dir_deg,
  }));

  const newest = pts.at(-1);
  const stale = !newest || Date.now() - newest.t > STALE_MS;
  const speedPts = pts.filter((p) => p.speed !== null);

  if (stale || speedPts.length < 2) {
    return (
      <p className="mt-1 basis-full border-t border-border/60 pt-3 text-xs text-muted-foreground">
        Last 5 min · not enough recent wind data
      </p>
    );
  }

  // Headline change: mean of the last ~2 min vs mean around the 5-min mark.
  const now = newest!.t;
  const recent = finite(pts.filter((p) => p.t >= now - 2 * 60_000).map((p) => p.speed));
  const backThen = finite(
    pts.filter((p) => p.t <= now - HEADLINE_MIN * 60_000 + 60_000).map((p) => p.speed),
  );
  const nowMean = avg(recent) ?? speedPts.at(-1)!.speed!;
  const thenMean = avg(backThen.length ? backThen : finite([speedPts[0].speed]));
  const delta = thenMean === null ? 0 : nowMean - thenMean;

  const band = 3; // km/h
  const headline =
    Math.abs(delta) <= band ? "steady" : delta > 0 ? "picking up" : "easing";
  const headlineColor =
    Math.abs(delta) <= band
      ? "text-muted-foreground"
      : delta > 0
        ? "text-amber-600 dark:text-amber-400"
        : "text-sky-600 dark:text-sky-400";

  // Direction shift over the headline window: circular mean of each half.
  const winPts = pts.filter((p) => p.t >= now - HEADLINE_MIN * 60_000);
  const half = now - (HEADLINE_MIN / 2) * 60_000;
  const dirFrom = circularMean(finite(winPts.filter((p) => p.t < half).map((p) => p.dir)));
  const dirTo = circularMean(finite(winPts.filter((p) => p.t >= half).map((p) => p.dir)));
  let dirText = "";
  if (dirFrom !== null && dirTo !== null) {
    const move = veerBack(angularDelta(dirFrom, dirTo));
    dirText =
      move === "steady"
        ? `steady from ${degToCompass(dirTo)}`
        : `${move} ${degToCompass(dirFrom)} → ${degToCompass(dirTo)}`;
  } else if (newest!.dir !== null) {
    dirText = `from ${degToCompass(newest!.dir)}`;
  }

  // Gustiness across the window.
  const gustMax = Math.max(...finite(pts.map((p) => p.gust)), 0);
  const speedMin = Math.min(...finite(pts.map((p) => p.speed)));
  const spread = gustMax - speedMin;
  const gustText = spread >= 10 ? ` · gusty (+${Math.round(spread)} km/h)` : "";

  // Shared y-scale so the gust line always sits above the sustained line.
  const hi = Math.max(gustMax, ...finite(pts.map((p) => p.speed)), 1);
  const domain: [number, number] = [0, hi];
  const speedD = sparkPath(
    pts.map((p) => p.speed),
    { width: W, height: H, domain },
  );
  const gustD = sparkPath(
    pts.map((p) => p.gust),
    { width: W, height: H, domain },
  );
  // Marker at the −5-min point.
  const span = now - pts[0].t || 1;
  const markX = ((now - HEADLINE_MIN * 60_000 - pts[0].t) / span) * W;

  return (
    <div className="mt-1 basis-full border-t border-border/60 pt-3">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">Last 5 min</span>
        <span className={`font-medium tabular-nums ${headlineColor}`}>
          {headline}
          {Math.abs(delta) > band && (
            <span className="ml-1.5 text-muted-foreground">
              {Math.round(nowMean - delta)} → {Math.round(nowMean)} km/h
            </span>
          )}
        </span>
      </div>

      <svg
        className="mt-2 block h-10 w-full"
        viewBox={`0 0 ${W} ${H}`}
        fill="none"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {markX > 0 && markX < W && (
          <line
            x1={markX}
            y1="0"
            x2={markX}
            y2={H}
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {gustD && (
          <path
            d={gustD}
            stroke="#f59e0b"
            strokeWidth="1.5"
            strokeOpacity="0.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {speedD && (
          <path
            d={speedD}
            stroke="#10b981"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
        <span className="text-emerald-600 dark:text-emerald-400">wind</span>
        <span className="mx-1">·</span>
        <span className="text-amber-600 dark:text-amber-400">gust</span>
        {dirText && (
          <>
            <span className="mx-1.5">·</span>
            {dirText}
          </>
        )}
        {gustText}
      </p>
    </div>
  );
}
