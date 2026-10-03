// Build-time readers for the JSON written by scripts/fetch-cwa.ts.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA = join(process.cwd(), "public", "data");

function read<T>(name: string): T | null {
  const f = join(DATA, name);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : null;
}

export type Latest = {
  time: string;
  values: Record<string, number | null>;
  archiveStart: string;
  archiveRows: number;
};

export type Station = {
  id: string;
  name: string;
  nameEn: string;
  lat: number;
  lon: number;
  type: string;
  typeEn: string;
  county: string;
  countyZh: string;
  area: string;
  address: string;
  owner: string;
  active: boolean;
  observes: string[];
  latest: Latest | null;
};

export type Meta = { fetchedAt: string; via: string; datasets: Record<string, { name: string; issued?: string }> };

export const readMeta = () => read<Meta>("meta.json");
export const readStations = () => read<Station[]>("stations.json") ?? [];

export type ObsFile = { id: string; columns: string[]; rows: (string | number | null)[][] };
export const readObs = (id: string) => read<ObsFile>(`obs/${id}.json`);

/** Stations that have reported a wave height at some point in the archive. */
export const isWaveStation = (s: Station) => s.observes.includes("WaveHeight") || s.latest?.values.wave_height_m != null;

export type Recreation = {
  issued: string;
  columns: string[];
  points: Record<string, { name: string; lat: number; lon: number; rows: [string, number | null, number | null, number | null, number | null, number | null][] }>;
};
export const readRecreation = () => read<Recreation>("cwa-recreation.json");

/** Hourly wave height over the last `hours`, as [unixSeconds, Hs] pairs. */
export function recentHs(id: string, hours = 72): [number, number | null][] {
  const obs = readObs(id);
  if (!obs) return [];
  const cutoff = Date.now() - hours * 36e5;
  return obs.rows
    .map((r) => [Date.parse(String(r[0])) / 1000, r[1] as number | null] as [number, number | null])
    .filter(([t]) => t * 1000 >= cutoff);
}

export type TideLocation = { id: string; name: string; lat: number; lon: number; events: [string, "high" | "low", number | null][] };
export function nearestTide(lat: number, lon: number): TideLocation | null {
  const t = read<{ locations: TideLocation[] }>("tides.json");
  if (!t) return null;
  let best: TideLocation | null = null, bd = Infinity;
  for (const l of t.locations) {
    const d = (l.lat - lat) ** 2 + ((l.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}
