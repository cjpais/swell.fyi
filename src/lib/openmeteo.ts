// Open-Meteo (https://open-meteo.com) model forecasts, fetched in the browser.
// Free tier is for non-commercial use. Times come back as unix seconds (UTC).

export type Model = { id: string; label: string; short: string; color: string; about: string };

export const WAVE_MODELS: Model[] = [
  {
    id: "meteofrance_wave",
    label: "MFWAM (Météo-France)",
    short: "MFWAM",
    color: "--s3",
    about: "Météo-France WAM, 1/12° (~9 km), ~10 days. Has swell partitions.",
  },
  {
    id: "ncep_gfswave016",
    label: "GFS-Wave 0.16° (NOAA)",
    short: "GFS",
    color: "--s4",
    about: "NOAA WAVEWATCH III on GFS winds, 0.16°, 16 days. Has swell partitions.",
  },
  {
    id: "ecmwf_wam",
    label: "ECMWF WAM",
    short: "ECMWF",
    color: "--s5",
    about: "ECMWF IFS wave model, ~9 km, 15 days. Open-Meteo exposes total sea only (no swell partitions).",
  },
];

export const WIND_MODELS: Model[] = [
  { id: "ecmwf_ifs025", label: "ECMWF IFS 0.25°", short: "ECMWF", color: "--s5", about: "" },
  { id: "gfs_global", label: "GFS (NOAA)", short: "GFS", color: "--s4", about: "" },
];

const WAVE_VARS = [
  "wave_height",
  "wave_direction",
  "wave_period",
  "swell_wave_height",
  "swell_wave_direction",
  "swell_wave_period",
  "secondary_swell_wave_height",
  "secondary_swell_wave_direction",
  "secondary_swell_wave_period",
  "wind_wave_height",
  "wind_wave_direction",
  "wind_wave_period",
];

export type Grid = {
  /** Grid cell Open-Meteo actually used (nearest sea cell; can be several km from the request). */
  lat: number;
  lon: number;
  /** Per-model grid cells. Each model snaps to its own grid. */
  cells: Record<string, { lat: number; lon: number }>;
  url: string;
  time: number[];
  hourly: Record<string, (number | null)[]>;
  get: (variable: string, model: string) => (number | null)[];
  has: (variable: string, model: string) => boolean;
};

async function getGrid(url: string): Promise<Grid> {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.reason ?? `Open-Meteo HTTP ${res.status}`);
  const hourly = json.hourly as Record<string, (number | null)[]>;
  const time = hourly.time as number[];
  const get = (v: string, m: string) => hourly[`${v}_${m}`] ?? hourly[v] ?? time.map(() => null);
  return {
    lat: json.latitude,
    lon: json.longitude,
    cells: {},
    url,
    time,
    hourly,
    get,
    has: (v, m) => get(v, m).some((x) => x != null),
  };
}

export function marineUrl(lat: number, lon: number, pastDays = 3, forecastDays = 10, model?: string) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: WAVE_VARS.join(","),
    models: model ?? WAVE_MODELS.map((m) => m.id).join(","),
    past_days: String(Math.min(92, pastDays)),
    forecast_days: String(forecastDays),
    timeformat: "unixtime",
    timezone: "GMT",
  });
  return `https://marine-api.open-meteo.com/v1/marine?${q}`;
}

export function windUrl(lat: number, lon: number, pastDays = 3, forecastDays = 10) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    models: WIND_MODELS.map((m) => m.id).join(","),
    past_days: String(Math.min(92, pastDays)),
    forecast_days: String(forecastDays),
    wind_speed_unit: "ms",
    timeformat: "unixtime",
    timezone: "GMT",
  });
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

/**
 * One request per model, merged. A combined request would report a single grid cell,
 * but each model snaps to its own (sometimes 15+ km apart near Taiwan's coast).
 */
export async function fetchMarine(lat: number, lon: number, pastDays?: number, forecastDays?: number): Promise<Grid> {
  const grids = await Promise.all(
    WAVE_MODELS.map((m) => getGrid(marineUrl(lat, lon, pastDays, forecastDays, m.id)).catch(() => null)),
  );
  const ok = grids.filter((g) => g != null);
  if (!ok.length) throw new Error("Open-Meteo returned no wave data");
  const time = [...new Set(ok.flatMap((g) => g.time))].sort((a, b) => a - b);
  const hourly: Record<string, (number | null)[]> = { time };
  const cells: Grid["cells"] = {};
  grids.forEach((g, i) => {
    if (!g) return;
    const m = WAVE_MODELS[i].id;
    cells[m] = { lat: g.lat, lon: g.lon };
    const idx = new Map(g.time.map((t, j) => [t, j]));
    for (const [k, v] of Object.entries(g.hourly)) {
      if (k === "time") continue;
      hourly[`${k}_${m}`] = time.map((t) => (idx.has(t) ? v[idx.get(t)!] : null));
    }
  });
  const get = (v: string, m: string) => hourly[`${v}_${m}`] ?? time.map(() => null);
  return {
    lat: ok[0].lat,
    lon: ok[0].lon,
    cells,
    url: ok[0].url,
    time,
    hourly,
    get,
    has: (v, m) => get(v, m).some((x) => x != null),
  };
}

export const fetchWind = (lat: number, lon: number, pastDays?: number, forecastDays?: number) =>
  getGrid(windUrl(lat, lon, pastDays, forecastDays));

/** Great-circle distance in km. */
export function km(aLat: number, aLon: number, bLat: number, bLon: number) {
  const r = Math.PI / 180;
  const x = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

/** The partitioned model to read swell trains from: MFWAM, or GFS-Wave if MFWAM is missing. */
export type Partitioned = { label: string; time: number[]; get: (variable: string) => (number | null)[] };
export function partitioned(g: Grid | Error): Partitioned | null {
  if (g instanceof Error) return null;
  for (const m of WAVE_MODELS.slice(0, 2)) {
    if (g.has("wave_height", m.id)) return { label: m.id === "ncep_gfswave016" ? "GFS-Wave" : m.short, time: g.time, get: (v) => g.get(v, m.id) };
  }
  return null;
}
