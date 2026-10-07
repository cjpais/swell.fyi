// Build-time readers. Pages are built from the station list (names, IDs, positions), which
// barely changes; every reading on them loads live in the browser from the swell-data Worker
// (src/lib/data.ts). The list comes from the local snapshot that `bun run fetch` writes
// (public/data/cwa/), or, when there isn't one (CI's deploy job), from the Worker.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./data";

const LOCAL = join(process.cwd(), "public", "data", "cwa");

function read<T>(name: string): T | null {
  const f = join(LOCAL, name);
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

let stations: Promise<Station[]> | null = null;
/** Every CWA marine station: the local snapshot, else the live list from the Worker. */
export function stationList(): Promise<Station[]> {
  return (stations ??= (async () => {
    const local = read<Station[]>("stations.json");
    if (local) return local;
    if (!/^https?:/.test(DATA)) return [];
    const r = await fetch(`${DATA}/cwa/stations.json`);
    if (!r.ok) throw new Error(`Station list: HTTP ${r.status} from ${DATA}/cwa/stations.json`);
    return (await r.json()) as Station[];
  })());
}

/** Stations that have reported a wave height at some point in the archive. */
export { isWaveStation } from "../../scripts/lib/pages";

// ---------- local snapshot only (design labs; the live pages don't use these) ----------
export type Meta = { fetchedAt: string; via: string; datasets: Record<string, { name: string; issued?: string }> };
export const readMeta = () => read<Meta>("meta.json");
export const readStations = () => read<Station[]>("stations.json") ?? [];

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
