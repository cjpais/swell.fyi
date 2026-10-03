// Surf geometry, Open-Meteo loaders and time helpers for the spot and buoy pages.
// Pure functions only (no DOM), so pages can also use them at build time.
import { compass } from "./format";

export const HOUR = 3600;
const H = HOUR;

export type Series = (number | null)[];
export type Hourly = { time: number[]; [k: string]: any };

const json = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
const qs = (o: Record<string, string | number>) => new URLSearchParams(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])));

// ---------- Open-Meteo ----------

const SEA_VARS = ["wave_height", "wave_direction", "wave_period", "swell_wave_height", "swell_wave_direction", "swell_wave_period", "secondary_swell_wave_height", "secondary_swell_wave_direction", "secondary_swell_wave_period"];

export type Sea = Hourly & { model: string; label: string; lat: number; lon: number; url: string };
/** Hourly sea state at one point: MFWAM (has swell partitions), GFS-Wave as fallback. */
export async function fetchSea(lat: number, lon: number, { past = 1, days = 7 } = {}): Promise<Sea> {
  for (const model of ["meteofrance_wave", "ncep_gfswave016"]) {
    const url = `https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: SEA_VARS.join(","), models: model, past_days: past, forecast_days: days, timeformat: "unixtime", timezone: "GMT" })}`;
    try {
      const j = await json(url);
      if (j.hourly?.wave_height?.some((v: number | null) => v != null))
        return { model, label: model === "meteofrance_wave" ? "MFWAM" : "GFS-Wave", lat: j.latitude, lon: j.longitude, url, ...j.hourly };
    } catch {}
  }
  throw new Error("Open-Meteo returned no wave data");
}

/** Hourly sea-surface temperature (Open-Meteo's default marine model; MFWAM doesn't carry it). */
export async function fetchSST(lat: number, lon: number): Promise<Hourly> {
  const j = await json(`https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: "sea_surface_temperature", past_days: 1, forecast_days: 7, timeformat: "unixtime", timezone: "GMT" })}`);
  return j.hourly;
}

export type Wind = Hourly & { url: string; lat: number; lon: number; sun: [number, number][]; wind_speed_10m: Series; wind_direction_10m: Series; wind_gusts_10m: Series };
/** Hourly 10 m wind (ECMWF IFS) plus sunrise/sunset. */
export async function fetchSpotWind(lat: number, lon: number, { past = 1, days = 7 } = {}): Promise<Wind> {
  const url = `https://api.open-meteo.com/v1/forecast?${qs({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m", daily: "sunrise,sunset", models: "ecmwf_ifs025", past_days: past, forecast_days: days, wind_speed_unit: "ms", timeformat: "unixtime", timezone: "GMT" })}`;
  const j = await json(url);
  return { url, lat: j.latitude, lon: j.longitude, ...j.hourly, sun: (j.daily?.sunrise ?? []).map((r: number, i: number) => [r, j.daily.sunset[i]]) };
}

/** Wind for many points in one request (home page). One hourly record per point. */
export async function fetchManyWind(points: [number, number][], { days = 3 } = {}): Promise<Hourly[]> {
  const lat = points.map((p) => p[0].toFixed(3)).join(","), lon = points.map((p) => p[1].toFixed(3)).join(",");
  const j = await json(`https://api.open-meteo.com/v1/forecast?${qs({ latitude: lat, longitude: lon, hourly: "wind_speed_10m,wind_direction_10m", models: "ecmwf_ifs025", forecast_days: days, wind_speed_unit: "ms", timeformat: "unixtime", timezone: "GMT" })}`);
  return (Array.isArray(j) ? j : [j]).map((w: any) => w.hourly);
}

// ---------- geometry ----------

const C16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const WORDS: Record<string, string> = { N: "north", NNE: "north-northeast", NE: "northeast", ENE: "east-northeast", E: "east", ESE: "east-southeast", SE: "southeast", SSE: "south-southeast", S: "south", SSW: "south-southwest", SW: "southwest", WSW: "west-southwest", W: "west", WNW: "west-northwest", NW: "northwest", NNW: "north-northwest" };
export const compassWord = (d: number | null | undefined) => (d == null ? "–" : WORDS[compass(d)]);

/** "E/SE" → 112.5 (circular mean of the parts). */
export function facesDeg(faces: string) {
  const ds = faces.split("/").map((s) => C16.indexOf(s.trim()) * 22.5).filter((d) => d >= 0);
  const x = ds.reduce((a, d) => a + Math.cos((d * Math.PI) / 180), 0), y = ds.reduce((a, d) => a + Math.sin((d * Math.PI) / 180), 0);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest angle between two bearings, 0–180. */
export const angDiff = (a: number, b: number) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d; };

export type Tone = "good" | "fair" | "poor" | "none";
/**
 * Wind relative to a beach. `from` is the direction wind blows from; `faces` is the
 * direction the beach looks out to sea. Wind from the sea (diff ≈ 0) is onshore.
 * The tone is always shown with a text label, never colour alone.
 */
export function windState(from: number | null | undefined, speed: number | null | undefined, faces: number | null): { label: string; tone: Tone } {
  if (from == null || speed == null) return { label: "No wind data", tone: "none" };
  if (speed < 2) return { label: "Light", tone: "good" };
  if (faces == null) return { label: compass(from), tone: "none" };
  const d = angDiff(from, faces);
  if (d >= 135) return { label: "Offshore", tone: "good" };
  if (d >= 100) return { label: "Cross-offshore", tone: "good" };
  if (d >= 60) return { label: "Cross-shore", tone: "fair" };
  if (d >= 30) return { label: "Cross-onshore", tone: "poor" };
  return { label: "Onshore", tone: "poor" };
}

/** How directly a swell (from) reaches a beach (faces). */
export function swellExposure(from: number | null | undefined, faces: number | null) {
  if (from == null || faces == null) return "";
  const d = angDiff(from, faces);
  if (d <= 35) return "straight in";
  if (d <= 70) return "angled in";
  if (d <= 95) return "wrapping";
  return "blocked";
}

// ---------- tide ----------

export type TideEvent = { t: number; h: number; kind: string };
export type Tide = { t: number[]; v: number[]; events: TideEvent[] };
/** Half-cosine curve (metres) between CWA's high/low events, which come in cm. */
export function tideSeries(events: [string, string, number | null][], stepMin = 20): Tide {
  const ev = events.filter((e) => e[2] != null).map((e) => ({ t: Date.parse(e[0]) / 1000, h: (e[2] as number) / 100, kind: e[1] }));
  const t: number[] = [], v: number[] = [];
  for (let i = 0; i < ev.length - 1; i++) {
    const a = ev[i], b = ev[i + 1];
    for (let s = a.t; s < b.t; s += stepMin * 60) { t.push(s); v.push(a.h + (b.h - a.h) * (1 - Math.cos((Math.PI * (s - a.t)) / (b.t - a.t))) / 2); }
  }
  return { t, v, events: ev };
}

// ---------- series lookup ----------

/** Value of a series at time ts: nearest sample within `tol` seconds. */
export function at(t: number[] | undefined, v: Series | undefined, ts: number, tol = 2 * H): number | null {
  if (!t?.length || !v) return null;
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= ts) lo = mid; else hi = mid; }
  const i = Math.abs(t[lo] - ts) <= Math.abs(t[hi] - ts) ? lo : hi;
  return Math.abs(t[i] - ts) <= tol ? v[i] : null;
}

/** Linear interpolation (tide). */
export function lerp(t: number[], v: number[], ts: number): number | null {
  if (!t.length || ts < t[0] || ts > t[t.length - 1]) return null;
  const i = t.findIndex((x) => x >= ts);
  if (i <= 0) return v[0];
  const f = (ts - t[i - 1]) / (t[i] - t[i - 1]);
  return v[i - 1] + (v[i] - v[i - 1]) * f;
}

/** Observation file → { t: unix s[], col(name) → values[] }. */
export type ObsFile = { columns: string[]; rows: (string | number | null)[][] };
export type ObsTable = { t: number[]; col: (name: string) => Series };
export function obsTable(obs: ObsFile | null): ObsTable | null {
  if (!obs) return null;
  const t = obs.rows.map((r) => Date.parse(String(r[0])) / 1000);
  return { t, col: (name) => { const i = obs.columns.indexOf(name); return i < 0 ? t.map(() => null) : obs.rows.map((r) => r[i] as number | null); } };
}

// ---------- time (Taiwan) ----------

const tz = { timeZone: "Asia/Taipei" };
const fDay = new Intl.DateTimeFormat("en-GB", { ...tz, weekday: "short" });
const fNum = new Intl.DateTimeFormat("en-GB", { ...tz, day: "numeric" });
const fHm = new Intl.DateTimeFormat("en-GB", { ...tz, hour: "2-digit", minute: "2-digit", hour12: false });
const fHr = new Intl.DateTimeFormat("en-GB", { ...tz, hour: "numeric", hour12: false });
export const dayName = (ts: number) => fDay.format(ts * 1000);
export const dayNum = (ts: number) => fNum.format(ts * 1000);
export const hhmm = (ts: number) => fHm.format(ts * 1000);
export const hour = (ts: number) => Number(fHr.format(ts * 1000)) % 24;
export const whenLabel = (ts: number) => `${dayName(ts)} ${dayNum(ts)}, ${hhmm(ts)}`;
/** Unix seconds of local (Taipei) midnight on or before ts. */
export const localMidnight = (ts: number) => { const off = 8 * H; return Math.floor((ts + off) / 86400) * 86400 - off; };
export const nowS = () => Math.floor(Date.now() / 1000);

/** "Hualien Data Buoy" → "Hualien". */
export const cleanName = (s: string) => s.replace(/ (Data )?Buoy$/i, "").replace(/ Buoy Station$/i, "");
/** "花蓮資料浮標" → "花蓮". */
export const cleanZh = (s: string) => s.replace(/(資料)?浮標$|浮球式波浪站$/, "");
