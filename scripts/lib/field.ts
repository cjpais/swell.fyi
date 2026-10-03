// Builds the explore map's data (field.json): a coarse wave + wind field around Taiwan from
// Open-Meteo, plus the same variables at every surf spot. Plain fetch + JSON, so it runs in
// both Bun (scripts/fetch-field.ts, for local dev) and the swell-data Worker (workers/data),
// which rebuilds it on a cron and serves it from R2.
//
// One file per model run instead of one request per visitor: Open-Meteo counts every location
// in a multi-location request as a call, and a build asks for ~170 locations from each of two
// APIs (~350 calls). The free tier allows 10k a day; the Worker rebuilds only when a model
// publishes a new run (ECMWF IFS every 6 h, MFWAM every 12 h), so ~6 builds, ~2k calls a day.
//
// The grid and the spots use the same models as the spot page: MFWAM (swell partitions)
// at the spot's offshore `model` point, ECMWF IFS wind at the beach. So the map, the spot
// card and the spot page all read the same numbers.
import { SPOTS } from "../../src/data/spots";

// Grid: 0.5° over the seas around Taiwan. Points on land come back empty from the marine
// API and are dropped from the wave field (the browser fills to the coast under the land layer).
const LON0 = 118.5, LON1 = 124.0, LAT0 = 20.5, LAT1 = 26.5, D = 0.5;
const NX = Math.round((LON1 - LON0) / D) + 1, NY = Math.round((LAT1 - LAT0) / D) + 1;
const PAST_DAYS = 1, DAYS = 7;
const GRID_STEP = 3; // hours between grid frames

const WAVE_MODEL = "meteofrance_wave", WIND_MODEL = "ecmwf_ifs025";
const MARINE_VARS = ["wave_height", "swell_wave_height", "swell_wave_direction", "swell_wave_period", "secondary_swell_wave_height", "secondary_swell_wave_direction", "secondary_swell_wave_period"];
const WIND_VARS = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"];

type Pt = [number, number]; // [lat, lon]
type Hourly = { time: number[]; [k: string]: (number | null)[] | number[] };
type Loc = { latitude: number; longitude: number; hourly: Hourly; daily?: Record<string, number[]>; gfs?: boolean };

/** Open-Meteo hosts. With an API key (commercial plan) the customer- hosts are used. */
const host = (name: "api" | "marine-api", key?: string) => `https://${key ? "customer-" : ""}${name}.open-meteo.com`;

/** When each model's latest run became available on Open-Meteo (unix seconds). Cheap: static files. */
export async function latestRuns(key?: string): Promise<{ wave: number; wind: number }> {
  const meta = async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return ((await r.json()) as { last_run_availability_time: number }).last_run_availability_time;
  };
  const [wave, wind] = await Promise.all([
    meta(`${host("marine-api", key)}/data/${WAVE_MODEL}/static/meta.json`),
    meta(`${host("api", key)}/data/${WIND_MODEL}/static/meta.json`),
  ]);
  return { wave, wind };
}

export type FieldFile = {
  fetchedAt: string;
  /** Model runs this file was built from (availability time, unix s). */
  runs: { wave: number; wind: number } | null;
  models: { wave: string; wind: string };
  grid: unknown;
  spots: Record<string, unknown>;
};

export async function buildField(opts: { key?: string; runs?: { wave: number; wind: number } | null; log?: (s: string) => void } = {}): Promise<FieldFile> {
  const { key, log = () => {} } = opts;
  const qs = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)]));

  async function many(base: string, pts: Pt[], params: Record<string, string | number>): Promise<Loc[]> {
    // Chunked so a URL never gets unreasonably long.
    const out: Loc[] = [];
    for (let i = 0; i < pts.length; i += 100) {
      const chunk = pts.slice(i, i + 100);
      const url = `${base}?${qs({
        latitude: chunk.map((p) => p[0].toFixed(3)).join(","), longitude: chunk.map((p) => p[1].toFixed(3)).join(","),
        past_days: PAST_DAYS, forecast_days: DAYS, timeformat: "unixtime", timezone: "GMT", ...params, ...(key ? { apikey: key } : {}),
      })}`;
      const res = await fetch(url);
      const j = (await res.json()) as Loc | Loc[] | { error: true; reason: string };
      if (!res.ok || "error" in j) throw new Error(`${base}: ${"reason" in j ? j.reason : `HTTP ${res.status}`}`);
      out.push(...(Array.isArray(j) ? j : [j]));
    }
    return out;
  }
  const marine = (pts: Pt[], model = WAVE_MODEL) => many(`${host("marine-api", key)}/v1/marine`, pts, { hourly: MARINE_VARS.join(","), models: model });
  const wind = (pts: Pt[], daily = false) => many(`${host("api", key)}/v1/forecast`, pts, { hourly: WIND_VARS.join(","), models: WIND_MODEL, wind_speed_unit: "ms", ...(daily ? { daily: "sunrise,sunset" } : {}) });
  const sst = (pts: Pt[]) => many(`${host("marine-api", key)}/v1/marine`, pts, { hourly: "sea_surface_temperature" });

  const round = (v: number | null | undefined, d: number) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  const digits = (k: string) => (k.includes("direction") ? 0 : k.includes("period") ? 1 : 2);
  const hasData = (h: Hourly, k: string) => (h[k] as (number | null)[] | undefined)?.some((v) => v != null) ?? false;

  const grid: Pt[] = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) grid.push([LAT0 + j * D, LON0 + i * D]);

  log(`↓ Open-Meteo field: ${NX}×${NY} grid + ${SPOTS.length} spots`);
  const [gm, gw, sm, sw, ss] = await Promise.all([
    marine(grid),
    wind(grid),
    marine(SPOTS.map((s) => s.model)),
    wind(SPOTS.map((s) => [s.lat, s.lon]), true),
    sst(SPOTS.map((s) => s.model)),
  ]);

  // ---------- grid ----------
  // Frames every GRID_STEP hours. A marine point counts as sea if it has data and the API
  // didn't have to snap it more than ~0.3° to find a sea cell.
  const t = gw[0].hourly.time as number[];
  const frames = t.map((_, k) => k).filter((k) => new Date(t[k] * 1000).getUTCHours() % GRID_STEP === 0);
  const sea = gm.map((m, n) => hasData(m.hourly, "wave_height") && Math.hypot(m.latitude - grid[n][0], m.longitude - grid[n][1]) < 0.3);
  const mIdx = gm.map((m) => new Map((m.hourly.time as number[]).map((ts, k) => [ts, k])));
  const frame = (src: Loc[], k: string, ok: (n: number) => boolean, idx?: Map<number, number>[]) =>
    frames.map((f) => src.map((loc, n) => {
      if (!ok(n)) return null;
      const i = idx ? idx[n].get(t[f]) : f;
      return i == null ? null : round((loc.hourly[k] as (number | null)[])[i], digits(k));
    }));
  const fieldGrid = {
    lon0: LON0, lat0: LAT0, d: D, nx: NX, ny: NY,
    t: frames.map((f) => t[f]),
    hs: frame(gm, "wave_height", (n) => sea[n], mIdx),
    swh: frame(gm, "swell_wave_height", (n) => sea[n], mIdx),
    swd: frame(gm, "swell_wave_direction", (n) => sea[n], mIdx),
    swp: frame(gm, "swell_wave_period", (n) => sea[n], mIdx),
    ws: frame(gw, "wind_speed_10m", () => true),
    wd: frame(gw, "wind_direction_10m", () => true),
  };

  // ---------- spots ----------
  // MFWAM can miss a coastal point; fall back to GFS-Wave there, as the spot page does.
  const missing = SPOTS.map((_, i) => i).filter((i) => !hasData(sm[i].hourly, "wave_height"));
  if (missing.length) {
    log(`  MFWAM empty at ${missing.map((i) => SPOTS[i].id).join(", ")}; trying GFS-Wave`);
    const g = await marine(missing.map((i) => SPOTS[i].model), "ncep_gfswave016");
    missing.forEach((i, k) => { sm[i] = { ...g[k], gfs: true }; });
  }
  const series = (h: Hourly, keys: string[]) => Object.fromEntries(keys.map((k) => [k, ((h[k] ?? []) as (number | null)[]).map((v) => round(v, digits(k)))]));
  const spots = Object.fromEntries(SPOTS.map((s, i) => [s.id, {
    wave: { label: sm[i].gfs ? "GFS-Wave" : "MFWAM", lat: sm[i].latitude, lon: sm[i].longitude, time: sm[i].hourly.time, ...series(sm[i].hourly, MARINE_VARS) },
    wind: { lat: sw[i].latitude, lon: sw[i].longitude, time: sw[i].hourly.time, ...series(sw[i].hourly, WIND_VARS), sun: (sw[i].daily?.sunrise ?? []).map((r, k) => [r, sw[i].daily!.sunset[k]]) },
    sst: { time: ss[i].hourly.time, v: ((ss[i].hourly.sea_surface_temperature ?? []) as (number | null)[]).map((v) => round(v, 1)) },
  }]));

  log(`  ${sea.filter(Boolean).length}/${grid.length} sea points, ${frames.length} frames`);
  return {
    fetchedAt: new Date().toISOString(),
    runs: opts.runs ?? null,
    models: { wave: "MFWAM (Météo-France)", wind: "ECMWF IFS 0.25°" },
    grid: fieldGrid,
    spots,
  };
}
