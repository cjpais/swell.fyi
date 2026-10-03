// The explore map's one timeline: three rows on one time axis.
//   Waves  a bar per hour, height = wave height (total sea)
//   Wind   a bar per hour, height = speed, ticks = direction
//   Tide   the curve between CWA's highs and lows
// The left gutter reads out each row's numbers at the cursor. The strip is also the clock:
// hover to preview an hour, click (or arrow keys) to set it. Plain SVG, redrawn only when
// its data, the hour or its width changes.
import { HOUR as H, dayName, dayNum, hhmm, hour, localMidnight } from "./surf";
import { fmt } from "./format";

type S = (number | null)[];
export type StripData = {
  waves: { t: number[]; v: S } | null;
  wind: { t: number[]; speed: S; dir: S } | null;
  tide: { t: number[]; v: number[] } | null;
};
/** Gutter text at a time: a title line, then [main, sub] per row. */
export type Readout = { title: string; waves: [string, string]; wind: [string, string]; tide: [string, string] };
type Opts = { t0: number; t1: number; now: number; empty: string; readout: (ts: number) => Readout | null; onPreview: (ts: number | null) => void; onPick: (ts: number) => void };

const f = (n: number) => n.toFixed(1);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const GUT = 228; // readouts
const DAY = 18, GAP = 10;
const ROWS = { waves: 50, wind: 36, tide: 30 };

/** Small arrow centred at (cx, cy), pointing the way the air moves. */
function tick(cx: number, cy: number, from: number, s: number) {
  const b = ((from + 180) * Math.PI) / 180;
  const pts = [[0, -s], [s * 0.62, s * 0.7], [0, s * 0.32], [-s * 0.62, s * 0.7]].map(([x, y]) => [cx + x * Math.cos(b) - y * Math.sin(b), cy + x * Math.sin(b) + y * Math.cos(b)]);
  return `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;
}
const inWin = (t: number[], v: S, t0: number, t1: number) => v.filter((x, i): x is number => x != null && t[i] >= t0 && t[i] <= t1);

export function forecastStrip(el: HTMLElement, o: Opts) {
  let data: StripData | null = null, pinned = Math.round(o.now / H) * H, hover: number | null = null, W = 0;
  const x = (ts: number) => GUT + ((ts - o.t0) / (o.t1 - o.t0)) * (W - GUT - 4);
  const tAt = (px: number) => Math.min(o.t1, Math.max(o.t0, Math.round((o.t0 + ((px - GUT) / (W - GUT - 4)) * (o.t1 - o.t0)) / H) * H));

  function draw() {
    W = el.clientWidth;
    if (!W) return;
    const out: string[] = [];
    const yW = DAY + 4, yWi = yW + ROWS.waves + GAP + 8, yT = yWi + ROWS.wind + GAP, bottom = yT + ROWS.tide;
    const total = bottom + 20, bw = Math.max(1, x(o.t0 + H) - x(o.t0) - 0.6), right = W - 4;
    const cur = hover ?? pinned;

    for (let d = localMidnight(o.t0) + 24 * H; d < o.t1; d += 24 * H)
      out.push(`<line class="fs-day" x1="${f(x(d))}" x2="${f(x(d))}" y1="0" y2="${bottom}"/><text class="fs-dayname" x="${f(x(d) + 4)}" y="12"><tspan class="dn">${dayName(d)}</tspan> ${dayNum(d)}</text>`);
    const scale = (y: number, text: string) => out.push(`<text class="fs-scale" x="${right}" y="${f(y - 2)}" text-anchor="end">${text}</text>`);

    // Readouts in the gutter, one per row, for the cursor's hour.
    const r = data ? o.readout(cur) : null;
    const read = (y: number, h: number, [main, sub]: [string, string]) =>
      out.push(`<text class="fs-main" x="0" y="${f(y + h / 2 - 3)}">${esc(main)}</text><text class="fs-sub" x="0" y="${f(y + h / 2 + 11)}">${esc(sub)}</text>`);
    if (r) {
      out.push(`<text class="fs-title" x="0" y="12">${esc(r.title)}</text>`);
      read(yW, ROWS.waves, r.waves); read(yWi, ROWS.wind, r.wind); read(yT, ROWS.tide, r.tide);
    }

    if (!data) {
      out.push(`<text class="fs-empty" x="${f(GUT + (W - GUT) / 2)}" y="${f((yW + bottom) / 2)}" text-anchor="middle">${o.empty}</text>`);
    } else {
      const { waves, wind, tide } = data;
      if (waves) {
        const top = Math.max(1, Math.ceil(Math.max(0, ...inWin(waves.t, waves.v, o.t0, o.t1)) * 1.1 * 2) / 2);
        scale(yW, `${fmt(top)} m`);
        waves.t.forEach((t, i) => {
          const v = waves.v[i];
          if (v == null || t < o.t0 || t >= o.t1) return;
          const h = (v / top) * ROWS.waves;
          out.push(`<rect class="fs-wave${t < o.now - H ? " past" : ""}" x="${f(x(t))}" y="${f(yW + ROWS.waves - h)}" width="${f(bw)}" height="${f(h)}"/>`);
        });
      }
      if (wind) {
        const top = Math.max(5, Math.ceil(Math.max(0, ...inWin(wind.t, wind.speed, o.t0, o.t1)) / 5) * 5);
        scale(yWi - 8, `${top} m/s`);
        wind.t.forEach((t, i) => {
          const v = wind.speed[i], d = wind.dir[i];
          if (v == null || t < o.t0 || t >= o.t1) return;
          const h = Math.max(1.5, (v / top) * ROWS.wind);
          out.push(`<rect class="fs-wind${t < o.now - H ? " past" : ""}" x="${f(x(t))}" y="${f(yWi + ROWS.wind - h)}" width="${f(bw)}" height="${f(h)}"/>`);
          if (d != null && hour(t) % 3 === 0) out.push(`<path class="fs-tick" d="${tick(x(t) + bw / 2, yWi - 7, d, 4.4)}"/>`);
        });
      }
      if (tide) {
        const vs = tide.v.filter((_, i) => tide.t[i] >= o.t0 && tide.t[i] <= o.t1);
        const lo = Math.min(...vs), hi = Math.max(...vs);
        const y = (v: number) => yT + ROWS.tide - 2 - ((v - lo) / (hi - lo || 1)) * (ROWS.tide - 4);
        let d = "";
        tide.t.forEach((t, i) => { if (t >= o.t0 && t <= o.t1) d += `${d ? "L" : "M"}${f(x(t))} ${f(y(tide.v[i]))}`; });
        if (d) out.push(`<path class="fs-tide-area" d="${d}L${f(x(Math.min(o.t1, tide.t[tide.t.length - 1])))} ${yT + ROWS.tide}L${f(x(Math.max(o.t0, tide.t[0])))} ${yT + ROWS.tide}Z"/><path class="fs-tide" d="${d}"/>`);
      }
    }

    out.push(`<line class="fs-now" x1="${f(x(o.now))}" x2="${f(x(o.now))}" y1="${DAY}" y2="${bottom}"/>`);
    const cx = x(cur), text = `${dayName(cur)} ${dayNum(cur)}, ${hhmm(cur)}`, lw = text.length * 6.4 + 12;
    const lx = Math.min(Math.max(cx - lw / 2, GUT), W - lw);
    out.push(`<g class="fs-cursor${hover != null ? " is-hover" : ""}"><line x1="${f(cx)}" x2="${f(cx)}" y1="${DAY}" y2="${bottom + 3}"/><rect x="${f(lx)}" y="${bottom + 3}" width="${f(lw)}" height="15"/><text x="${f(lx + lw / 2)}" y="${bottom + 14}" text-anchor="middle">${text}</text></g>`);
    el.innerHTML = `<svg class="fs" width="${W}" height="${total}" viewBox="0 0 ${W} ${total}" tabindex="0" role="slider" aria-label="Forecast time" aria-valuemin="${o.t0}" aria-valuemax="${o.t1}" aria-valuenow="${pinned}" aria-valuetext="${dayName(pinned)} ${hhmm(pinned)}">${out.join("")}</svg>`;
  }

  const px = (e: PointerEvent) => e.clientX - el.getBoundingClientRect().left;
  el.addEventListener("pointermove", (e) => { const ts = tAt(px(e)); if (ts !== hover) { hover = ts; draw(); o.onPreview(ts); } });
  el.addEventListener("pointerleave", () => { if (hover != null) { hover = null; draw(); o.onPreview(null); } });
  el.addEventListener("click", (e) => { pinned = tAt(px(e)); hover = null; draw(); o.onPick(pinned); });
  el.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    pinned = Math.min(o.t1, Math.max(o.t0, pinned + d * (e.shiftKey ? 24 : 1) * H));
    draw(); o.onPick(pinned);
    (el.querySelector("svg") as SVGElement | null)?.focus();
  });
  new ResizeObserver(() => { if (Math.abs(el.clientWidth - W) > 2) draw(); }).observe(el);

  return {
    setData(d: StripData | null) { data = d; draw(); },
    setPinned(ts: number) { pinned = ts; draw(); },
    /** Redraw the readouts (e.g. once the tide or buoy data arrives). */
    refresh: draw,
  };
}
