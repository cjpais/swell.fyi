// Where the browser reads live data: the swell-data Worker (workers/data). Model forecasts
// at /field.json, CWA's buoys, tides and forecast under /cwa/. PUBLIC_DATA_BASE=/data reads
// the local copies that `bun run fetch` and `bun run fetch:field` write into public/data/.
export const DATA = (import.meta.env.PUBLIC_DATA_BASE || "https://data.swell.fyi").replace(/\/$/, "");
export const cwaUrl = (path: string) => `${DATA}/cwa/${path}`;

// One request per file per page, however many modules ask for it.
const memo = new Map<string, Promise<unknown>>();
export function getJson<T>(url: string): Promise<T> {
  let p = memo.get(url) as Promise<T> | undefined;
  if (!p) {
    p = fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`${url}: HTTP ${r.status}`))));
    memo.set(url, p);
    p.catch(() => memo.delete(url));
  }
  return p;
}
export const getCwa = <T>(path: string) => getJson<T>(cwaUrl(path));
/** Same, but null instead of an error, for data a page can do without. */
export const tryCwa = <T>(path: string) => getCwa<T>(path).catch(() => null);

// ---------- the live CWA files (scripts/lib/cwa.ts writes them) ----------
export type Latest = { time: string; values: Record<string, number | null>; archiveStart: string; archiveRows: number };
export type LiveStation = { id: string; name: string; nameEn: string; lat: number; lon: number; active: boolean; observes: string[]; latest: Latest | null };
export type CwaMeta = { fetchedAt: string; via: string; datasets: Record<string, { name: string; issued?: string }> };
export type ForecastRow = [string, number | null, number | null, number | null, number | null, number | null];
export type SpotForecast = { issued: string; columns: string[]; points: Record<string, { name: string; lat: number; lon: number; rows: ForecastRow[] }> };
export type SpotTide = { name: string; events: [string, string, number | null][] } | null;

export const loadStations = () => getCwa<LiveStation[]>("stations.json");
export const loadMeta = () => getCwa<CwaMeta>("meta.json");
export const loadSpotForecast = () => tryCwa<SpotForecast>("spot-forecast.json");
export const loadSpotTides = () => tryCwa<Record<string, SpotTide>>("spot-tides.json");
export const loadRecentHs = () => tryCwa<Record<string, [number, number | null][]>>("recent-hs.json");

/** A reading under 3 hours old. */
export const isFresh = (t: string | null | undefined, nowS = Date.now() / 1000) => t != null && nowS - Date.parse(t) / 1000 < 3 * 3600;
