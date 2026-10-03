// Data access + surf geometry shared by every design direction.
// CWA data comes from the app's generated public/data (served by design/serve.mjs);
// model forecasts come live from Open-Meteo, same as the app.

const H = 3600;
const json = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))));

export const loadSpots = () => json("/spots.json");
export const loadStations = () => json("/data/stations.json");
export const loadRecreation = () => json("/data/cwa-recreation.json").catch(() => null);
export const loadTides = () => json("/data/tides.json").catch(() => null);
export const loadMeta = () => json("/data/meta.json").catch(() => null);
export const loadObs = (id) => json(`/data/obs/${id}.json`).catch(() => null);

/** Observation file → { t: unix s[], col(name) → values[] }. */
export function obsTable(obs) {
  if (!obs) return null;
  const t = obs.rows.map((r) => Date.parse(r[0]) / 1000);
  return { t, col: (name) => { const i = obs.columns.indexOf(name); return i < 0 ? t.map(() => null) : obs.rows.map((r) => r[i]); } };
}

// ---------- Open-Meteo ----------

const PARTS = ["wave_height", "wave_direction", "wave_period", "swell_wave_height", "swell_wave_direction", "swell_wave_period", "secondary_swell_wave_height", "secondary_swell_wave_direction", "secondary_swell_wave_period", "wind_wave_height", "wind_wave_direction", "wind_wave_period"];

function qs(o) { return new URLSearchParams(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]))); }

/** Hourly sea state at one point: MFWAM (has swell partitions), GFS-Wave as fallback. */
export async function fetchSea(lat, lon, { past = 1, days = 7 } = {}) {
  for (const model of ["meteofrance_wave", "ncep_gfswave016"]) {
    const url = `https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: PARTS.join(","), models: model, past_days: past, forecast_days: days, timeformat: "unixtime", timezone: "GMT" })}`;
    try {
      const j = await json(url);
      if (j.hourly?.wave_height?.some((v) => v != null)) return { model, label: model === "meteofrance_wave" ? "MFWAM" : "GFS-Wave", lat: j.latitude, lon: j.longitude, url, ...j.hourly };
    } catch {}
  }
  throw new Error("Open-Meteo returned no wave data");
}

/** Hourly sea-surface temperature (Open-Meteo's default marine model; MFWAM doesn't carry it). */
export async function fetchSST(lat, lon) {
  const j = await json(`https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: "sea_surface_temperature", past_days: 1, forecast_days: 7, timeformat: "unixtime", timezone: "GMT" })}`);
  return j.hourly;
}

/** Hourly 10 m wind (ECMWF IFS) plus sunrise/sunset. */
export async function fetchWind(lat, lon, { past = 1, days = 7 } = {}) {
  const url = `https://api.open-meteo.com/v1/forecast?${qs({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m", daily: "sunrise,sunset", models: "ecmwf_ifs025", past_days: past, forecast_days: days, wind_speed_unit: "ms", timeformat: "unixtime", timezone: "GMT" })}`;
  const j = await json(url);
  return { url, lat: j.latitude, lon: j.longitude, ...j.hourly, sun: (j.daily?.sunrise ?? []).map((r, i) => [r, j.daily.sunset[i]]) };
}

/** Wind for many points in one request (home page). Returns one { wind } per point. */
export async function fetchMany(points, { days = 3 } = {}) {
  const lat = points.map((p) => p[0].toFixed(3)).join(","), lon = points.map((p) => p[1].toFixed(3)).join(",");
  const wind = await json(`https://api.open-meteo.com/v1/forecast?${qs({ latitude: lat, longitude: lon, hourly: "wind_speed_10m,wind_direction_10m", models: "ecmwf_ifs025", forecast_days: days, wind_speed_unit: "ms", timeformat: "unixtime", timezone: "GMT" })}`);
  return (Array.isArray(wind) ? wind : [wind]).map((w) => ({ wind: w.hourly }));
}

// ---------- Geometry ----------

const C16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const WORDS = { N: "north", NNE: "north-northeast", NE: "northeast", ENE: "east-northeast", E: "east", ESE: "east-southeast", SE: "southeast", SSE: "south-southeast", S: "south", SSW: "south-southwest", SW: "southwest", WSW: "west-southwest", W: "west", WNW: "west-northwest", NW: "northwest", NNW: "north-northwest" };
export const compass = (d) => (d == null ? "–" : C16[Math.round((((d % 360) + 360) % 360) / 22.5) % 16]);
export const compassWord = (d) => (d == null ? "–" : WORDS[compass(d)]);

/** "E/SE" → 112.5 (circular mean of the parts). */
export function facesDeg(faces) {
  const ds = String(faces).split("/").map((s) => C16.indexOf(s.trim()) * 22.5).filter((d) => d >= 0);
  const x = ds.reduce((a, d) => a + Math.cos((d * Math.PI) / 180), 0), y = ds.reduce((a, d) => a + Math.sin((d * Math.PI) / 180), 0);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest angle between two bearings, 0–180. */
export const angDiff = (a, b) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d; };

/**
 * Wind relative to a beach. `from` is the direction wind blows from; `faces` is the
 * direction the beach looks out to sea. Wind from the sea (diff ≈ 0) is onshore.
 * tone: good | fair | poor — always shown with a text label, never color alone.
 */
export function windState(from, speed, faces) {
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
export function swellExposure(from, faces) {
  if (from == null || faces == null) return "";
  const d = angDiff(from, faces);
  if (d <= 35) return "straight in";
  if (d <= 70) return "angled in";
  if (d <= 95) return "wrapping";
  return "blocked";
}

/** Great-circle distance in km. */
export function km(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const x = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

export function nearestTide(tides, lat, lon) {
  let best = null, bd = Infinity;
  for (const l of tides?.locations ?? []) {
    const d = (l.lat - lat) ** 2 + ((l.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}

/** Half-cosine curve between CWA's high/low events (metres). */
export function tideCurve(events, stepMin = 20) {
  const ev = events.filter((e) => e[2] != null).map((e) => [Date.parse(e[0]) / 1000, e[2] / 100]);
  const t = [], v = [];
  for (let i = 0; i < ev.length - 1; i++) {
    const [t0, h0] = ev[i], [t1, h1] = ev[i + 1];
    for (let s = t0; s < t1; s += stepMin * 60) { t.push(s); v.push(h0 + (h1 - h0) * (1 - Math.cos((Math.PI * (s - t0)) / (t1 - t0))) / 2); }
  }
  return { t, v, events: ev.map(([t, h], i) => ({ t, h, kind: events.filter((e) => e[2] != null)[i][1] })) };
}

/** Value of a series at time ts: nearest sample within `tol` seconds. */
export function at(t, v, ts, tol = 2 * H) {
  if (!t?.length) return null;
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= ts) lo = mid; else hi = mid; }
  const i = Math.abs(t[lo] - ts) <= Math.abs(t[hi] - ts) ? lo : hi;
  return Math.abs(t[i] - ts) <= tol ? v[i] : null;
}

/** Linear interpolation (tide). */
export function lerp(t, v, ts) {
  if (!t?.length || ts < t[0] || ts > t[t.length - 1]) return null;
  let i = t.findIndex((x) => x >= ts);
  if (i <= 0) return v[0];
  const f = (ts - t[i - 1]) / (t[i] - t[i - 1]);
  return v[i - 1] + (v[i] - v[i - 1]) * f;
}

// ---------- Formatting ----------

export const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? "–" : v.toFixed(d));
const tz = { timeZone: "Asia/Taipei" };
export const dayName = (ts) => new Intl.DateTimeFormat("en-GB", { ...tz, weekday: "short" }).format(ts * 1000);
export const dayNum = (ts) => new Intl.DateTimeFormat("en-GB", { ...tz, day: "numeric" }).format(ts * 1000);
export const hhmm = (ts) => new Intl.DateTimeFormat("en-GB", { ...tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(ts * 1000);
export const hour = (ts) => Number(new Intl.DateTimeFormat("en-GB", { ...tz, hour: "numeric", hour12: false }).format(ts * 1000)) % 24;
export const whenLabel = (ts) => `${dayName(ts)} ${dayNum(ts)}, ${hhmm(ts)}`;
/** Unix seconds of local (Taipei) midnight on or before ts. */
export const localMidnight = (ts) => { const off = 8 * H; return Math.floor((ts + off) / 86400) * 86400 - off; };

export function relTime(ts) {
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export const nowS = () => Math.floor(Date.now() / 1000);
export const HOUR = H;
