// The wave + wind field around Taiwan (public/data/field.json, from scripts/fetch-field.ts),
// drawn on the explore map as a stepped heatmap: flat ink bands in a MapLibre image layer
// under the land, so the coastline masks it for free. Static: it redraws only when the hour does.
import type { Map as MlMap, ImageSource } from "maplibre-gl";

export type FieldGrid = {
  lon0: number; lat0: number; d: number; nx: number; ny: number;
  t: number[];
  hs: (number | null)[][]; swh: (number | null)[][]; swd: (number | null)[][]; swp: (number | null)[][];
  ws: (number | null)[][]; wd: (number | null)[][];
};
type S = (number | null)[];
export type FieldSpot = {
  wave: { label: string; lat: number; lon: number; time: number[]; [k: string]: S | number[] | string | number };
  wind: { lat: number; lon: number; time: number[]; wind_speed_10m: S; wind_direction_10m: S; wind_gusts_10m: S; sun: [number, number][] };
  sst: { time: number[]; v: S };
};
export type Field = { fetchedAt: string; models: { wave: string; wind: string }; grid: FieldGrid; spots: Record<string, FieldSpot> };

export async function loadField(): Promise<Field | null> {
  try {
    const r = await fetch("/data/field.json");
    return r.ok ? ((await r.json()) as Field) : null;
  } catch { return null; }
}

// ---------- layers and their ink bands ----------
// Flat steps, not a rainbow: each band is a riso tint, shallow to strong. Every band carries
// a printed label in the key, so colour is never the only cue.
export type LayerId = "waves" | "period" | "wind";
export type Layer = { id: LayerId; label: string; unit: string; key: "hs" | "swp" | "ws"; steps: number[]; inks: string[]; caption: string };
export const LAYERS: Layer[] = [
  { id: "waves", label: "Waves", unit: "m", key: "hs", steps: [0.5, 1, 1.5, 2, 3], inks: ["--fx-a0", "--fx-a1", "--fx-a2", "--fx-a3", "--fx-a4", "--fx-a5"], caption: "Wave height, total sea (MFWAM)" },
  { id: "period", label: "Period", unit: "s", key: "swp", steps: [6, 8, 10, 12, 14], inks: ["--fx-a0", "--fx-a1", "--fx-a2", "--fx-a3", "--fx-a4", "--fx-a5"], caption: "Swell period, primary swell (MFWAM)" },
  { id: "wind", label: "Wind", unit: "m/s", key: "ws", steps: [3, 6, 9, 12, 15], inks: ["--fx-w0", "--fx-w1", "--fx-w2", "--fx-w3", "--fx-w4", "--fx-w5"], caption: "Wind speed at 10 m (ECMWF IFS)" },
];

const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function rgb(c: string): [number, number, number] {
  const x = document.createElement("canvas").getContext("2d")!;
  x.fillStyle = c;
  const h = x.fillStyle as string; // normalised to #rrggbb
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

// ---------- grid helpers ----------

/** Fill empty (land) cells from their neighbours, so the heatmap runs right up to the coast. */
function filled(g: FieldGrid, v: S): Float32Array {
  const { nx, ny } = g;
  const out = new Float32Array(nx * ny).fill(NaN);
  v.forEach((x, i) => { if (x != null) out[i] = x; });
  for (let pass = 0; pass < 6; pass++) {
    const prev = out.slice();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!Number.isNaN(prev[k])) continue;
      let s = 0, n = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const y = prev[jj * nx + ii];
        if (!Number.isNaN(y)) { s += y; n++; }
      }
      if (n) out[k] = s / n;
    }
  }
  return out;
}

/** Bilinear value at grid-index coords (fi, fj); NaN outside. */
function bilinear(a: Float32Array, nx: number, ny: number, fi: number, fj: number) {
  if (fi < 0 || fj < 0 || fi > nx - 1 || fj > ny - 1) return NaN;
  const i = Math.min(nx - 2, Math.floor(fi)), j = Math.min(ny - 2, Math.floor(fj)), u = fi - i, w = fj - j;
  const k = j * nx + i;
  return a[k] * (1 - u) * (1 - w) + a[k + 1] * u * (1 - w) + a[k + nx] * (1 - u) * w + a[k + nx + 1] * u * w;
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latOf = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;
const rad = (d: number) => (d * Math.PI) / 180;

/** Call after the map's `load` event. */
export function createField(map: MlMap, f: Field) {
  const g = f.grid;
  const lon1 = g.lon0 + g.d * (g.nx - 1), lat1 = g.lat0 + g.d * (g.ny - 1);
  const frameAt = (ts: number) => {
    let best = 0;
    g.t.forEach((t, i) => { if (Math.abs(t - ts) < Math.abs(g.t[best] - ts)) best = i; });
    return best;
  };

  // Filled scalar grids and wind u/v, built per frame on first use.
  const cache = new Map<string, Float32Array>();
  const grid = (key: "hs" | "swp" | "ws", k: number) => {
    const id = `${key}:${k}`;
    let a = cache.get(id);
    if (!a) { a = filled(g, g[key][k]); cache.set(id, a); }
    return a;
  };
  const uv = (k: number) => {
    const id = `uv:${k}`;
    let a = cache.get(id);
    if (!a) {
      const n = g.nx * g.ny, ws = g.ws[k], wd = g.wd[k];
      a = new Float32Array(2 * n).fill(NaN);
      for (let i = 0; i < n; i++) {
        const s = ws[i], d = wd[i];
        if (s == null || d == null) continue;
        // "From" direction → the vector the air moves along (east, north).
        a[i] = -s * Math.sin(rad(d)); a[n + i] = -s * Math.cos(rad(d));
      }
      cache.set(id, a);
    }
    return a;
  };
  /** Field values at a point, at a time (nearest frame). */
  function sample(lon: number, lat: number, ts: number) {
    const k = frameAt(ts), fi = (lon - g.lon0) / g.d, fj = (lat - g.lat0) / g.d;
    const n = g.nx * g.ny, w = uv(k);
    const u = bilinear(w.subarray(0, n), g.nx, g.ny, fi, fj), v = bilinear(w.subarray(n), g.nx, g.ny, fi, fj);
    const near = (a: S) => { const i = Math.round(fi), j = Math.round(fj); return i < 0 || j < 0 || i >= g.nx || j >= g.ny ? null : a[j * g.nx + i]; };
    const num = (x: number) => (Number.isNaN(x) ? null : x);
    return {
      hs: num(bilinear(grid("hs", k), g.nx, g.ny, fi, fj)),
      swh: near(g.swh[k]), swd: near(g.swd[k]), swp: num(bilinear(grid("swp", k), g.nx, g.ny, fi, fj)),
      ws: Number.isNaN(u) ? null : Math.hypot(u, v),
      wd: Number.isNaN(u) ? null : ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360,
    };
  }

  // ---------- heatmap image under the land ----------
  const PX = 100; // pixels per degree of longitude
  const FEATHER = 45; // px of fade at the edge of the grid
  const W = Math.round((lon1 - g.lon0) * PX);
  const y0 = mercY(lat1), y1 = mercY(g.lat0);
  const H = Math.round(((y0 - y1) * 180 / Math.PI) * PX);
  const corners: [[number, number], [number, number], [number, number], [number, number]] = [[g.lon0, lat1], [lon1, lat1], [lon1, g.lat0], [g.lon0, g.lat0]];
  // Row → grid j, once (Mercator rows aren't evenly spaced in latitude).
  const rowJ = new Float32Array(H);
  for (let r = 0; r < H; r++) rowJ[r] = (latOf(y0 - ((r + 0.5) / H) * (y0 - y1)) - g.lat0) / g.d;
  const imgs = new Map<string, HTMLCanvasElement>();
  function image(layer: Layer, k: number) {
    const id = `${layer.id}:${k}`;
    let c = imgs.get(id);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d")!, img = ctx.createImageData(W, H), a = grid(layer.key, k);
    const inks = layer.inks.map((v) => rgb(cssVar(v) || "#888"));
    for (let r = 0; r < H; r++) for (let x = 0; x < W; x++) {
      const v = bilinear(a, g.nx, g.ny, ((x + 0.5) / W) * (g.nx - 1), rowJ[r]);
      if (Number.isNaN(v)) continue;
      let b = 0;
      while (b < layer.steps.length && v >= layer.steps[b]) b++;
      const p = (r * W + x) * 4, [R, G, B] = inks[b];
      // Feather the outer edge into the depth tint around it instead of a hard rectangle.
      const e = Math.min(x, W - 1 - x, r, H - 1 - r) / FEATHER;
      img.data[p] = R; img.data[p + 1] = G; img.data[p + 2] = B; img.data[p + 3] = e >= 1 ? 255 : Math.round(255 * e * e);
    }
    ctx.putImageData(img, 0, 0);
    if (imgs.size > 40) imgs.delete(imgs.keys().next().value!);
    imgs.set(id, c);
    return c;
  }

  let layer: Layer | null = LAYERS[0], frame = frameAt(Date.now() / 1000);
  const SRC = "fx-heat";
  function install() {
    // Under the dashed depth contours and the land: the coast masks the field.
    map.addSource(SRC, { type: "image", coordinates: corners } as any);
    // A 0.5° field says little at harbour scale, so it steps back as you zoom in.
    map.addLayer({ id: SRC, type: "raster", source: SRC, paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.95, 10.5, 0.4], "raster-resampling": "linear", "raster-fade-duration": 0 } }, "bathy-lines");
    draw();
  }
  function draw() {
    const src = map.getSource(SRC) as ImageSource | undefined;
    if (!src) return;
    map.setLayoutProperty(SRC, "visibility", layer ? "visible" : "none");
    if (layer) src.updateImage({ image: image(layer, frame) });
  }
  install(); // the caller waits for the map's load event

  return {
    sample,
    frameTime: (ts: number) => g.t[frameAt(ts)],
    setTime(ts: number) { const k = frameAt(ts); if (k !== frame) { frame = k; draw(); } },
    setLayer(id: LayerId | null) { layer = LAYERS.find((l) => l.id === id) ?? null; draw(); },
    /** Repaint everything from the CSS tokens (after a theme switch). */
    restyle() { imgs.clear(); draw(); },
  };
}
