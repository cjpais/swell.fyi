// HTML string builders shared by the pages (build time) and their scripts (browser).
import { fmt, compass } from "./format";
import { windGlyph } from "./glyphs";
import { hour, lerp, localMidnight, dayName, hhmm, type Tide, type Tone } from "./surf";

export const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Wind waves (local chop) are left out on purpose: they're inside the total-sea number,
// and as a separate line they mostly added noise.
export const PARTS = [
  { key: "swell_wave", cls: "p1", label: "Swell", name: "Swell", short: "Swell" },
  { key: "secondary_swell_wave", cls: "p2", label: "2nd swell", name: "2nd swell", short: "2nd" },
] as const;

const toneLabel = { good: "Offshore or light", fair: "Cross-shore", poor: "Onshore" };
export const windKey = (gust = false) =>
  `<ul class="wind-key">${(["good", "fair", "poor"] as const).map((t) => `<li><i class="sw t-${t}"></i>${toneLabel[t]}</li>`).join("")}${gust ? `<li><i class="lg lg-gust"></i>Wind, pale top is gusts</li>` : ""}</ul>`;

export const windIcon = `<svg class="wind-icon" width="22" height="14" viewBox="0 0 22 14" aria-hidden="true"><path class="m-wind-casing" d="${windGlyph([3, 7], [20, 7], 15, 0.7)}"/><path class="m-wind" d="${windGlyph([3, 7], [20, 7], 15, 0.7)}"/></svg>`;
export const swIcon = (cls: string) => `<i class="sw ${cls}"></i>`;
export const glyphKey = `<ul class="glyph-key"><li>${swIcon("p1")}Swell</li><li>${swIcon("p2")}2nd swell</li><li>${windIcon}Wind, barbs = 10 kt</li></ul>`;

type W = { speed: number | null; dir: number | null; tone: Tone; label: string } | null;
export const windChip = (w: W) => (w?.speed == null ? "No wind data" : `<span class="wind-chip t-${w.tone}">${w.label}</span> ${fmt(w.speed)} m/s from ${compass(w.dir)}`);

export function legendHtml(items: [string, string, string?][]) {
  return `<ul class="legend">${items.map(([cls, label, kind = "line"]) => `<li><i class="lg lg-${kind} ${cls}"></i>${label}</li>`).join("")}</ul>`;
}

// The readout is built once and then only its text changes, so scrubbing never changes its
// size (no layout shift) and screen readers aren't flooded on every mouse move.
export function readoutShell({ measuredLabel = "Measured", forecastLabel = "Forecast", primary = "forecast", rows }: { measuredLabel?: string; forecastLabel?: string; primary?: "forecast" | "measured"; rows: [string, string, string][] }) {
  const col = (k: string, label: string) => `<div class="ro-col ro-${k}"><p class="ro-label">${label}</p><div class="ro-big"><span class="ro-hs" data-k="${k}-hs">–</span><span class="ro-unit">m</span></div><p class="ro-src" data-k="${k}-src">&nbsp;</p></div>`;
  const cols = primary === "forecast" ? col("fc", forecastLabel) + col("ms", measuredLabel) : col("ms", measuredLabel) + col("fc", forecastLabel);
  return `
    <p class="ro-when"><span class="ro-kind" data-k="kind">&nbsp;</span> <span data-k="when"></span></p>
    <div class="ro-pair">${cols}</div>
    <p class="ro-note" data-k="note">&nbsp;</p>
    <dl class="ro-list">
      ${rows.map(([k, icon, label]) => `<div class="ro-item" data-row="${k}"><dt>${icon}${label}</dt><dd><span class="ro-main" data-k="${k}">–</span><span class="ro-sub2" data-k="${k}-sub">&nbsp;</span></dd></div>`).join("")}
    </dl>`;
}

export function slots(root: HTMLElement) {
  const map = new Map([...root.querySelectorAll<HTMLElement>("[data-k]")].map((n) => [n.dataset.k!, n]));
  return {
    text: (k: string, v: string | null | undefined) => { const n = map.get(k); if (n) n.textContent = v == null || v === "" ? " " : v; },
    html: (k: string, v: string) => { const n = map.get(k); if (n) n.innerHTML = v || "&nbsp;"; },
  };
}

/** Tide height now plus the next high and low. */
export function tideAt(tide: Tide | null, ts: number): [string, string] {
  if (!tide) return ["–", "No tide forecast nearby"];
  const h0 = lerp(tide.t, tide.v, ts), h1 = lerp(tide.t, tide.v, ts + 1800);
  const hi = tide.events.find((e) => e.t > ts && e.kind === "high"), lo = tide.events.find((e) => e.t > ts && e.kind === "low");
  const when = (e?: { t: number }) => (e ? `${localMidnight(e.t) !== localMidnight(ts) ? `${dayName(e.t)} ` : ""}${hhmm(e.t)}` : "–");
  return [h0 == null ? "–" : `${h0 >= 0 ? "+" : ""}${fmt(h0)} m, ${h1 != null && h1 > h0 ? "rising" : "falling"}`, `Next high ${when(hi)}, low ${when(lo)}`];
}

/** Last-72 h line of a buoy's wave height, on a shared y scale. */
export function sparkline(points: [number, number | null][], yMax: number, w = 132, h = 30) {
  const pts = points.filter((p): p is [number, number] => p[1] != null);
  if (pts.length < 2) return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"></svg>`;
  const t0 = points[0][0], t1 = points[points.length - 1][0];
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * (w - 4) + 2, y = (v: number) => h - 3 - (v / yMax) * (h - 6);
  let d = "", pen = false;
  for (const [t, v] of points) { if (v == null) { pen = false; continue; } d += `${pen ? "L" : "M"}${x(t).toFixed(1)} ${y(v).toFixed(1)}`; pen = true; }
  const [lt, lv] = pts[pts.length - 1];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><line class="spark-base" x1="0" x2="${w}" y1="${h - 3}" y2="${h - 3}"/><path d="${d}"/><circle cx="${x(lt).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="2.5"/></svg>`;
}

/** 3-day strip: one bar per 3 h, height = wave height, colour = wind at the beach. */
export function strip(rows: [number, number | null][], toneAt: (ts: number) => Tone, yMax: number) {
  const w = 168, h = 34, n = rows.length;
  if (!n) return "";
  const bw = w / n;
  const out: string[] = [];
  rows.forEach(([ts, hs], i) => {
    if (hs == null) return;
    const bh = Math.max(2, Math.min(1, hs / yMax) * (h - 6));
    out.push(`<rect class="t-${toneAt(ts)}" x="${(i * bw + 0.6).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 1.2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"/>`);
    if (hour(ts) < 3 && i > 0) out.push(`<line class="strip-day" x1="${(i * bw).toFixed(1)}" x2="${(i * bw).toFixed(1)}" y1="0" y2="${h}"/>`);
  });
  return `<svg class="strip" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${out.join("")}</svg>`;
}
