import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EChart } from "@/components/EChart";
import type { Reading } from "@/lib/supabase";

type Range = "24h" | "7d" | "30d";
const RANGES: { value: Range; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

function useIsDark() {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setIsDark(root.classList.contains("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

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

function baseTextStyle(isDark: boolean) {
  const color = isDark ? "#e5e5e5" : "#171717";
  const muted = isDark ? "#a3a3a3" : "#737373";
  return { color, muted };
}

function lineChartOption(data: Reading[], isDark: boolean): EChartsOption {
  const { color, muted } = baseTextStyle(isDark);
  const times = data.map((d) => d.recorded_at);
  return {
    textStyle: { color },
    grid: { left: 48, right: 48, top: 32, bottom: 32 },
    tooltip: { trigger: "axis" },
    legend: { top: 0, textStyle: { color } },
    xAxis: {
      type: "category",
      data: times,
      axisLabel: {
        color: muted,
        formatter: (value: string) =>
          new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" }),
      },
      axisLine: { lineStyle: { color: muted } },
    },
    yAxis: [
      { type: "value", name: "°C / %", axisLabel: { color: muted }, splitLine: { lineStyle: { color: isDark ? "#333" : "#eee" } } },
      { type: "value", name: "hPa", axisLabel: { color: muted }, splitLine: { show: false } },
    ],
    series: [
      { name: "Temp (°C)", type: "line", data: data.map((d) => d.temp_c), smooth: true, showSymbol: false },
      { name: "Humidity (%)", type: "line", data: data.map((d) => d.humidity), smooth: true, showSymbol: false },
      {
        name: "Pressure (hPa)",
        type: "line",
        yAxisIndex: 1,
        data: data.map((d) => d.pressure_msl_hpa),
        smooth: true,
        showSymbol: false,
      },
    ],
  };
}

function rainChartOption(data: Reading[], isDark: boolean): EChartsOption {
  const { color, muted } = baseTextStyle(isDark);
  return {
    textStyle: { color },
    grid: { left: 48, right: 16, top: 24, bottom: 32 },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      data: data.map((d) => d.recorded_at),
      axisLabel: {
        color: muted,
        formatter: (value: string) =>
          new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" }),
      },
      axisLine: { lineStyle: { color: muted } },
    },
    yAxis: { type: "value", name: "mm", axisLabel: { color: muted }, splitLine: { lineStyle: { color: isDark ? "#333" : "#eee" } } },
    series: [{ name: "Rain (mm)", type: "bar", data: data.map((d) => d.rain_mm) }],
  };
}

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

function windRoseOption(data: Reading[], isDark: boolean): EChartsOption {
  const { color, muted } = baseTextStyle(isDark);
  const buckets = new Array(16).fill(0);
  const counts = new Array(16).fill(0);
  for (const row of data) {
    if (row.wind_dir_deg === null || row.wind_speed_ms === null) continue;
    const index = Math.round(row.wind_dir_deg / 22.5) % 16;
    buckets[index] += row.wind_speed_ms;
    counts[index] += 1;
  }
  const avgSpeeds = buckets.map((sum, i) => (counts[i] ? sum / counts[i] : 0));

  return {
    textStyle: { color },
    polar: {},
    angleAxis: {
      type: "category",
      data: COMPASS,
      startAngle: 90,
      axisLabel: { color: muted },
    },
    radiusAxis: { axisLabel: { color: muted } },
    tooltip: {},
    series: [
      {
        type: "bar",
        data: avgSpeeds,
        coordinateSystem: "polar",
        name: "Avg wind speed (m/s)",
      },
    ],
  };
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

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Temperature, humidity &amp; pressure</CardTitle>
        </CardHeader>
        <CardContent>
          <EChart option={lineChartOption(data, isDark)} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Rain</CardTitle>
        </CardHeader>
        <CardContent>
          <EChart option={rainChartOption(data, isDark)} height={240} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Wind rose</CardTitle>
        </CardHeader>
        <CardContent>
          <EChart option={windRoseOption(data, isDark)} height={240} />
        </CardContent>
      </Card>
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
