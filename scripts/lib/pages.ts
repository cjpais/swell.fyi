// Each page's live data in one small file, cut from the files the swell-data Worker already
// builds: CWA's forecast, tides and buoys, CWA's WRF wind, and the per-spot model series in
// field.json. The site Worker (workers/site) writes the file into the page's HTML, so the page
// draws its numbers without waiting on a request; without it, the page fetches the file.
//
//   pages/home.json          the home page
//   pages/spots/{id}.json    each spot page
//   pages/buoys/{id}.json    each station's page
//
// Pure: the swell-data Worker (workers/data) and scripts/build-pages.ts feed it the sources.
// The types are the parts of each source file these pages read (src/lib/data.ts has the rest).
import { SPOTS, type Spot } from "../../src/data/spots";
import type { BuoyModelsFile } from "./field";
import type { WrfFile } from "./wrf";

type S = (number | null)[];
type Latest = { time: string; values: Record<string, number | null>; archiveStart?: string; archiveRows?: number };
type Station = { id: string; active?: boolean; observes?: string[]; latest: Latest | null };
type ForecastRow = [string, number | null, number | null, number | null, number | null, number | null];
type Forecast = { issued: string; columns: string[]; points: Record<string, { name: string; lat: number; lon: number; rows: ForecastRow[] }> };
type Tide = { name: string; events: [string, string, number | null][] } | null;
export type ObsFile = { columns: string[]; rows: (string | number | null)[][] };
/** A spot's entry in field.json (scripts/lib/field.ts). */
type FieldSpot = {
  wave: { label: string; lat: number; lon: number; time: number[]; [k: string]: S | number[] | string | number };
  wind: { lat: number; lon: number; time: number[]; wind_speed_10m: S; wind_direction_10m: S; wind_gusts_10m: S; sun: [number, number][] };
  sst: { time: number[]; v: S };
};

export type PageSources = {
  field: { fetchedAt: string; spots: Record<string, FieldSpot> } | null;
  stations: Station[];
  forecast: Forecast | null;
  tides: Record<string, Tide> | null;
  recentHs: Record<string, [number, number | null][]> | null;
  wrf: WrfFile | null;
  buoyModels: BuoyModelsFile | null;
  /** When CWA's data last changed (cwa/meta.json fetchedAt), for the masthead's "Buoys updated". */
  buoysUpdated: string | null;
};

export type SpotPageData = {
  builtAt: string;
  buoysUpdated: string | null;
  cwa: { code: string; name: string; lat: number; lon: number; issued: string; rows: ForecastRow[] } | null;
  /** The nearest of the spot's buoys with a wave reading in the last 12 hours. */
  buoy: { id: string; hs: number | null; time: string } | null;
  tide: Tide;
  wrf: { id: "wrf3" | "wrf15"; dataId: string; label: string; init: string; lat: number; lon: number; t: number[]; speed: number[]; dir: number[] }[];
  /** MFWAM sea, ECMWF IFS wind and SST at the spot: its entry in field.json. */
  model: (FieldSpot & { fetchedAt: string }) | null;
  /** That buoy's last two days. The charts fetch the whole file. */
  obs: ObsFile | null;
};

export type HomePageData = {
  builtAt: string;
  buoysUpdated: string | null;
  /** CWA's forecast at the spots' points only. */
  forecast: Forecast | null;
  latest: Record<string, Latest | null>;
  sparks: Record<string, [number, number | null][]> | null;
  /** ECMWF IFS wind at each spot, from 6 h ago to 4 days out (field.json). */
  wind: Record<string, { time: number[]; wind_speed_10m: S; wind_direction_10m: S }>;
};

export type BuoyPageData = {
  builtAt: string;
  buoysUpdated: string | null;
  /** From CWA's station list: transmitting or not, and the archive's size. */
  active: boolean | null;
  latest: Latest | null;
  /** The last week of readings: the timeline, the default charts and the raw table. Longer views fetch the 120-day file. */
  obs: ObsFile | null;
  /** Model sea state and wind at a wave buoy, from buoy-models.json. */
  model: (BuoyModelsFile["buoys"][string] & { fetchedAt: string }) | null;
};

const H = 3600 * 1000;

/** Stations that have reported a wave height at some point: they get the full buoy page. */
export const isWaveStation = (s: { observes?: string[]; latest: Latest | null }) => !!s.observes?.includes("WaveHeight") || s.latest?.values.wave_height_m != null;

/** Rows of an observation file from `ms` (unix ms) on. */
const since = (obs: ObsFile, ms: number): ObsFile => ({ columns: obs.columns, rows: obs.rows.filter((r) => Date.parse(String(r[0])) >= ms) });

/** The nearest of a spot's buoys (in the spot's order) with a wave reading in the last 12 hours. */
export function workingBuoy(spot: Spot, stations: PageSources["stations"], now = Date.now()): SpotPageData["buoy"] {
  const byId = new Map(stations.map((s) => [s.id, s]));
  for (const id of spot.buoys) {
    const l = byId.get(id)?.latest;
    if (l && l.values.wave_height_m != null && now - Date.parse(l.time) < 12 * H) return { id, hs: l.values.wave_height_m, time: l.time };
  }
  return null;
}

/** `obs` is the working buoy's file (cwa/obs/{id}.json), if there is one. */
export function spotPage(spot: Spot, src: PageSources, obs: ObsFile | null, now = Date.now()): SpotPageData {
  const point = src.forecast?.points[spot.cwaPoint];
  const model = src.field?.spots[spot.id];
  return {
    builtAt: new Date(now).toISOString(),
    buoysUpdated: src.buoysUpdated,
    cwa: point && src.forecast ? { code: spot.cwaPoint, name: point.name, lat: point.lat, lon: point.lon, issued: src.forecast.issued, rows: point.rows } : null,
    buoy: workingBuoy(spot, src.stations, now),
    tide: src.tides?.[spot.id] ?? null,
    wrf: (["wrf3", "wrf15"] as const).flatMap((id) => {
      const run = src.wrf?.models[id], at = run?.spots[spot.id];
      return run && at ? [{ id, dataId: run.dataId, label: run.label, init: run.init, lat: at.lat, lon: at.lon, t: run.time, speed: at.speed, dir: at.dir }] : [];
    }),
    model: model && src.field ? { ...model, fetchedAt: src.field.fetchedAt } : null,
    // The readout and the timeline reach back a day; keep two.
    obs: obs && since(obs, now - 48 * H),
  };
}

/** `obs` is the station's file (cwa/obs/{id}.json). */
export function buoyPage(id: string, src: PageSources, obs: ObsFile | null, now = Date.now()): BuoyPageData {
  const station = src.stations.find((s) => s.id === id);
  const model = src.buoyModels?.buoys[id];
  return {
    builtAt: new Date(now).toISOString(),
    buoysUpdated: src.buoysUpdated,
    active: station?.active ?? null,
    latest: station?.latest ?? null,
    // The charts open on 7 days; a day more covers the time until the next rebuild.
    obs: obs && since(obs, now - 8 * 24 * H),
    model: model && src.buoyModels ? { ...model, fetchedAt: src.buoyModels.fetchedAt } : null,
  };
}

export function homePage(src: PageSources, now = Date.now()): HomePageData {
  const points = new Set(SPOTS.map((s) => s.cwaPoint));
  const f = src.forecast;
  const from = (now - 6 * H) / 1000, to = (now + 4 * 24 * H) / 1000;
  return {
    builtAt: new Date(now).toISOString(),
    buoysUpdated: src.buoysUpdated,
    forecast: f && { ...f, points: Object.fromEntries(Object.entries(f.points).filter(([k]) => points.has(k))) },
    latest: Object.fromEntries(src.stations.map((s) => [s.id, s.latest])),
    sparks: src.recentHs,
    wind: Object.fromEntries(SPOTS.flatMap((s) => {
      const w = src.field?.spots[s.id]?.wind;
      if (!w) return [];
      const keep = w.time.flatMap((t, i) => (t >= from && t <= to ? [i] : []));
      return [[s.id, { time: keep.map((i) => w.time[i]), wind_speed_10m: keep.map((i) => w.wind_speed_10m[i]), wind_direction_10m: keep.map((i) => w.wind_direction_10m[i]) }]];
    })),
  };
}
