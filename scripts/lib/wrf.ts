// CWA's own WRF runs: 10 m wind at every spot, from the regional 15 km (M-A0061) and 3 km
// (M-A0064) open-data GRIB2 files. Plain fetch, no Node APIs, so it runs in Bun
// (scripts/fetch-wrf.ts) and in the swell-data Worker (workers/data).
//
// Sampled at each spot's offshore `model` point, not the beach: the files have no land mask,
// and the 3 km cell nearest a beach is often land, where the wind reads about half what it
// does a few km out.
//
// The open-data product is 6-hourly to 84 h (one file per lead: 000, 006, … 084), 4 runs a
// day, each file overwritten in place as the next run lands (~5 h after its init time). Each
// file is 60 MB (15 km) or 180 MB (3 km) of 78 fields, so we never download one. Range
// requests read the headers of the 10 m U and V messages (usually #66, #67), then just the
// bytes spanning the spots: both are simple-packed on a Lambert conformal grid, so a spot's
// value sits at a computable offset. About 140 small requests per model.
import { SPOTS } from "../../src/data/spots";

const S3 = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com";
export const WRF_MODELS = [
  { id: "wrf15", dataId: "M-A0061", label: "CWA WRF 15 km" },
  { id: "wrf3", dataId: "M-A0064", label: "CWA WRF 3 km" },
] as const;
export type WrfId = (typeof WRF_MODELS)[number]["id"];
export const WRF_LEADS = Array.from({ length: 15 }, (_, i) => i * 6);
/** Where U and V sit in each file. Checked against the message headers on every read. */
const U_INDEX = 66;

export const wrfUrl = (dataId: string, lead: number) => `${S3}/Model/${dataId}-${String(lead).padStart(3, "0")}.grb2`;

export type WrfRun = {
  dataId: string;
  label: string;
  /** Model init time, ISO UTC. */
  init: string;
  /** Valid times, unix seconds. */
  time: number[];
  /** Per spot: the grid cell used, and wind speed (m/s) and direction (from, degrees) per time. */
  spots: Record<string, { lat: number; lon: number; speed: number[]; dir: number[] }>;
};
export type WrfFile = { fetchedAt: string; models: Partial<Record<WrfId, WrfRun>> };

// ---------- GRIB2 ----------

/** A message's headers (sections 0–6): enough to identify the field and locate any value. */
type Header = {
  /** Message length, bytes. */
  len: number;
  /** Reference (init) time, unix seconds. */
  ref: number;
  /** "category/parameter/surface type/level", e.g. 10 m U is "2/2/103/10". */
  field: string;
  /** Forecast lead, hours. */
  lead: number;
  /** Null unless a Lambert grid on a sphere, scanned west→east, south→north, as CWA's are. */
  grid: Lambert | null;
  /** True if U/V are relative to the grid's x/y rather than east/north. */
  gridRelative: boolean;
  /** Simple packing (template 5.0) and no bitmap: value k sits at bit k × bits of the data. */
  simple: boolean;
  R: number;
  E: number;
  D: number;
  bits: number;
  /** Offset of the packed values from the start of the message. */
  data: number;
};
type Lambert = { nx: number; ny: number; la1: number; lo1: number; lov: number; dx: number; dy: number; latin1: number; latin2: number; radius: number };

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
// GRIB2 signed integers are sign-and-magnitude, not two's complement.
const s32 = (b: Uint8Array, o: number) => { const v = u32(b, o); return v & 0x80000000 ? -(v & 0x7fffffff) : v; };
const s16 = (b: Uint8Array, o: number) => { const v = u16(b, o); return v & 0x8000 ? -(v & 0x7fff) : v; };

/** Parse the headers of a GRIB2 message that starts at b[0]. Null if it isn't one. */
function parseHeader(b: Uint8Array): Header | null {
  if (b[0] !== 0x47 || b[1] !== 0x52 || b[2] !== 0x49 || b[3] !== 0x42 || b[7] !== 2) return null;
  // The length is 64-bit; the top half is zero for any real file.
  const h: Header = { len: u32(b, 12), ref: 0, field: "", lead: NaN, grid: null, gridRelative: false, simple: false, R: 0, E: 0, D: 0, bits: 0, data: -1 };
  let bitmap = false;
  for (let p = 16; p + 5 <= b.length; p += u32(b, p)) {
    const sec = b[p + 4];
    if (sec === 1) {
      h.ref = Date.UTC(u16(b, p + 12), b[p + 14] - 1, b[p + 15], b[p + 16], b[p + 17], b[p + 18]) / 1000;
    } else if (sec === 3) {
      h.gridRelative = (b[p + 46] & 0x08) !== 0;
      if (u16(b, p + 12) === 30 && b[p + 14] === 6 && b[p + 64] === 64)
        h.grid = {
          nx: u32(b, p + 30), ny: u32(b, p + 34),
          la1: s32(b, p + 38) / 1e6, lo1: u32(b, p + 42) / 1e6,
          lov: u32(b, p + 51) / 1e6,
          dx: u32(b, p + 55) / 1e3, dy: u32(b, p + 59) / 1e3,
          latin1: s32(b, p + 65) / 1e6, latin2: s32(b, p + 69) / 1e6,
          radius: 6371229,
        };
    } else if (sec === 4) {
      h.field = [b[p + 9], b[p + 10], b[p + 22], u32(b, p + 24) / 10 ** b[p + 23]].join("/");
      h.lead = b[p + 17] === 1 ? u32(b, p + 18) : NaN;
    } else if (sec === 5) {
      h.simple = u16(b, p + 9) === 0;
      h.R = new DataView(b.buffer, b.byteOffset + p + 11, 4).getFloat32(0);
      h.E = s16(b, p + 15);
      h.D = s16(b, p + 17);
      h.bits = b[p + 19];
    } else if (sec === 6) {
      bitmap = b[p + 5] !== 255;
    } else if (sec === 7) {
      h.data = p + 5;
      break;
    }
  }
  if (h.data < 0) throw new Error("GRIB2 headers longer than the read");
  h.simple &&= !bitmap && h.bits > 0;
  return h;
}

/** Value k of a simple-packed field, from `chunk`, which starts `from` bytes into the data. */
function decode(h: Header, chunk: Uint8Array, from: number, k: number) {
  let x = 0, bit = k * h.bits - from * 8;
  for (let n = 0; n < h.bits; n++, bit++) x = x * 2 + ((chunk[bit >> 3] >> (7 - (bit & 7))) & 1);
  return (h.R + x * 2 ** h.E) / 10 ** h.D;
}

// ---------- Lambert conformal (spherical) ----------

const RAD = Math.PI / 180;
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

function lambert(g: Lambert) {
  const p1 = g.latin1 * RAD, p2 = g.latin2 * RAD;
  const t = (phi: number) => Math.tan(Math.PI / 4 + phi / 2);
  const n = p1 === p2 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t(p2) / t(p1));
  const F = (Math.cos(p1) * t(p1) ** n) / n;
  const rho = (lat: number) => (g.radius * F) / t(lat * RAD) ** n;
  const fwd = (lat: number, lon: number) => {
    const th = n * wrapDeg(lon - g.lov) * RAD, r = rho(lat);
    return [r * Math.sin(th), -r * Math.cos(th)];
  };
  const [x0, y0] = fwd(g.la1, g.lo1);
  return {
    n,
    /** Fractional grid indices (i east, j north) of a lat/lon. */
    ij: (lat: number, lon: number) => { const [x, y] = fwd(lat, lon); return [(x - x0) / g.dx, (y - y0) / g.dy]; },
    /** Lat/lon of grid cell (i, j). */
    latlon: (i: number, j: number) => {
      const x = x0 + i * g.dx, y = y0 + j * g.dy;
      const r = Math.sign(n) * Math.hypot(x, y), th = Math.atan2(x, -y);
      return [(2 * Math.atan((g.radius * F / r) ** (1 / n)) - Math.PI / 2) / RAD, wrapDeg(g.lov + th / n / RAD)];
    },
  };
}

/** Nearest grid cell to each point: its flat index, its lat/lon, and the grid→earth rotation. */
export function cellsFor(g: Lambert, points: [number, number][]) {
  const L = lambert(g);
  return points.map(([lat, lon]) => {
    const [fi, fj] = L.ij(lat, lon), i = Math.round(fi), j = Math.round(fj);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return null;
    const [clat, clon] = L.latlon(i, j);
    return { k: j * g.nx + i, i, j, lat: clat, lon: clon, angle: L.n * wrapDeg(clon - g.lov) * RAD };
  });
}

// ---------- fetching ----------

async function range(url: string, from: number, to: number): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
  if (res.status !== 206) throw new Error(`${url}: HTTP ${res.status} for a range request`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Bytes enough for sections 0–6 of a message (~180 for these files). */
const HEAD = 512;
const U10 = "2/2/103/10", V10 = "2/3/103/10";

/**
 * Wind at grid cells `ks` (flat indices, from the file's own grid) in one file. Messages are
 * mostly one length, so U starts at U_INDEX × the first message's length, plus 24 bytes when
 * the accumulated field before it (#61) carries its longer, time-range header. At lead 0 the
 * accumulated fields are all zero and pack smaller, so there walk the headers, one small read
 * each. Then read just the bytes spanning the cells, from U and from V.
 */
async function readUV(url: string, ks: (g: Lambert) => number[]) {
  const head = async (o: number) => parseHeader(await range(url, o, o + HEAD - 1));
  const first = await head(0);
  if (!first) throw new Error(`${url}: not GRIB2`);
  let o = 0, u: Header | null = null;
  for (const guess of [U_INDEX * first.len + 24, U_INDEX * first.len]) {
    u = await head((o = guess));
    if (u?.field === U10) break;
  }
  if (u?.field !== U10)
    for (o = 0, u = first; u.field !== U10; ) {
      o += u.len;
      u = await head(o);
      if (!u) throw new Error(`${url}: no 10 m U wind in the file`);
    }
  const v = await head(o + u.len);
  if (v?.field !== V10) throw new Error(`${url}: 10 m V does not follow 10 m U`);
  for (const h of [u, v]) if (!h.grid || !h.simple) throw new Error(`${url}: unsupported grid or packing`);
  const k = ks(u.grid!);
  const values = async (h: Header, at: number) => {
    const from = Math.floor((Math.min(...k) * h.bits) / 8), to = Math.floor(((Math.max(...k) + 1) * h.bits - 1) / 8);
    const chunk = await range(url, at + h.data + from, at + h.data + to);
    return k.map((x) => decode(h, chunk, from, x));
  };
  const [us, vs] = await Promise.all([values(u, o), values(v, o + u.len)]);
  return { u, v, us, vs };
}

/**
 * One model's latest run at every spot. Throws if the leads don't all come from the same run
 * (CWA overwrites the files one by one as a new run lands); the caller keeps the old one.
 */
export async function buildWrfRun(model: (typeof WRF_MODELS)[number], log: (s: string) => void = () => {}): Promise<WrfRun> {
  const points = SPOTS.map((s) => s.model);
  let cells: ReturnType<typeof cellsFor> | null = null, grid = "";
  const ks = (g: Lambert) => {
    // Every lead is on the same grid; the cells are worked out once.
    if (!cells) { cells = cellsFor(g, points); grid = JSON.stringify(g); }
    else if (JSON.stringify(g) !== grid) throw new Error(`${model.dataId}: grid differs between leads`);
    return cells.flatMap((c) => (c ? [c.k] : []));
  };
  // A few leads at a time; each is ~6 small reads.
  const leads: Awaited<ReturnType<typeof readUV>>[] = [];
  for (let i = 0; i < WRF_LEADS.length; i += 5)
    leads.push(...(await Promise.all(WRF_LEADS.slice(i, i + 5).map((lead) => readUV(wrfUrl(model.dataId, lead), ks)))));

  const init = leads[0].u.ref;
  leads.forEach(({ u, v }, i) => {
    if (u.lead !== WRF_LEADS[i] || v.lead !== WRF_LEADS[i]) throw new Error(`${model.dataId}: file for +${WRF_LEADS[i]} h holds +${u.lead} h`);
    if (u.ref !== init || v.ref !== init) throw new Error(`${model.dataId}: mixed runs (${iso(init)} and ${iso(u.ref)} at +${WRF_LEADS[i]} h); the next run is still landing`);
  });
  const inGrid = cells!.flatMap((c) => (c ? [c] : []));
  const spots: WrfRun["spots"] = {};
  cells!.forEach((c, s) => {
    if (!c) return;
    const n = inGrid.indexOf(c), speed: number[] = [], dir: number[] = [];
    for (const { u, us, vs } of leads) {
      let ue = us[n], ve = vs[n];
      if (u.gridRelative) [ue, ve] = [ue * Math.cos(c.angle) + ve * Math.sin(c.angle), -ue * Math.sin(c.angle) + ve * Math.cos(c.angle)];
      speed.push(+Math.hypot(ue, ve).toFixed(2));
      dir.push(Math.round((Math.atan2(-ue, -ve) / RAD + 360) % 360));
    }
    spots[SPOTS[s].id] = { lat: +c.lat.toFixed(4), lon: +c.lon.toFixed(4), speed, dir };
  });
  log(`  ${model.dataId} run ${iso(init)}, ${leads.length} leads, ${Object.keys(spots).length} spots`);
  return { dataId: model.dataId, label: model.label, init: iso(init), time: WRF_LEADS.map((h) => init + h * 3600), spots };
}

const iso = (s: number) => new Date(s * 1000).toISOString();

/**
 * Rebuild the models in `ids` (default all) from their latest run, keeping `prev`'s run for the
 * rest and for any that fail or are mid-update. `built` lists the ones that succeeded.
 */
export async function buildWrf(prev: WrfFile | null, { ids, log = () => {} }: { ids?: WrfId[]; log?: (s: string) => void } = {}) {
  const models: WrfFile["models"] = { ...prev?.models };
  const built: WrfId[] = [], errors: string[] = [];
  for (const m of WRF_MODELS.filter((m) => !ids || ids.includes(m.id))) {
    try { models[m.id] = await buildWrfRun(m, log); built.push(m.id); }
    catch (e) { errors.push((e as Error).message); }
  }
  const file: WrfFile = { fetchedAt: new Date().toISOString(), models };
  return { file, built, errors };
}

/** Cheap change check: the last lead's ETag for each model. It is the last file a run writes. */
export const wrfEtags = () =>
  Promise.all(WRF_MODELS.map(async (m) => (await fetch(wrfUrl(m.dataId, WRF_LEADS.at(-1)!), { method: "HEAD" })).headers.get("etag") ?? ""));
