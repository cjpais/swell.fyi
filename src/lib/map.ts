// MapLibre basemap printed in the page's riso inks (built from the --map-* CSS tokens), plus
// two overlays: spot callouts on the overview map, and a swell/wind overlay centred on one
// spot or buoy that redraws as the timeline scrubs. Maps are flat and north-up, so the
// overlay can draw in screen space.
import * as maplibregl from "maplibre-gl";
// MapLibre 6 looks for its web worker next to its own module, which doesn't survive bundling.
// Let Vite bundle the worker (with its shared chunk) and hand MapLibre the URL.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Map as MlMap, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { compass } from "./format";
import { blockArrow, windGlyph } from "./glyphs";

// Tile server (workers/tiles): vector basemap from our Protomaps/OSM extract.
const TILES = (import.meta.env.PUBLIC_TILES_BASE || "https://tiles.swell.fyi").replace(/\/$/, "");
// W, S, E, N of the basemap extract and bathymetry (scripts/tiles.sh, scripts/bathymetry.py).
const BBOX = [116.0, 19.0, 126.5, 28.5] as const;

let workerSet = false;
const cssVar = (n: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;

export function buildStyle(): StyleSpecification {
  const sea = [0, 1, 2, 3, 4].map((i) => cssVar(`--map-sea-${i}`, "#9ab"));
  const label = cssVar("--map-label", "#333");
  const land = cssVar("--map-land", "#eee");
  const road = cssVar("--map-road", "#fff");
  return {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sources: {
      pm: {
        type: "vector",
        tiles: [`${TILES}/taiwan/{z}/{x}/{y}.mvt`],
        minzoom: 0,
        maxzoom: 15,
        bounds: [...BBOX],
        attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
      },
      bathy: {
        type: "geojson",
        data: "/map/bathymetry.geojson",
        attribution: 'Bathymetry: <a href="https://www.ncei.noaa.gov/products/etopo-global-relief-model">NOAA ETOPO 2022</a>',
      },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": sea[0] } },
      {
        // Depth as flat ink steps, shallow to deep.
        id: "bathy-bands", type: "fill", source: "bathy", filter: ["==", ["get", "kind"], "band"],
        paint: { "fill-antialias": false, "fill-color": ["step", ["get", "max"], sea[0], 100, sea[1], 500, sea[2], 2000, sea[3], 4000, sea[4]] },
      },
      {
        id: "bathy-lines", type: "line", source: "bathy", filter: ["==", ["get", "kind"], "line"],
        paint: { "line-color": cssVar("--map-contour", "#789"), "line-opacity": ["case", ["<=", ["get", "depth"], 200], 0.75, 0.4], "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 11, 1.1], "line-dasharray": ["literal", [3, 2]] },
      },
      { id: "earth", type: "fill", source: "pm", "source-layer": "earth", paint: { "fill-color": land } },
      {
        id: "green", type: "fill", source: "pm", "source-layer": "landcover", filter: ["in", ["get", "kind"], ["literal", ["forest", "wood", "scrub"]]],
        paint: { "fill-color": cssVar("--map-land-2", land), "fill-opacity": 0.55 },
      },
      {
        id: "inland-water", type: "fill", source: "pm", "source-layer": "water",
        filter: ["all", ["==", ["geometry-type"], "Polygon"], ["!", ["in", ["get", "kind"], ["literal", ["ocean", "sea"]]]]],
        paint: { "fill-color": sea[1] },
      },
      { id: "coast", type: "line", source: "pm", "source-layer": "earth", paint: { "line-color": cssVar("--map-coast", label), "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 12, 1.6] } },
      {
        id: "roads-major", type: "line", source: "pm", "source-layer": "roads", filter: ["in", ["get", "kind"], ["literal", ["highway", "major_road"]]], minzoom: 8,
        paint: { "line-color": road, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 14, 3] },
      },
      {
        id: "roads-minor", type: "line", source: "pm", "source-layer": "roads", filter: ["==", ["get", "kind"], "minor_road"], minzoom: 12,
        paint: { "line-color": road, "line-width": 0.8, "line-opacity": 0.7 },
      },
      {
        id: "towns", type: "symbol", source: "pm", "source-layer": "places", filter: ["==", ["get", "kind"], "locality"], minzoom: 8.5,
        layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-max-width": 8 },
        paint: { "text-color": label, "text-halo-color": land, "text-halo-width": 1.4 },
      },
    ],
  } as StyleSpecification;
}

export function createMap(el: HTMLElement, opts: { center: [number, number]; zoom: number; minZoom?: number; cooperative?: boolean }) {
  if (!workerSet) {
    maplibregl.setWorkerUrl(workerUrl);
    workerSet = true;
  }
  const map = new maplibregl.Map({
    container: el,
    style: buildStyle(),
    center: opts.center,
    zoom: opts.zoom,
    minZoom: opts.minZoom ?? 5,
    maxZoom: 15,
    // Loose bounds: the tile extract covers BBOX; a little open sea around it is fine.
    maxBounds: [[BBOX[0] - 6, BBOX[1] - 5], [BBOX[2] + 6, BBOX[3] + 5]],
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: { compact: true },
    cooperativeGestures: opts.cooperative ?? false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  return map;
}

/** Small HTML marker. */
export function marker(map: MlMap, lngLat: [number, number], html: string, className: string, href?: string) {
  const el = document.createElement(href ? "a" : "div");
  if (href) (el as HTMLAnchorElement).href = href;
  el.className = className;
  el.innerHTML = html;
  new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
  return el;
}

/**
 * Spot callouts: each spot gets a pin on the coast and a label pushed out to sea
 * (east for east-facing spots, west for west-facing), stacked so labels never overlap.
 */
type Callout = { id: string; lat: number; lon: number; side: "east" | "west"; href: string; html: string };
export function spotCallouts(map: MlMap, spots: Callout[]) {
  const layer = document.createElement("div");
  layer.className = "callouts";
  map.getContainer().append(layer);
  const lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  lines.setAttribute("class", "callout-lines");
  layer.append(lines);
  const items = spots.map((s) => {
    const a = document.createElement("a");
    a.className = "callout";
    a.href = s.href;
    a.innerHTML = s.html;
    layer.append(a);
    const pin = document.createElement("span");
    pin.className = "callout-pin";
    layer.append(pin);
    return { ...s, a, pin, h: 0, w: 0 };
  });
  function layout() {
    const W = layer.clientWidth, Hh = layer.clientHeight;
    lines.setAttribute("width", String(W)); lines.setAttribute("height", String(Hh));
    const segs: string[] = [];
    for (const side of ["east", "west"] as const) {
      const group = items.filter((i) => i.side === side).map((i) => ({ i, p: map.project([i.lon, i.lat]) })).sort((a, b) => a.p.y - b.p.y);
      let lastBottom = -Infinity;
      for (const { i, p } of group) {
        i.h ||= i.a.offsetHeight; i.w ||= i.a.offsetWidth;
        const dx = side === "east" ? 34 : -34;
        const y = Math.max(p.y - i.h / 2, lastBottom + 4);
        lastBottom = y + i.h;
        // Kept inside the frame on narrow maps; the leader line still ties it to its pin.
        const x = Math.min(Math.max(side === "east" ? p.x + dx : p.x + dx - i.w, 4), W - i.w - 4);
        const visible = p.x > -40 && p.x < W + 40 && p.y > -40 && p.y < Hh + 40;
        i.a.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
        i.a.style.visibility = visible ? "visible" : "hidden";
        i.pin.style.transform = `translate(${p.x.toFixed(0)}px, ${p.y.toFixed(0)}px)`;
        i.pin.style.visibility = visible ? "visible" : "hidden";
        if (visible) segs.push(`M${p.x.toFixed(1)} ${p.y.toFixed(1)} L${(side === "east" ? x : x + i.w).toFixed(1)} ${(y + i.h / 2).toFixed(1)}`);
      }
    }
    lines.innerHTML = `<path d="${segs.join(" ")}"/>`;
  }
  map.on("move", layout);
  map.on("resize", layout);
  map.once("load", layout);
  requestAnimationFrame(layout);
  return { layout };
}

// ---------- conditions overlay ----------
// Swell and wind on the map, in screen space. Swell is always coloured and wide; wind is
// always a thin ink line with an open head and knot barbs. Three swell drawing styles,
// all with the same map key and direct labels.

export type OverlaySwell = { dir: number | null; h: number | null; period: number | null; cls: string; name: string; blocked?: boolean };
export type OverlayWind = { dir: number | null; speed: number | null; label?: string; tone?: string } | null;
export type OverlayState = { faces?: number | null; swells: OverlaySwell[]; wind: OverlayWind };

const MAP_STYLES = [
  { id: "arrows", label: "Arrows" },
  { id: "crests", label: "Crests" },
  { id: "lines", label: "Swell lines" },
];
const STYLE_KEY = "swell.mapStyle";

const rad = (d: number) => (d * Math.PI) / 180;
const u = (b: number): [number, number] => [Math.sin(rad(b)), -Math.cos(rad(b))]; // unit vector toward bearing b
const F = (n: number) => n.toFixed(1);
const fx = (v: number | null | undefined, d = 1) => (v == null ? "–" : v.toFixed(d));

const swellGlyph = (mode: string, cls: string) => {
  if (mode === "crests") return `<svg width="26" height="18" viewBox="0 0 26 18"><g class="m-swell-stroke ${cls}"><path d="M4 15 A12 12 0 0 1 22 15"/><path d="M8 15 A7 7 0 0 1 18 15" opacity=".7"/></g></svg>`;
  if (mode === "lines") return `<svg width="26" height="18" viewBox="0 0 26 18"><g class="m-swell-stroke ${cls}"><path d="M2 4H24"/><path d="M2 9H24" opacity=".75"/><path d="M2 14H24" opacity=".5"/></g></svg>`;
  return `<svg width="26" height="18" viewBox="0 0 26 18"><path class="m-swell ${cls}" d="${blockArrow([2, 9], [24, 9], 6)}"/></svg>`;
};
const windLegendGlyph = () => { const g = windGlyph([4, 9], [24, 9], 15, 0.75); return `<svg width="26" height="18" viewBox="0 0 26 18"><path class="m-wind-casing" d="${g}"/><path class="m-wind" d="${g}"/></svg>`; };

export function conditionOverlay(map: MlMap, lngLat: [number, number]) {
  const box = map.getContainer();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "cond-svg");
  svg.setAttribute("aria-hidden", "true");
  box.append(svg);

  const legend = document.createElement("div");
  legend.className = "map-legend";
  box.append(legend);

  let mode = localStorage.getItem(STYLE_KEY) || "arrows";
  const seg = document.createElement("div");
  seg.className = "map-styles";
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Swell drawing style");
  seg.innerHTML = MAP_STYLES.map((m) => `<button type="button" data-mode="${m.id}" aria-pressed="${m.id === mode}">${m.label}</button>`).join("");
  seg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    mode = b.dataset.mode!;
    localStorage.setItem(STYLE_KEY, mode);
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    draw(); drawLegend();
  });
  box.append(seg);

  let state: OverlayState | null = null;
  // Labels are collected, then nudged apart vertically so they never sit on each other.
  let labels: { x: number; y: number; text: string; anchor: string }[] = [];
  const label = (x: number, y: number, text: string, anchor = "middle") => { labels.push({ x, y, text, anchor }); };
  function placeLabels(cy: number, W: number, H: number) {
    const placed: { x0: number; x1: number; y: number }[] = [], out: string[] = [];
    for (const l of labels) {
      const w = l.text.length * 6.7 + 6;
      let x0 = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2;
      x0 = Math.min(Math.max(x0, 6), W - w - 6);
      const dir = l.y < cy ? -1 : 1;
      let y = l.y;
      for (let n = 0; n < 8 && placed.some((p) => x0 < p.x1 && x0 + w > p.x0 && Math.abs(y - p.y) < 15); n++) y += 15 * dir;
      y = Math.min(Math.max(y, 10), H - 10);
      placed.push({ x0, x1: x0 + w, y });
      out.push(`<text class="m-label" x="${F(x0 + 3)}" y="${F(y)}" dy="0.35em">${l.text}</text>`);
    }
    return out.join("");
  }
  const anchorFor = (b: number) => { const [x] = u(b); return x > 0.35 ? "start" : x < -0.35 ? "end" : "middle"; };

  function draw() {
    if (!state) return;
    const W = box.clientWidth, H = box.clientHeight;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", String(W)); svg.setAttribute("height", String(H));
    const c = map.project(lngLat), cx = c.x, cy = c.y;
    const out: string[] = [];
    labels = [];
    const swells = state.swells.filter((s): s is OverlaySwell & { dir: number; h: number } => s.dir != null && s.h != null && s.h >= 0.1);
    const wind = state.wind?.dir != null ? (state.wind as { dir: number; speed: number | null }) : null;

    // Lateral offset so the wind arrow never sits on top of a swell arrow from a similar direction.
    const near = wind && swells.some((s) => Math.abs(((s.dir - wind.dir + 540) % 360) - 180) < 30);

    swells.forEach((s, i) => {
      const [ux, uy] = u(s.dir), nx = -uy, ny = ux;
      const off = i === 0 ? 0 : 22 * (i % 2 ? 1 : -1);
      const blocked = s.blocked ? " blocked" : "";
      if (mode === "arrows") {
        const r0 = i === 0 ? 165 : 130, w = Math.max(5, Math.min(18, 4 + s.h * 7));
        const a: [number, number] = [cx + ux * r0 + nx * off, cy + uy * r0 + ny * off], b: [number, number] = [cx + ux * 24 + nx * off * 0.4, cy + uy * 24 + ny * off * 0.4];
        out.push(`<path class="m-swell ${s.cls}${blocked}" d="${blockArrow(a, b, w)}"/>`);
        label(a[0] + ux * 10, a[1] + uy * 10, `${s.name} ${fx(s.h)} m`, anchorFor(s.dir));
      } else if (mode === "crests") {
        const gap = Math.max(10, Math.min(26, (s.period ?? 6) * 2.1)), w = Math.max(1.5, Math.min(6, s.h * 3.2));
        const base = i === 0 ? 46 : 40;
        for (let k = 0; k < 4; k++) {
          const r = base + k * gap, span = (i === 0 ? 26 : 18) - k * 2;
          const x0 = cx + Math.sin(rad(s.dir - span)) * r, y0 = cy - Math.cos(rad(s.dir - span)) * r, x1 = cx + Math.sin(rad(s.dir + span)) * r, y1 = cy - Math.cos(rad(s.dir + span)) * r;
          out.push(`<path class="m-swell-stroke ${s.cls}${blocked}" style="stroke-width:${F(w)};opacity:${(1 - k * 0.2).toFixed(2)}" d="M${F(x0)} ${F(y0)}A${r} ${r} 0 0 1 ${F(x1)} ${F(y1)}"/>`);
        }
        const r = base + 4 * gap + 10;
        label(cx + ux * r, cy + uy * r, `${s.name} ${fx(s.h)} m`, anchorFor(s.dir));
      } else {
        // Long crest lines across the water on the up-swell side, spaced by period.
        const gap = Math.max(14, Math.min(40, (s.period ?? 6) * 3.4)), w = Math.max(1.2, Math.min(4.5, s.h * 2.4));
        for (let k = 0; k < 7; k++) {
          const d = 34 + (i * gap) / 2 + k * gap, half = 34 + d * 0.35;
          const mx = cx + ux * d, my = cy + uy * d;
          out.push(`<path class="m-swell-stroke ${s.cls}${blocked}" style="stroke-width:${F(w)};opacity:${Math.max(0.2, 1 - k * 0.12).toFixed(2)}" d="M${F(mx - nx * half)} ${F(my - ny * half)}L${F(mx + nx * half)} ${F(my + ny * half)}"/>`);
        }
        const dl = 34 + 7 * gap + 8;
        label(cx + ux * dl, cy + uy * dl, `${s.name} ${fx(s.h)} m`, anchorFor(s.dir));
      }
    });

    if (wind) {
      const [ux, uy] = u(wind.dir), nx = -uy, ny = ux;
      if (mode === "lines") {
        // Wind as a field of short streaks: it's everywhere, not a single arrow.
        const step = 64;
        for (let y = step / 2; y < H; y += step) for (let x = step / 2 + ((y / step) % 2) * (step / 2); x < W; x += step) {
          const g = windGlyph([x + ux * 12, y + uy * 12], [x - ux * 12, y - uy * 12], 0, 0.6);
          out.push(`<path class="m-wind-casing" d="${g}"/><path class="m-wind streak" d="${g}"/>`);
        }
      }
      const off = near ? 26 : 0;
      const a: [number, number] = [cx + ux * 120 - nx * off, cy + uy * 120 - ny * off], b: [number, number] = [cx + ux * 28 - nx * off * 0.5, cy + uy * 28 - ny * off * 0.5];
      const g = windGlyph(a, b, wind.speed);
      out.push(`<path class="m-wind-casing" d="${g}"/><path class="m-wind" d="${g}"/>`);
      label(a[0] + ux * 12, a[1] + uy * 12, `Wind ${fx(wind.speed, 0)} m/s`, anchorFor(wind.dir));
    }
    if (state.faces != null) {
      const [ux, uy] = u(state.faces);
      out.push(`<line class="m-face" x1="${F(cx)}" y1="${F(cy)}" x2="${F(cx + ux * 18)}" y2="${F(cy + uy * 18)}"/>`);
    }
    out.push(`<circle class="m-spot" cx="${F(cx)}" cy="${F(cy)}" r="6.5"/>`);
    svg.innerHTML = out.join("") + placeLabels(cy, W, H);
  }

  // Map key: same glyphs as the map, with the current numbers.
  function drawLegend() {
    if (!state) return;
    const rows = state.swells.map((s) => `<div class="ml-row"><span class="ml-glyph">${swellGlyph(mode, s.cls)}</span><span class="ml-name">${s.name}</span><span class="ml-val">${s.h != null && s.h >= 0.1 ? `${fx(s.h)} m, ${fx(s.period, 0)} s, ${compass(s.dir)}${s.blocked ? " <em>blocked</em>" : ""}` : "none"}</span></div>`);
    const w = state.wind;
    rows.push(`<div class="ml-row"><span class="ml-glyph">${windLegendGlyph()}</span><span class="ml-name">Wind</span><span class="ml-val">${w?.speed != null ? `${fx(w.speed)} m/s, ${compass(w.dir)}${w.label && w.tone !== "none" ? ` <span class="ml-tone t-${w.tone}">${w.label}</span>` : ""}` : "no data"}</span></div>`);
    legend.innerHTML = `${rows.join("")}<div class="ml-foot">Arrows travel the way the water and air move. Barbs: 10 knots each.</div>`;
  }

  map.on("move", draw);
  map.on("resize", draw);
  return { update(s: OverlayState) { state = s; draw(); drawLegend(); } };
}
