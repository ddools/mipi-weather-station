import { useEffect, useRef, useState } from "react";
import type * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useIsDark } from "@/lib/use-is-dark";
import radarIcon from "@meteocons/svg/flat/raindrops.svg?url";

// Skerries Harbour / Holmpatrick — same point the header and tides use.
const STATION = { lat: 53.585, lon: -6.106 };

// RainViewer Weather Maps API — free for personal/educational use, no key.
// One JSON call returns the past ~2 h of radar (10-min steps) plus a short
// nowcast; tiles come from the `host` in the response. Attribution
// ("Radar data © RainViewer") is required and shown under the map.
// https://www.rainviewer.com/api/weather-maps-api.html
const MAPS_URL = "https://api.rainviewer.com/public/weather-maps.json";
const COLOR_SCHEME = 2; // Universal Blue
const TILE_SIZE = 256;
const RADAR_MAX_NATIVE_ZOOM = 7; // RainViewer tiles stop here; Leaflet upscales past it
const RADAR_OPACITY = 0.7;
const FRAME_MS = 500; // playback speed
const END_HOLD_MS = 1500; // linger on the last (latest / furthest-out) frame
const REFRESH_MS = 5 * 60_000; // re-poll the frame list

// Esri "Gray Canvas" — keyless raster basemap, free for non-commercial use with
// attribution. A muted grey/labels-only style that sits well under the radar.
// Note the {z}/{y}/{x} tile order (y before x).
const basemapUrl = (dark: boolean) =>
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/" +
  `World_${dark ? "Dark" : "Light"}_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
const BASEMAP_ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Esri, HERE, Garmin, ' +
  "&copy; OpenStreetMap contributors";

interface RawFrame {
  time: number;
  path: string;
}
interface Frame {
  time: number;
  url: string;
  forecast: boolean;
}

function buildFrames(data: {
  host: string;
  radar?: { past?: RawFrame[]; nowcast?: RawFrame[] };
}): Frame[] {
  const tile = (f: RawFrame, forecast: boolean): Frame => ({
    time: f.time,
    forecast,
    url: `${data.host}${f.path}/${TILE_SIZE}/{z}/{x}/{y}/${COLOR_SCHEME}/1_1.png`,
  });
  return [
    ...(data.radar?.past ?? []).map((f) => tile(f, false)),
    ...(data.radar?.nowcast ?? []).map((f) => tile(f, true)),
  ];
}

/** Index of the most recent observed (non-forecast) frame — i.e. "now". */
function nowIndex(frames: Frame[]): number {
  const i = frames.map((f) => f.forecast).lastIndexOf(false);
  return i === -1 ? Math.max(frames.length - 1, 0) : i;
}

function frameLabel(frame: Frame | undefined): string {
  if (!frame) return "";
  const time = new Date(frame.time * 1000).toLocaleTimeString("en-IE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Dublin",
  });
  const deltaMin = Math.round((frame.time * 1000 - Date.now()) / 60_000);
  if (frame.forecast) return `${time} · forecast +${Math.max(deltaMin, 0)} min`;
  if (deltaMin >= -2) return `${time} · now`;
  return `${time} · ${-deltaMin} min ago`;
}

export function RainRadar() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseRef = useRef<L.TileLayer | null>(null);
  const layersRef = useRef<L.TileLayer[]>([]);
  const isDark = useIsDark();

  const [ready, setReady] = useState(false);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [error, setError] = useState(false);

  // Build the map + basemap once, then poll the radar frame list.
  useEffect(() => {
    let cancelled = false;
    let map: L.Map | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let resizeObserver: ResizeObserver | undefined;

    (async () => {
      const leaflet = await import("leaflet");
      if (cancelled || !containerRef.current) return;

      const container = containerRef.current;
      map = leaflet.map(container, {
        center: [STATION.lat, STATION.lon],
        zoom: 8,
        minZoom: 4,
        maxZoom: 11,
        // The map sits mid-page; don't hijack the wheel while scrolling past it.
        scrollWheelZoom: false,
      });
      mapRef.current = map;

      baseRef.current = leaflet
        .tileLayer(basemapUrl(document.documentElement.classList.contains("dark")), {
          maxZoom: 16,
          attribution: BASEMAP_ATTRIBUTION,
        })
        .addTo(map);

      leaflet
        .circleMarker([STATION.lat, STATION.lon], {
          radius: 6,
          color: "#10b981",
          weight: 2,
          fillColor: "#10b981",
          fillOpacity: 0.7,
        })
        .addTo(map)
        .bindTooltip("Skerries Weather Station");

      // The card can still be settling its width when Leaflet measures the
      // container (island hydration + grid layout) — recentre once it's stable.
      const recenter = () => {
        map?.invalidateSize({ animate: false });
        map?.setView([STATION.lat, STATION.lon], 8);
      };
      requestAnimationFrame(recenter);
      resizeObserver = new ResizeObserver(() => map?.invalidateSize({ animate: false }));
      resizeObserver.observe(container);

      setReady(true);

      const load = async () => {
        try {
          const res = await fetch(MAPS_URL);
          if (!res.ok) throw new Error(String(res.status));
          const next = buildFrames(await res.json());
          if (cancelled || next.length === 0) return;
          setFrames(next);
        } catch {
          if (!cancelled) setError(true);
        }
      };
      await load();
      poll = setInterval(load, REFRESH_MS);
    })();

    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
      resizeObserver?.disconnect();
      map?.remove();
      mapRef.current = null;
      baseRef.current = null;
      layersRef.current = [];
    };
  }, []);

  // Swap the basemap style when the site theme changes.
  useEffect(() => {
    if (ready) baseRef.current?.setUrl(basemapUrl(isDark));
  }, [ready, isDark]);

  // Point at "now" whenever a fresh frame list arrives.
  useEffect(() => {
    if (frames.length) setIndex(nowIndex(frames));
  }, [frames]);

  // (Re)build the radar tile layers whenever the frame list changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || frames.length === 0) return;
    let cancelled = false;

    (async () => {
      const leaflet = await import("leaflet");
      if (cancelled || !mapRef.current) return;
      for (const layer of layersRef.current) layer.remove();
      layersRef.current = frames.map((frame, i) =>
        leaflet
          .tileLayer(frame.url, {
            tileSize: TILE_SIZE,
            opacity: 0,
            maxNativeZoom: RADAR_MAX_NATIVE_ZOOM,
            maxZoom: 11,
            zIndex: 10 + i,
          })
          .addTo(map),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, frames]);

  // Show only the active frame.
  useEffect(() => {
    layersRef.current.forEach((layer, i) => layer.setOpacity(i === index ? RADAR_OPACITY : 0));
  }, [index, frames]);

  // Playback loop.
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const atEnd = index === frames.length - 1;
    const id = setTimeout(
      () => setIndex((i) => (i + 1) % frames.length),
      atEnd ? END_HOLD_MS : FRAME_MS,
    );
    return () => clearTimeout(id);
  }, [playing, index, frames]);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <img src={radarIcon} alt="" className="h-9 w-9" />
        <CardTitle>Rain radar</CardTitle>
        <a
          className="ml-auto shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          href="https://www.met.ie/latest-reports/recent-rainfall-radar/12-hour-rainfall-radar"
          target="_blank"
          rel="noopener noreferrer"
        >
          Met Éireann radar ↗
        </a>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-muted-foreground">Radar unavailable right now.</p>
        ) : (
          <>
            <div
              ref={containerRef}
              className="h-[420px] w-full overflow-hidden rounded-lg border border-border bg-muted"
            />
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                disabled={frames.length === 0}
                className="inline-flex h-8 w-16 shrink-0 items-center justify-center rounded-lg border border-border bg-background hover:bg-muted disabled:opacity-50"
              >
                {playing ? "Pause" : "Play"}
              </button>
              <input
                type="range"
                min={0}
                max={Math.max(frames.length - 1, 0)}
                value={index}
                disabled={frames.length === 0}
                onChange={(e) => {
                  setPlaying(false);
                  setIndex(Number(e.target.value));
                }}
                className="h-1 flex-1 cursor-pointer accent-emerald-500"
                aria-label="Radar frame"
              />
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {frames.length ? frameLabel(frames[index]) : "Loading…"}
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Radar data ©{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href="https://www.rainviewer.com/"
                rel="noopener"
              >
                RainViewer
              </a>
              . Past two hours plus a short nowcast, refreshed every ~10 minutes.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
