import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EChart } from "@/components/EChart";
import { useIsDark } from "@/lib/use-is-dark";
import type { Reading } from "@/lib/supabase";
import { MS_TO_KMH } from "@/lib/format";
import thermometerIcon from "@meteocons/svg/flat/thermometer.svg?url";
import humidityIcon from "@meteocons/svg/flat/humidity.svg?url";
import pressureHighIcon from "@meteocons/svg/flat/pressure-high.svg?url";
import rainIcon from "@meteocons/svg/flat/rain.svg?url";
import windIcon from "@meteocons/svg/flat/wind.svg?url";
import compassIcon from "@meteocons/svg/flat/compass.svg?url";
import airQualityIcon from "@meteocons/svg/flat/smoke-particles.svg?url";

type Range = "24h" | "7d" | "30d";
const RANGES: { value: Range; label: string }[] = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

// Series colours — picked for meaning and to stay legible in both themes.
const C = {
  temp: "#ef4444",
  dewpoint: "#0ea5e9",
  pressure: "#8b5cf6",
  humidity: "#3b82f6",
  wind: "#10b981",
  gust: "#f59e0b",
  rain: "#38bdf8",
  airQuality: "#78716c",
};

function useHistory(range: Range) {
  const [data, setData] = useState<Reading[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetch(`/api/history?range=${range}`)
      .then((r) => r.json())
      .then((rows) => {
        if (!cancelled) setData(rows);
      })
      .catch(() => {
        if (!cancelled) setData([]);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);
  return data;
}

// Every date/time on this page is Irish local time on a 24-hour clock. The
// charts used to fall back to the *viewer's* locale, so the same reading was
// labelled "02:00 PM" for one visitor and "14:00" for another, and neither
// matched the times printed elsewhere on the dashboard.
const TZ = "Europe/Dublin";
const LOCALE = "en-IE";

// Axis tick formatting differs by range: a time-of-day for 24h, weekday + hour
// for 7d, a calendar date for 30d. One formatter for all three left the 24h
// axis cluttered with a repeated "Aug 27".
function axisFormatter(range: Range) {
  const opts: Intl.DateTimeFormatOptions =
    range === "24h"
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : range === "7d"
        ? { weekday: "short", day: "numeric" }
        : { day: "numeric", month: "short" };
  const f = new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone: TZ });
  return (value: string) => f.format(new Date(value));
}

// The tooltip is the only place a reader gets an exact value, so it spells the
// moment out in full — weekday, date and time — rather than repeating the
// abbreviated axis tick.
function tooltipTimeFormatter(range: Range) {
  const f = new Intl.DateTimeFormat(LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TZ,
  });
  const dayOnly = new Intl.DateTimeFormat(LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: TZ,
  });
  return (value: string) => (range === "30d" ? dayOnly : f).format(new Date(value));
}

function baseTextStyle(isDark: boolean) {
  const color = isDark ? "#e5e5e5" : "#171717";
  const muted = isDark ? "#aab2c0" : "#5c5c5c";
  const split = isDark ? "#4a5262" : "#e2e5ea";
  return { color, muted, split };
}

interface AxisCtx {
  isDark: boolean;
  range: Range;
  times: string[];
}

// A category axis labels every Nth sample, which lands ticks on whatever minute
// the sampler happened to fire — "15:04, 15:49, 16:34…". Readers scan a time
// axis for round numbers, so pick out the first sample inside each round
// interval instead and label only those.
const TICK_STEP_HOURS: Record<Range, number> = { "24h": 3, "7d": 24, "30d": 72 };

function roundTickIndices(times: string[], range: Range): Set<number> {
  const step = TICK_STEP_HOURS[range];
  const hourOf = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const seen = new Set<string>();
  const out = new Set<number>();
  times.forEach((t, i) => {
    const d = new Date(t);
    const hours = Math.floor(d.getTime() / 3_600_000);
    if (hours % step !== 0) return;
    const key = hourOf.format(d);
    if (seen.has(key)) return;
    seen.add(key);
    out.add(i);
  });
  // A very short or very sparse series can miss every boundary — fall back to
  // ECharts' own spacing rather than an axis with no labels at all.
  return out.size >= 2 ? out : new Set<number>();
}

function categoryXAxis({ isDark, range, times }: AxisCtx) {
  const { muted, split } = baseTextStyle(isDark);
  const ticks = roundTickIndices(times, range);
  return {
    type: "category" as const,
    data: times,
    boundaryGap: false,
    axisLabel: {
      color: muted,
      hideOverlap: true,
      ...(ticks.size ? { interval: (i: number) => ticks.has(i) } : {}),
      formatter: axisFormatter(range),
    },
    axisLine: { lineStyle: { color: split } },
    axisTick: { show: false },
  };
}

// A shared tooltip for every time series: the moment in full, then one row per
// series with its colour swatch, name and value *with its unit*. The default
// tooltip printed the raw ISO timestamp as a heading and bare numbers below it.
function axisTooltip(range: Range, unit: string, isDark: boolean, digits = 1) {
  const time = tooltipTimeFormatter(range);
  return {
    trigger: "axis" as const,
    axisPointer: {
      type: "line" as const,
      snap: true,
      lineStyle: { color: isDark ? "#8a8a8a" : "#9aa0a6", width: 1, type: "dashed" as const },
    },
    backgroundColor: isDark ? "rgba(30,35,45,0.97)" : "rgba(255,255,255,0.98)",
    borderColor: isDark ? "#3a3a3a" : "#e2e5ea",
    textStyle: { color: isDark ? "#e5e5e5" : "#171717", fontSize: 13 },
    formatter: (params: unknown) => {
      const rows = (Array.isArray(params) ? params : [params]) as {
        axisValue: string;
        marker: string;
        seriesName: string;
        value: number | null;
      }[];
      if (rows.length === 0) return "";
      const head = `<div style="font-weight:600;margin-bottom:4px">${time(rows[0].axisValue)}</div>`;
      const body = rows
        .map((r) => {
          const v =
            typeof r.value === "number" && !Number.isNaN(r.value)
              ? `${r.value.toFixed(digits)}${unit}`
              : "—";
          return (
            `<div style="display:flex;align-items:center;gap:8px;white-space:nowrap">` +
            `${r.marker}<span style="flex:1">${r.seriesName}</span>` +
            `<span style="font-weight:600;font-variant-numeric:tabular-nums">${v}</span></div>`
          );
        })
        .join("");
      return head + body;
    },
  };
}

// Every time-series card is the same chart: a smoothed area under a 2px line,
// the fill a vertical fade from the series colour to near-transparent, same
// grid, axis and legend treatment throughout. `stack` groups turn overlapping
// series into stacked areas (see the wind rose and any future part-of-whole
// series); independent measurements like temp/dewpoint stay unstacked and just
// overlap — the fade keeps that readable rather than muddy.
const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
function rgba(hex: string, alpha: number): string {
  const m = HEX.exec(hex);
  if (!m) return hex;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function fillGradient(color: string) {
  return {
    type: "linear" as const,
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: rgba(color, 0.3) },
      { offset: 1, color: rgba(color, 0.02) },
    ],
  };
}

interface AreaSeries {
  name: string;
  data: (number | null)[];
  color: string;
  stack?: string;
  smooth?: boolean;
}

function areaSeries({ name, data, color, stack, smooth = true }: AreaSeries) {
  return {
    name,
    type: "line" as const,
    data,
    stack,
    smooth,
    showSymbol: false,
    lineStyle: { width: 2 },
    areaStyle: { color: fillGradient(color) },
    emphasis: { focus: "series" as const },
    color,
  };
}

function areaChartOption(
  ctx: AxisCtx,
  unit: string,
  series: AreaSeries[],
  opts: { min?: number; scale?: boolean; digits?: number; yFormatter?: (v: number) => string } = {}
): EChartsOption {
  const { color, muted, split } = baseTextStyle(ctx.isDark);
  // A legend that names a single series just repeats the card title. Drop it and
  // give the plot the space back.
  const showLegend = series.length > 1;
  return {
    textStyle: { color },
    // `containLabel` sizes the plot around whatever the axis labels actually
    // need, so a 4-digit pressure value can't be clipped by a fixed margin.
    grid: { left: 8, right: 16, top: showLegend ? 34 : 16, bottom: 4, containLabel: true },
    tooltip: axisTooltip(ctx.range, unit, ctx.isDark, opts.digits ?? 1),
    legend: showLegend
      ? { top: 0, left: 0, itemGap: 18, icon: "roundRect", itemWidth: 12, itemHeight: 3, textStyle: { color } }
      : { show: false },
    xAxis: categoryXAxis(ctx),
    yAxis: {
      type: "value",
      min: opts.min,
      scale: opts.scale ?? true,
      axisLabel: {
        color: muted,
        // The unit rides on the tick labels themselves, so it's readable at a
        // glance instead of tucked into a floating axis name.
        formatter: opts.yFormatter ?? ((v: number) => `${v}${unit}`),
      },
      splitLine: { lineStyle: { color: split } },
    },
    series: series.map(areaSeries),
  };
}

function tempOption(data: Reading[], ctx: AxisCtx): EChartsOption {
  return areaChartOption(ctx, "°C", [
    { name: "Temperature", data: data.map((d) => d.temp_c), color: C.temp },
    { name: "Dew point", data: data.map((d) => d.dewpoint_c), color: C.dewpoint },
  ]);
}

function pressureOption(data: Reading[], ctx: AxisCtx): EChartsOption {
  return areaChartOption(
    ctx,
    " hPa",
    [{ name: "Pressure", data: data.map((d) => d.pressure_msl_hpa), color: C.pressure }],
    // Pressure sits near 1000, so the default locale formatter renders "1,011.5"
    // — a thousands separator and a decimal on every tick. Round instead.
    { digits: 1, yFormatter: (v: number) => v.toFixed(1) }
  );
}

function humidityOption(data: Reading[], ctx: AxisCtx): EChartsOption {
  return areaChartOption(
    ctx,
    "%",
    [{ name: "Humidity", data: data.map((d) => d.humidity), color: C.humidity }],
    { digits: 0 }
  );
}

function windOption(data: Reading[], ctx: AxisCtx): EChartsOption {
  const toKmh = (v: number | null) => (v === null ? null : +(v * MS_TO_KMH).toFixed(1));
  return areaChartOption(
    ctx,
    " km/h",
    [
      // Gust first so the (always larger) gust band sits behind the sustained-wind fill.
      { name: "Gust", data: data.map((d) => toKmh(d.wind_gust_ms)), color: C.gust },
      { name: "Wind", data: data.map((d) => toKmh(d.wind_speed_ms)), color: C.wind },
    ],
    { min: 0, scale: false, digits: 0 }
  );
}

function airQualityOption(data: Reading[], ctx: AxisCtx): EChartsOption {
  return areaChartOption(ctx, "", [
    { name: "Air quality index", data: data.map((d) => d.air_quality), color: C.airQuality },
  ]);
}

/** Rain totalled per hour (24h) or per day (7d/30d), keyed to real instants. */
function rainBuckets(data: Reading[], range: Range) {
  // Group on the Irish local hour/day so the bars line up with the clock the
  // reader is looking at, but keep a real timestamp per bucket so the axis and
  // tooltip formatters can convert it themselves.
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(range === "24h" ? { hour: "2-digit" as const, hour12: false } : {}),
  });
  const buckets = new Map<string, { at: string; mm: number }>();
  for (const row of data) {
    if (row.rain_mm === null || Number.isNaN(row.rain_mm)) continue;
    const k = key.format(new Date(row.recorded_at));
    const bucket = buckets.get(k);
    if (bucket) bucket.mm += row.rain_mm;
    else buckets.set(k, { at: row.recorded_at, mm: row.rain_mm });
  }
  const entries = [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    times: entries.map(([, v]) => v.at),
    values: entries.map(([, v]) => +v.mm.toFixed(2)),
  };
}

// Rain is a bucket-tip count, not a level: drawn per reading it is a picket
// fence of identical 0.2 mm spikes that says nothing about how wet an hour was.
// Totalled per hour (or per day over a week or a month) and drawn as bars, the
// same data reads as "when did it rain, and how hard".
function rainOption(data: Reading[], ctx: AxisCtx): EChartsOption {
  const { times, values } = rainBuckets(data, ctx.range);
  const { color, muted, split } = baseTextStyle(ctx.isDark);
  const per = ctx.range === "24h" ? "hour" : "day";
  return {
    textStyle: { color },
    grid: { left: 8, right: 16, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      ...axisTooltip(ctx.range, ` mm / ${per}`, ctx.isDark, 1),
      axisPointer: { type: "shadow" as const },
    },
    xAxis: {
      ...categoryXAxis({ ...ctx, times }),
      boundaryGap: true,
      axisLabel: {
        ...categoryXAxis({ ...ctx, times }).axisLabel,
        // One bar = one hour (24h) or one whole day (7d/30d); label it as such
        // rather than inheriting the line charts' formatter for the range.
        formatter: axisFormatter(ctx.range === "24h" ? "24h" : "30d"),
      },
    },
    yAxis: {
      type: "value" as const,
      min: 0,
      axisLabel: { color: muted, formatter: (v: number) => `${v} mm` },
      splitLine: { lineStyle: { color: split } },
    },
    series: [
      {
        name: `Rain per ${per}`,
        type: "bar" as const,
        data: values,
        color: C.rain,
        barMaxWidth: 22,
        itemStyle: { borderRadius: [2, 2, 0, 0] },
      },
    ],
  };
}

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

// Wind rose: petal length = share of observations from that sector, split into
// speed bands (km/h). Averaging speed per sector — the old approach — let a
// single gust from an otherwise-calm direction dominate the chart.
const SPEED_BANDS: { label: string; maxKmh: number; color: string }[] = [
  { label: "< 10", maxKmh: 10, color: "#bae6fd" },
  { label: "10–20", maxKmh: 20, color: "#7dd3fc" },
  { label: "20–30", maxKmh: 30, color: "#38bdf8" },
  { label: "30–40", maxKmh: 40, color: "#0284c7" },
  { label: "40+", maxKmh: Infinity, color: "#075985" },
];

function windRoseOption(data: Reading[], isDark: boolean): EChartsOption {
  const { color, muted, split } = baseTextStyle(isDark);
  const grid = SPEED_BANDS.map(() => new Array(16).fill(0));
  let total = 0;
  for (const row of data) {
    if (row.wind_dir_deg === null || row.wind_speed_ms === null) continue;
    const sector = Math.round(row.wind_dir_deg / 22.5) % 16;
    const kmh = row.wind_speed_ms * MS_TO_KMH;
    const band = SPEED_BANDS.findIndex((b) => kmh < b.maxKmh);
    grid[band === -1 ? SPEED_BANDS.length - 1 : band][sector] += 1;
    total += 1;
  }
  const pct = (n: number) => (total ? +((n / total) * 100).toFixed(1) : 0);

  return {
    textStyle: { color },
    legend: { top: 0, itemGap: 14, textStyle: { color } },
    tooltip: {
      trigger: "item",
      backgroundColor: isDark ? "rgba(30,35,45,0.97)" : "rgba(255,255,255,0.98)",
      borderColor: split,
      textStyle: { color },
      formatter: (params: unknown) => {
        const p = params as { marker: string; name: string; seriesName: string; value: number };
        return (
          `<div style="font-weight:600;margin-bottom:2px">Wind from ${p.name}</div>` +
          `${p.marker}${p.seriesName} — <b>${p.value}%</b> of readings`
        );
      },
    },
    polar: { radius: ["5%", "68%"], center: ["50%", "56%"] },
    angleAxis: {
      type: "category",
      data: COMPASS,
      startAngle: 90,
      // 16 labels around a small circle collide; the eight principal points are
      // enough to orient by.
      axisLabel: {
        color: muted,
        formatter: (v: string) => (v.length <= 2 ? v : ""),
      },
      axisLine: { lineStyle: { color: split } },
    },
    radiusAxis: {
      axisLabel: { color: muted, formatter: "{value}%", showMinLabel: false },
      splitLine: { lineStyle: { color: split } },
    },
    series: SPEED_BANDS.map((b, i) => ({
      type: "bar" as const,
      coordinateSystem: "polar" as const,
      name: `${b.label} km/h`,
      stack: "freq",
      data: grid[i].map(pct),
      color: b.color,
    })),
  };
}

function ChartCard({
  icon,
  title,
  hint,
  option,
  height,
  wide,
}: {
  icon: string;
  title: string;
  /** One line under the title saying what the reader is looking at. */
  hint?: string;
  option: EChartsOption;
  height?: number;
  wide?: boolean;
}) {
  return (
    <Card className={wide ? "lg:col-span-2" : undefined}>
      <CardHeader className="flex items-center gap-2">
        <img src={icon} alt="" className="h-9 w-9" />
        <div>
          <CardTitle>{title}</CardTitle>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      </CardHeader>
      <CardContent>
        <EChart option={option} height={height} />
      </CardContent>
    </Card>
  );
}

function RangeCharts({ range }: { range: Range }) {
  const data = useHistory(range);
  const isDark = useIsDark();

  if (data === null) {
    return <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (data.length === 0) {
    return <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">No data yet for this range.</div>;
  }

  const ctx: AxisCtx = { isDark, range, times: data.map((d) => d.recorded_at) };
  const hasAirQuality = data.some((d) => d.air_quality != null);
  const sampling = range === "24h" ? "every reading" : "hourly averages";
  const rainPer = range === "24h" ? "hourly totals" : "daily totals";

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
      <ChartCard
        wide
        icon={thermometerIcon}
        title="Temperature & dew point"
        hint={`°C · ${sampling} · the closer the two lines, the damper the air`}
        option={tempOption(data, ctx)}
      />
      <ChartCard
        icon={pressureHighIcon}
        title="Pressure"
        hint="hPa at sea level · falling ahead of unsettled weather"
        option={pressureOption(data, ctx)}
        height={240}
      />
      <ChartCard
        icon={humidityIcon}
        title="Humidity"
        hint="% relative humidity"
        option={humidityOption(data, ctx)}
        height={240}
      />
      <ChartCard
        icon={windIcon}
        title="Wind & gusts"
        hint="km/h · gust is the peak within each reading"
        option={windOption(data, ctx)}
        height={240}
      />
      <ChartCard
        icon={rainIcon}
        title="Rainfall"
        hint={`mm · ${rainPer}`}
        option={rainOption(data, ctx)}
        height={240}
      />
      {hasAirQuality && (
        <ChartCard
          icon={airQualityIcon}
          title="Air quality"
          hint="relative index, uncalibrated · lower is cleaner"
          option={airQualityOption(data, ctx)}
          height={240}
        />
      )}
      <ChartCard
        icon={compassIcon}
        title="Wind rose"
        hint="share of readings blowing from each direction"
        option={windRoseOption(data, isDark)}
        height={320}
      />
    </div>
  );
}

export function HistoryCharts() {
  return (
    <Tabs defaultValue="24h">
      <TabsList>
        {RANGES.map((r) => (
          <TabsTrigger key={r.value} value={r.value}>
            {r.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {RANGES.map((r) => (
        <TabsContent key={r.value} value={r.value} className="mt-4">
          <RangeCharts range={r.value} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
