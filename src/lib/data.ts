// Where the browser reads live data: the swell-data Worker (workers/data). Model forecasts
// at /field.json, CWA's buoys, tides and forecast under /cwa/, and each page's slice of them
// under /pages/. PUBLIC_DATA_BASE=/data reads the local copies that `bun run fetch`,
// `bun run fetch:field` and `bun run fetch:pages` write into public/data/.
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
/** CWA's WRF runs at each spot (scripts/lib/wrf.ts): 10 m wind every 6 h to 84 h. */
export type WrfRun = { dataId: string; label: string; init: string; time: number[]; spots: Record<string, { lat: number; lon: number; speed: number[]; dir: number[] }> };
export type WrfWind = { fetchedAt: string; models: Partial<Record<"wrf15" | "wrf3", WrfRun>> };

export const loadStations = () => getCwa<LiveStation[]>("stations.json");
export const loadMeta = () => getCwa<CwaMeta>("meta.json");
export const loadSpotTides = () => tryCwa<Record<string, SpotTide>>("spot-tides.json");

// ---------- one file per page (scripts/lib/pages.ts builds them) ----------
export type { SpotPageData, HomePageData, BuoyPageData } from "../../scripts/lib/pages";

let inline: unknown;
/** The page's data, if the site Worker (workers/site) wrote it into the HTML. Parsed once. */
export function inlinePage<T>(): T | null {
  if (inline === undefined) {
    const text = document.getElementById("page-data")?.textContent;
    try { inline = text ? JSON.parse(text) : null; } catch { inline = null; }
  }
  return inline as T | null;
}

/** A page's live data: written into its HTML by the site Worker, else fetched. */
export function loadPage<T>(path: string): Promise<T | null> {
  const page = inlinePage<T>();
  return page ? Promise.resolve(page) : getJson<T>(`${DATA}/pages/${path}.json`).catch(() => null);
}

/** A reading under 3 hours old. */
export const isFresh = (t: string | null | undefined, nowS = Date.now() / 1000) => t != null && nowS - Date.parse(t) / 1000 < 3 * 3600;
