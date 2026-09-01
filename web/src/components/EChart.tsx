import { useEffect, useRef } from "react";
import * as echarts from "echarts";

export function EChart({
  option,
  height = 280,
}: {
  option: echarts.EChartsOption;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  // Keep the latest option around for a deferred init (see below).
  const optionRef = useRef(option);
  optionRef.current = option;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // The chart can be mounted inside a `hidden` tab panel (0×0), which makes
    // `echarts.init` warn and render nothing. Defer init until the container
    // actually has a size, and resize on every subsequent size change.
    const ensure = () => {
      const sized = el.clientWidth > 0 && el.clientHeight > 0;
      if (!chartRef.current && sized) {
        chartRef.current = echarts.init(el);
        chartRef.current.setOption(optionRef.current, true);
      } else if (chartRef.current && sized) {
        chartRef.current.resize();
      }
    };

    const ro = new ResizeObserver(ensure);
    ro.observe(el);
    window.addEventListener("resize", ensure);
    ensure();

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", ensure);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}
