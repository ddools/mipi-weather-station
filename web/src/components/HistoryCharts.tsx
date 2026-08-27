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

type Range = "24h" | "7d" | "30d";
const RANGES: { value: Range; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
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

// Axis tick formatting differs by range: a time-of-day for 24h, weekday + hour
// for 7d, a calendar date for 30d. One formatter for all three left the 24h
// axis cluttered with a repeated "Aug 27".
function axisFormatter(range: Range) {
  const opts: Intl.DateTimeFormatOptions =
    range === "24h"
      ? { hour: "2-digit", minute: "2-digit" }
      : range === "7d"
        ? { weekday: "short", hour: "2-digit" }
        : { day: "numeric", month: "short" };
  return (value: string) => new Date(value).toLocaleString(undefined, opts);
}

function baseTextStyle(isDark: boolean) {
  const color = isDark ? "#e5e5e5" : "#171717";
  const muted = isDark ? "#a3a3a3" : "#737373";
  const split = isDark ? "#333" : "#eee";
  return { color, muted, split };
}

interface AxisCtx {
  isDark: boolean;
  range: Range;
  times: string[];
}

function categoryXAxis({ isDark, range, times }: AxisCtx) {
  const { muted } = baseTextStyle(isDark);
  return {
    type: "category" as const,
    data: times,
    axisLabel: { color: muted, hideOverlap: true, formatter: axisFormatter(range) },
    axisLine: { lineStyle: { color: muted } },
  };
}

function lineOption(
  ctx: AxisCtx,
  yName: string,
  series: NonNullable<EChartsOption["series"]>
): EChartsOption {
  const { color, muted, split } = baseTextStyle(ctx.isDark);
  return {
    textStyle: { color },
    grid: { left: 52, right: 20, top: 36, bottom: 28 },
    tooltip: { trigger: "axis" },
    legend: { top: 0, textStyle: { color } },
    xAxis: categoryXAxis(ctx),
    yAxis: {
      type: "value",
      name: yName,
      scale: true,
      axisLabel: { color: muted },
      splitLine: { lineStyle: { color: split } },
    },
    series,
  };
}

function tempOption(data: Reading[], ctx: AxisCtx): EChartsOption {
  return lineOption(ctx, "°C", [
    { name: "Temp", type: "line", data: data.map((d) => d.temp_c), smooth: true, showSymbol: false, color: C.temp },
    { name: "Dewpoint", type: "line", data: data.map((d) => d.dewpoint_c), smooth: true, showSymbol: false, color: C.dewpoint },
  ]);
}

function pressureOption(data: Reading[], ctx: AxisCtx): EChartsOption {
  return lineOption(ctx, "hPa", [
    { name: "Pressure", type: "line", data: data.map((d) => d.pressure_msl_hpa), smooth: true, showSymbol: false, color: C.pressure, areaStyle: { opacity: 0.08 } },
  ]);
}

function humidityOption(data: Reading[], ctx: AxisCtx): EChartsOption {
  return lineOption(ctx, "%", [
    { name: "Humidity", type: "line", data: data.map((d) => d.humidity), smooth: true, showSymbol: false, color: C.humidity, areaStyle: { opacity: 0.08 } },
  ]);
}

function windOption(data: Reading[], ctx: AxisCtx): EChartsOption {
  const toKmh = (v: number | null) => (v === null ? null : +(v * MS_TO_KMH).toFixed(1));
  return lineOption(ctx, "km/h", [
    { name: "Wind", type: "line", data: data.map((d) => toKmh(d.wind_speed_ms)), smooth: true, showSymbol: false, color: C.wind },
    { name: "Gust", type: "line", data: data.map((d) => toKmh(d.wind_gust_ms)), smooth: true, showSymbol: false, color: C.gust },
  ]);
}

function rainOption(data: Reading[], ctx: AxisCtx): EChartsOption {
  const { color, muted, split } = baseTextStyle(ctx.isDark);
  return {
    textStyle: { color },
    grid: { left: 44, right: 16, top: 24, bottom: 28 },
    tooltip: { trigger: "axis" },
    xAxis: categoryXAxis(ctx),
    yAxis: { type: "value", name: "mm", axisLabel: { color: muted }, splitLine: { lineStyle: { color: split } } },
    series: [{ name: "Rain", type: "bar", data: data.map((d) => d.rain_mm), color: C.rain }],
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
  const { color, muted } = baseTextStyle(isDark);
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
    legend: { top: 0, textStyle: { color } },
    tooltip: { trigger: "item", valueFormatter: (v) => `${v}%` },
    polar: { radius: ["5%", "70%"] },
    angleAxis: { type: "category", data: COMPASS, startAngle: 90, axisLabel: { color: muted } },
    radiusAxis: { axisLabel: { color: muted, formatter: "{value}%" } },
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
  option,
  height,
  wide,
}: {
  icon: string;
  title: string;
  option: EChartsOption;
  height?: number;
  wide?: boolean;
}) {
  return (
    <Card className={wide ? "lg:col-span-2" : undefined}>
      <CardHeader className="flex items-center gap-2">
        <img src={icon} alt="" className="h-9 w-9" />
        <CardTitle>{title}</CardTitle>
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

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ChartCard wide icon={thermometerIcon} title="Temperature & dewpoint" option={tempOption(data, ctx)} />
      <ChartCard icon={pressureHighIcon} title="Pressure" option={pressureOption(data, ctx)} height={240} />
      <ChartCard icon={humidityIcon} title="Humidity" option={humidityOption(data, ctx)} height={240} />
      <ChartCard icon={windIcon} title="Wind speed & gust" option={windOption(data, ctx)} height={240} />
      <ChartCard icon={rainIcon} title="Rain" option={rainOption(data, ctx)} height={240} />
      <ChartCard wide icon={compassIcon} title="Wind rose" option={windRoseOption(data, isDark)} height={320} />
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
