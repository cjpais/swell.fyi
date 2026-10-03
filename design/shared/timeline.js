// Stacked, scrubbable timeline. All rows share one time axis and one cursor;
// scrubbing reports the hovered hour so the page can update its readout, compass and map.
// Every color is a CSS class, so each direction styles it from its own tokens.
import { HOUR, dayName, dayNum, hhmm, localMidnight, at } from "./data.js";

const NS = "http://www.w3.org/2000/svg";
// Time window (with a little overhang) for path building; set per draw.
let WIN = [-Infinity, Infinity];
const f = (n) => (Number.isFinite(n) ? n.toFixed(1) : "0");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Values of v whose time falls inside [t0, t1]. */
const inWin = (t, v, t0, t1) => (v ?? []).filter((x, i) => x != null && t[i] >= t0 && t[i] <= t1);

function niceMax(v, step) { return Math.max(step, Math.ceil((v * 1.12) / step) * step); }

function linePath(t, v, x, y) {
  let d = "", pen = false;
  for (let i = 0; i < t.length; i++) {
    if (v[i] == null || t[i] < WIN[0] || t[i] > WIN[1]) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${f(x(t[i]))} ${f(y(v[i]))}`;
    pen = true;
  }
  return d;
}

function areaPath(t, v, x, y, y0) {
  let d = "", run = [];
  const flush = () => { if (run.length > 1) d += `M${f(x(run[0][0]))} ${f(y0)}` + run.map(([a, b]) => `L${f(x(a))} ${f(y(b))}`).join("") + `L${f(x(run[run.length - 1][0]))} ${f(y0)}Z`; run = []; };
  for (let i = 0; i < t.length; i++) { if (v[i] == null || t[i] < WIN[0] || t[i] > WIN[1]) flush(); else run.push([t[i], v[i]]); }
  flush();
  return d;
}

/** Small arrow centred at (cx, cy), pointing where the swell/wind is heading. */
function miniArrow(cx, cy, from, size) {
  const b = ((from + 180) * Math.PI) / 180, s = size;
  const pts = [[0, -s], [s * 0.62, s * 0.7], [0, s * 0.32], [-s * 0.62, s * 0.7]].map(([x, y]) => [cx + x * Math.cos(b) - y * Math.sin(b), cy + x * Math.sin(b) + y * Math.cos(b)]);
  return `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;
}

/**
 * @param {HTMLElement} el
 * @param {{t0:number,t1:number,now:number,sun?:[number,number][],rows:any[],onScrub?:(ts:number|null)=>void,minWidth?:number}} cfg
 */
export function renderTimeline(el, cfg) {
  const L = 58, Rm = 14, TOP = 30, GAP = 12, LABEL = 18;
  let cursorTs = null, svg, xOf, tOf, W, tipEl = null;

  function draw() {
    W = Math.max(cfg.minWidth ?? 760, el.clientWidth);
    const total = TOP + cfg.rows.reduce((a, r) => a + LABEL + r.h + GAP, 0);
    WIN = [cfg.t0 - 2 * HOUR, cfg.t1 + 2 * HOUR];
    xOf = (ts) => L + ((ts - cfg.t0) / (cfg.t1 - cfg.t0)) * (W - L - Rm);
    tOf = (x) => cfg.t0 + ((x - L) / (W - L - Rm)) * (cfg.t1 - cfg.t0);
    const out = [];

    // Night shading and day boundaries, behind everything.
    for (const [rise, set] of cfg.sun ?? []) {
      // night before this sunrise: from previous sunset (approx. rise - 11h) to rise
      out.push(`<rect class="tl-night" x="${f(xOf(Math.max(cfg.t0, rise - 11.2 * HOUR)))}" y="${TOP}" width="${f(Math.max(0, xOf(Math.min(rise, cfg.t1)) - xOf(Math.max(cfg.t0, rise - 11.2 * HOUR))))}" height="${total - TOP}"/>`);
      if (set < cfg.t1) out.push(`<rect class="tl-night" x="${f(xOf(Math.max(set, cfg.t0)))}" y="${TOP}" width="${f(Math.max(0, xOf(Math.min(set + 11.2 * HOUR, cfg.t1)) - xOf(Math.max(set, cfg.t0))))}" height="${total - TOP}"/>`);
    }
    for (let d = localMidnight(cfg.t0); d < cfg.t1; d += 24 * HOUR) {
      const x0 = xOf(Math.max(d, cfg.t0)), x1 = xOf(Math.min(d + 24 * HOUR, cfg.t1));
      if (d >= cfg.t0) out.push(`<line class="tl-day" x1="${f(x0)}" x2="${f(x0)}" y1="4" y2="${total}"/>`);
      if (x1 - x0 > 46) out.push(`<text class="tl-dayname" x="${f(x0 + 8)}" y="19"><tspan class="dn">${dayName(d + 12 * HOUR)}</tspan> <tspan class="dd">${dayNum(d + 12 * HOUR)}</tspan></text>`);
    }

    let y = TOP;
    for (const row of cfg.rows) {
      out.push(`<g class="tl-row tl-row-${row.kind}" transform="translate(0 ${y})">`);
      out.push(`<text class="tl-label" x="${L}" y="12">${esc(row.label)}</text>`);
      out.push(`<g transform="translate(0 ${LABEL})">`, ...drawRow(row, row.h), `</g>`);
      out.push(`</g>`);
      y += LABEL + row.h + GAP;
    }

    if (cfg.now >= cfg.t0 && cfg.now <= cfg.t1) {
      const x = xOf(cfg.now);
      out.push(`<line class="tl-now" x1="${f(x)}" x2="${f(x)}" y1="${TOP - 4}" y2="${total}"/><text class="tl-nowlabel" x="${f(x + 4)}" y="${TOP + 2}">now</text>`);
    }
    out.push(`<g class="tl-cursor" visibility="hidden"><line y1="${TOP - 6}" y2="${total}"/><rect class="tl-cursor-tag" y="${TOP - 26}" height="18" rx="9"/><text class="tl-cursor-text" y="${TOP - 13}" text-anchor="middle"></text></g>`);
    out.push(`<rect class="tl-hit" x="${L}" y="0" width="${W - L - Rm}" height="${total}" fill="transparent"/>`);

    el.innerHTML = `<svg xmlns="${NS}" class="tl" width="${W}" height="${total}" viewBox="0 0 ${W} ${total}" tabindex="0" role="img" aria-label="Forecast timeline. Use left and right arrow keys to step through the hours.">${out.join("")}</svg>`;
    svg = el.querySelector("svg");
    if (cfg.tip) { tipEl = document.createElement("div"); tipEl.className = "tl-tip"; tipEl.hidden = true; el.append(tipEl); }
    bind();
    if (cursorTs != null) placeCursor(cursorTs);
  }

  function yAxis(h, max, step, unit) {
    const out = [];
    for (let v = 0; v <= max + 1e-9; v += step) {
      const yy = h - (v / max) * (h - 6);
      out.push(`<line class="tl-grid" x1="${L}" x2="${W - Rm}" y1="${f(yy)}" y2="${f(yy)}"/>`);
      if (v > 0) out.push(`<text class="tl-tick" x="${L - 6}" y="${f(yy)}" dy="0.32em" text-anchor="end">${+v.toFixed(1)}${v + step > max + 1e-9 ? ` ${unit}` : ""}</text>`);
    }
    return out;
  }

  function drawRow(row, h) {
    const out = [];
    if (row.kind === "height") {
      const all = [...(row.total ? inWin(row.total.t, row.total.v, cfg.t0, cfg.t1) : []), ...(row.obs ? inWin(row.obs.t, row.obs.v, cfg.t0, cfg.t1) : []), ...row.parts.flatMap((p) => inWin(p.t, p.v, cfg.t0, cfg.t1))];
      const step = Math.max(...all, 0.5) > 3 ? 1 : 0.5;
      const max = niceMax(Math.max(...all, 0.5), step);
      const yy = (v) => h - (v / max) * (h - 6);
      out.push(...yAxis(h, max, step, "m"));
      if (row.total) out.push(`<path class="tl-total" d="${areaPath(row.total.t, row.total.v, xOf, yy, h)}"/><path class="tl-total-line" d="${linePath(row.total.t, row.total.v, xOf, yy)}"/>`);
      for (const p of [...row.parts].reverse()) out.push(`<path class="tl-line ${p.cls}" d="${linePath(p.t, p.v, xOf, yy)}"/>`);
      if (row.obs) {
        for (let i = 0; i < row.obs.t.length; i++) {
          const v = row.obs.v[i];
          if (v == null || row.obs.t[i] < cfg.t0 || row.obs.t[i] > cfg.t1) continue;
          out.push(`<circle class="tl-obs" cx="${f(xOf(row.obs.t[i]))}" cy="${f(yy(v))}" r="2.2"/>`);
        }
      }
    } else if (row.kind === "arrows") {
      const n = row.series.length, sub = h / n;
      row.series.forEach((s, k) => {
        const cy = sub * k + sub / 2;
        out.push(`<text class="tl-sublabel" x="${L - 6}" y="${f(cy)}" dy="0.32em" text-anchor="end">${esc(s.short)}</text>`);
        for (let ts = Math.ceil(cfg.t0 / (3 * HOUR)) * 3 * HOUR; ts <= cfg.t1; ts += (row.step ?? 3) * HOUR) {
          const d = at(s.t, s.dir, ts, HOUR), hh = at(s.t, s.h, ts, HOUR);
          if (d == null || hh == null || hh < 0.05) continue;
          const size = Math.min(sub * 0.46, 3.5 + hh * 3.2);
          out.push(`<path class="tl-arrow ${s.cls}" d="${miniArrow(xOf(ts), cy, d, size)}"/>`);
        }
      });
    } else if (row.kind === "wind") {
      const all = [...inWin(row.t, row.speed, cfg.t0, cfg.t1), ...inWin(row.t, row.gust, cfg.t0, cfg.t1)];
      const max = niceMax(Math.max(...all, 6), 4);
      const top = 20;
      const yy = (v) => h - (v / max) * (h - top - 4);
      for (let v = 4; v <= max; v += 4) {
        out.push(`<line class="tl-grid" x1="${L}" x2="${W - Rm}" y1="${f(yy(v))}" y2="${f(yy(v))}"/>`);
        out.push(`<text class="tl-tick" x="${L - 6}" y="${f(yy(v))}" dy="0.32em" text-anchor="end">${v}${v + 4 > max ? " m/s" : ""}</text>`);
      }
      const step = row.step ?? HOUR, bw = Math.max(1, xOf(cfg.t0 + step) - xOf(cfg.t0) - (step >= 3 * HOUR ? 2 : 0.6));
      for (let i = 0; i < row.t.length; i++) {
        const ts = row.t[i], v = row.speed[i];
        if (v == null || ts < cfg.t0 || ts > cfg.t1) continue;
        const tone = row.tone(i);
        // Gust as a pale bar behind the sustained wind, same tone, so the two read as one mark.
        const g = row.gust?.[i];
        if (g != null && g > v) out.push(`<rect class="tl-gustbar t-${tone}" x="${f(xOf(ts) - bw / 2)}" y="${f(yy(g))}" width="${f(bw)}" height="${f(yy(v) - yy(g))}"/>`);
        out.push(`<rect class="tl-bar t-${tone}" x="${f(xOf(ts) - bw / 2)}" y="${f(yy(v))}" width="${f(bw)}" height="${f(h - yy(v))}"/>`);
      }
      for (let ts = Math.ceil(cfg.t0 / (3 * HOUR)) * 3 * HOUR; ts <= cfg.t1; ts += 3 * HOUR) {
        const d = at(row.t, row.dir, ts, HOUR);
        if (d == null) continue;
        out.push(`<path class="tl-windarrow" d="${miniArrow(xOf(ts), 11, d, 5.5)}"/>`);
      }
    } else if (row.kind === "tide") {
      const vs = inWin(row.t, row.v, cfg.t0, cfg.t1);
      if (!vs.length) return out;
      const lo = Math.min(...vs), hi = Math.max(...vs), pad = (hi - lo) * 0.15 || 0.2;
      const yy = (v) => 6 + (1 - (v - lo + pad) / (hi - lo + 2 * pad)) * (h - 10);
      out.push(`<path class="tl-tide-area" d="${areaPath(row.t, row.v, xOf, yy, h)}"/><path class="tl-tide" d="${linePath(row.t, row.v, xOf, yy)}"/>`);
      for (const e of row.events ?? []) {
        if (e.t < cfg.t0 || e.t > cfg.t1) continue;
        const x = xOf(e.t), yv = yy(e.h);
        out.push(`<text class="tl-tidelabel" x="${f(x)}" y="${f(e.kind === "high" ? yv - 5 : Math.min(h - 1, yv + 12))}" text-anchor="middle">${hhmm(e.t)}</text>`);
      }
    } else if (row.kind === "line") {
      const vs = row.series.flatMap((s) => inWin(s.t, s.v, cfg.t0, cfg.t1));
      if (!vs.length) return out;
      const lo = Math.floor(Math.min(...vs)), hi = Math.ceil(Math.max(...vs));
      const yy = (v) => 4 + (1 - (v - lo) / (hi - lo || 1)) * (h - 8);
      out.push(`<text class="tl-tick" x="${L - 6}" y="${f(yy(hi))}" dy="0.32em" text-anchor="end">${hi}${row.unit}</text><text class="tl-tick" x="${L - 6}" y="${f(yy(lo))}" dy="0.32em" text-anchor="end">${lo}${row.unit}</text>`);
      for (const s of row.series) out.push(`<path class="tl-line ${s.cls}" d="${linePath(s.t, s.v, xOf, yy)}"/>`);
    }
    return out;
  }

  function placeCursor(ts) {
    const g = svg.querySelector(".tl-cursor");
    if (ts == null) { g.setAttribute("visibility", "hidden"); if (tipEl) tipEl.hidden = true; return; }
    const x = xOf(ts);
    if (tipEl) {
      // Card follows the cursor so direction is readable right where you're looking; flips near the right edge.
      cfg.tip(ts, tipEl);
      tipEl.hidden = false;
      const tw = tipEl.offsetWidth;
      // Keep it inside the visible part of a horizontally scrolled timeline (phones).
      const sc = el.parentElement, lo = (sc?.scrollLeft ?? 0) + 4, hi = lo + (sc?.clientWidth ?? W) - 8;
      let left = x + 16 + tw > Math.min(W - Rm, hi) ? x - 16 - tw : x + 16;
      left = Math.min(Math.max(left, lo), hi - tw);
      tipEl.style.transform = `translate(${left.toFixed(0)}px, ${TOP + 4}px)`;
    }
    g.setAttribute("visibility", "visible");
    const line = g.querySelector("line");
    line.setAttribute("x1", f(x)); line.setAttribute("x2", f(x));
    const text = g.querySelector("text");
    text.textContent = `${dayName(ts)} ${hhmm(ts)}`;
    const tw = 86, tx = Math.min(W - Rm - tw / 2, Math.max(L + tw / 2, x));
    text.setAttribute("x", f(tx));
    const tag = g.querySelector("rect");
    tag.setAttribute("x", f(tx - tw / 2)); tag.setAttribute("width", tw);
  }

  function set(ts, emit = true) {
    cursorTs = ts == null ? null : Math.min(cfg.t1, Math.max(cfg.t0, Math.round(ts / HOUR) * HOUR));
    placeCursor(cursorTs);
    if (emit) cfg.onScrub?.(cursorTs);
  }

  function bind() {
    const hit = svg.querySelector(".tl-hit");
    const fromEvent = (e) => { const r = svg.getBoundingClientRect(); return tOf(((e.clientX - r.left) / r.width) * W); };
    // Chrome fires synthetic pointermoves while the page scrolls under a still mouse.
    // Those keep the same screen position, so only react when the pointer itself moved.
    let lastXY = "";
    hit.addEventListener("pointermove", (e) => { const xy = `${e.screenX},${e.screenY}`; if (e.pointerType === "mouse" && xy === lastXY) return; lastXY = xy; set(fromEvent(e)); });
    hit.addEventListener("pointerdown", (e) => set(fromEvent(e)));
    hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") set(null); });
    svg.addEventListener("keydown", (e) => {
      const base = cursorTs ?? cfg.now;
      const step = (e.shiftKey ? 6 : 1) * HOUR;
      if (e.key === "ArrowRight") set(base + step);
      else if (e.key === "ArrowLeft") set(base - step);
      else if (e.key === "Home") set(cfg.t0);
      else if (e.key === "End") set(cfg.t1);
      else if (e.key === "Escape") set(null);
      else return;
      e.preventDefault();
    });
    svg.addEventListener("blur", () => set(null));
  }

  draw();
  let lastW = el.clientWidth;
  const ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - lastW) > 4) { lastW = el.clientWidth; draw(); } });
  ro.observe(el);
  return { set: (ts) => set(ts, false), destroy: () => ro.disconnect() };
}
