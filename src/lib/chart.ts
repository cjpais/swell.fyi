// Thin wrapper around uPlot for time series: one y-axis per chart, Taiwan time,
// a "now" marker, synced crosshair across the page, live legend as the readout.
import uPlot from "uplot";
import { TZ, compass } from "./format";

export type Series = {
  label: string;
  /** CSS custom property holding the series color, e.g. "--s1". */
  color: string;
  t: number[]; // unix seconds
  v: (number | null)[];
  style?: "line" | "points" | "line+points";
  dash?: number[];
  width?: number;
};

export type ChartOpts = {
  series: Series[];
  /** Small heading drawn above the plot, for stacked sub-charts. */
  title?: string;
  unit: string;
  digits?: number;
  height?: number;
  direction?: boolean; // y = compass degrees 0-360
  yMin?: number;
  yMax?: number;
  /** Anchor the y-axis at zero (default). Off for temperature, pressure, tide. */
  zero?: boolean;
  xMin?: number;
  xMax?: number;
  showNow?: boolean;
  /** Custom marks drawn on top, e.g. tide high/low labels. */
  annotate?: (u: uPlot, css: (v: string) => string) => void;
};

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || name;

function nowPlugin(): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const now = Date.now() / 1000;
        const [min, max] = [u.scales.x.min!, u.scales.x.max!];
        if (now < min || now > max) return;
        const x = u.valToPos(now, "x", true);
        const { ctx } = u;
        const dpr = devicePixelRatio;
        ctx.save();
        ctx.strokeStyle = css("--ink-3");
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.lineWidth = dpr;
        ctx.beginPath();
        ctx.moveTo(x, u.bbox.top);
        ctx.lineTo(x, u.bbox.top + u.bbox.height);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = css("--ink-2");
        ctx.font = `${11 * dpr}px ${css("--font")}`;
        ctx.fillText("now", x + 4 * dpr, u.bbox.top + 12 * dpr);
        ctx.restore();
      },
    },
  };
}

export function renderChart(el: HTMLElement, o: ChartOpts): uPlot | null {
  el.replaceChildren();
  el.classList.remove("loading");
  if (o.title) {
    const h = document.createElement("h3");
    h.className = "plot-title";
    h.textContent = o.title;
    el.append(h);
  }
  const series = o.series.filter((s) => s.v.some((v) => v != null));
  if (!series.length) {
    const p = document.createElement("p");
    p.className = "faint";
    p.textContent = "No data for this window.";
    el.append(p);
    return null;
  }

  const data = uPlot.join(
    series.map((s) => [s.t, s.v] as uPlot.AlignedData),
    series.map(() => [1]), // keep real nulls as gaps; alignment fill (undefined) is spanned
  );
  const digits = o.digits ?? 1;
  const fmtVal = (v: number | null) =>
    v == null ? "–" : o.direction ? `${Math.round(v)}° ${compass(v)}` : `${v.toFixed(digits)} ${o.unit}`;

  const ink2 = css("--ink-2");
  const grid = css("--grid");
  const axisFont = `12px ${css("--font")}`;

  const opts: uPlot.Options = {
    width: el.clientWidth || 800,
    height: o.height ?? 240,
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), TZ),
    cursor: { sync: { key: "page" }, points: { size: 7 }, drag: { x: true, y: false } },
    legend: { live: true },
    scales: {
      x: { time: true, range: o.xMin != null ? [o.xMin, o.xMax!] : undefined },
      y: {
        range: o.direction
          ? [0, 360]
          : o.zero === false
            ? (_u, min, max) => {
                const pad = Math.max((max - min) * 0.1, 0.5);
                return [o.yMin ?? min - pad, o.yMax ?? max + pad];
              }
            : (_u, min, max) => [o.yMin ?? Math.min(0, min), o.yMax ?? (max <= 0 ? 1 : max * 1.12)],
      },
    },
    axes: [
      { stroke: ink2, font: axisFont, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
      {
        stroke: ink2,
        font: axisFont,
        size: 56,
        grid: { stroke: grid, width: 1 },
        ticks: { show: false },
        splits: o.direction ? () => [0, 90, 180, 270, 360] : undefined,
        values: o.direction
          ? (_u, vals) => vals.map((v) => compass(v))
          : (_u, vals) => vals.map((v) => `${+v.toFixed(2)} ${o.unit}`),
      },
    ],
    series: [
      { value: (_u, ts) => (ts == null ? "–" : new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ts * 1000)) },
      ...series.map((s): uPlot.Series => {
        const color = css(s.color);
        const style = s.style ?? (o.direction ? "points" : "line");
        return {
          label: s.label,
          stroke: color,
          width: s.width ?? 2,
          dash: s.dash,
          spanGaps: false,
          paths: style === "points" ? () => null : undefined,
          points: style === "line" ? { show: false } : { show: true, size: o.direction ? 5 : 6, fill: color, stroke: color },
          value: (_u, v) => fmtVal(v),
        };
      }),
    ],
    plugins: [...(o.showNow !== false ? [nowPlugin()] : []), ...(o.annotate ? [{ hooks: { draw: (u: uPlot) => o.annotate!(u, css) } }] : [])],
  };

  const u = new uPlot(opts, data, el);
  const ro = new ResizeObserver(() => {
    if (!u.root.isConnected) return ro.disconnect();
    u.setSize({ width: el.clientWidth, height: opts.height });
  });
  ro.observe(el);
  return u;
}

/** Convert an ISO time string to unix seconds. */
export const sec = (iso: string | number) => Math.round((typeof iso === "number" ? iso : Date.parse(iso)) / 1000);
