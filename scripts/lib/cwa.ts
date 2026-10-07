// CWA open data: download, parse and derive the site's live JSON. Plain fetch, no Node APIs,
// so the same code runs in Bun (scripts/fetch-cwa.ts, which also grows the CSV archive) and in
// the swell-data Worker (workers/data, which keeps the live files in R2 fresh).
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { SPOTS } from "../../src/data/spots";

export const OBS_COLUMNS = [
  "time",
  "wave_height_m",
  "wave_dir_deg",
  "wave_period_s",
  "sea_temp_c",
  "air_temp_c",
  "pressure_hpa",
  "wind_speed_ms",
  "wind_dir_deg",
  "wind_gust_ms",
  "tide_height_m",
  "current_dir_deg",
  "current_speed_ms",
  "source",
] as const;

/** Values for OBS_COLUMNS minus `source`. */
export type ObsRow = (string | number | null)[];
/** Values for all OBS_COLUMNS, `source` last. */
export type ArchiveRow = (string | number | null)[];

export const SOURCE_OPEN_DATA = "O-B0075";
export const SOURCE_OCEAN_PORTAL = "ocean.cwa.gov.tw";
/** Days of hourly rows kept in each station's live JSON (obs/{id}.json). The CSV keeps all. */
export const OBS_WINDOW_DAYS = 120;

export const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "" || v === "None" || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// CWA's JSON is converted from XML, so single-element lists can arrive as bare objects.
export const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ---------- sources ----------

const S3 = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com";
export type Source = { id: string; s3Path: string; format: "JSON" | "ZIP"; name: string };
export const SOURCES = {
  obs48h: { id: "O-B0075-001", s3Path: "Observation/O-B0075-001.zip", format: "ZIP", name: "Marine observations, past 48h (hourly)" },
  obs30d: { id: "O-B0075-002", s3Path: "Observation/O-B0075-002.zip", format: "ZIP", name: "Marine observations, past 30 days (hourly)" },
  stations: { id: "O-B0076-001", s3Path: "Observation/O-B0076-001.json", format: "JSON", name: "Marine station metadata" },
  recreation: { id: "M-B0078-001", s3Path: "Model/M-B0078-001.json", format: "JSON", name: "Recreation sea forecast (WW3-based), 3-hourly, 72h" },
  tides: { id: "F-A0021-001", s3Path: "Forecast/F-A0021-001.json", format: "JSON", name: "Tide forecast, high/low times, 1 month" },
} satisfies Record<string, Source>;

/**
 * With a CWA API key, the official file API (which redirects to the same S3 objects);
 * without one, the public S3 bucket directly: unauthenticated, but undocumented.
 */
export const urlFor = (src: Source, key?: string) =>
  key ? `https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/${src.id}?Authorization=${key}&downloadType=WEB&format=${src.format}` : `${S3}/${src.s3Path}`;
export const s3Url = (src: Source) => `${S3}/${src.s3Path}`;

export async function download(src: Source, key?: string): Promise<Uint8Array> {
  const url = urlFor(src, key);
  // no-store: in a Worker, fetch() goes through Cloudflare's cache, which keeps .zip files for
  // hours by default; the 48 h observations would lag CWA by up to two.
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${src.id}: HTTP ${res.status} from ${key ? url.replace(key, "***") : url}`);
  return new Uint8Array(await res.arrayBuffer());
}
export const downloadJson = async (src: Source, key?: string) => JSON.parse(strFromU8(await download(src, key)));

// ---------- stations (O-B0076-001) ----------

// CWA's English names, where they're garbled or misleading.
const NAME_FIXES: Record<string, string> = {
  OAC005: "Honeymoon Bay Buoy",
  OAC003: "Bitou Cape Buoy",
  "46761F": "Chenggong Buoy",
  A6S01: "Green Island Gongguan Buoy",
  "1596": "Dawu",
  C4B03: "Changtanli",
};

export type StationMeta = {
  id: string; name: string; nameEn: string; lat: number; lon: number; type: string; typeEn: string;
  county: string; countyZh: string; area: string; address: string; owner: string; active: boolean; observes: string[];
};
export type Latest = { time: string; values: Record<string, number | null>; archiveStart: string; archiveRows: number };
/** Written by CI with the CSV archive: per station, first and last hour and the row count. */
export type ArchiveIndex = { updatedAt: string; stations: Record<string, { start: string; end: string; rows: number }> };

export function parseStations(doc: any): { stations: StationMeta[]; updated?: string } {
  const locs = arr<any>(doc.cwaopendata.Resources.Resource.Data.SeaSurfaceObs.Location);
  const stations = locs.map((l): StationMeta => {
    const s = l.Station;
    return {
      id: s.StationID,
      name: s.StationName,
      nameEn: NAME_FIXES[s.StationID] ?? String(s.StationNameEN ?? "").replace(/\s+/g, " ").trim(),
      lat: Number(s.StationLatitude),
      lon: Number(s.StationLongitude),
      type: s.StationAttribute,
      typeEn: s.StationAttributeEN,
      county: s.County?.CountyNameEN ?? "",
      countyZh: s.County?.CountyName ?? "",
      area: s.Area?.AreaNameEN ?? "",
      address: s.StationAddressEN ?? s.StationAddress ?? "",
      owner: s.StationChargeInsEN ?? s.StationChargeIns ?? "",
      active: l.StationObsStatus?.StationStatus === "1",
      observes: String(l.StationObsStatus?.ObservedPropertyNames ?? "").split(",").filter(Boolean),
    };
  });
  return { stations, updated: doc.cwaopendata.Resources.Resource.Metadata.Temporal?.Update };
}

/** Latest row with any wave reading, else the latest row at all. `rows` sorted by time. */
export function latestOf(rows: ArchiveRow[], archive?: { start: string; rows: number }): Latest | null {
  const last = rows.findLast((r) => r[1] !== null) ?? rows[rows.length - 1];
  if (!last) return null;
  return {
    time: String(last[0]),
    values: Object.fromEntries(OBS_COLUMNS.slice(1, -1).map((c, i) => [c, last[i + 1] as number | null])),
    archiveStart: archive?.start ?? String(rows[0][0]),
    archiveRows: archive?.rows ?? rows.length,
  };
}

export const withLatest = (stations: StationMeta[], latest: Record<string, Latest | null>) =>
  stations.map((s) => ({ ...s, latest: latest[s.id] ?? null }));

// ---------- observations (O-B0075-001 / -002) ----------

const xml = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (name) => name === "StationObsTime" || name === "Layer",
});

export function parseObsZip(buf: Uint8Array): Map<string, ObsRow[]> {
  const files = unzipSync(buf);
  const out = new Map<string, ObsRow[]>();
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith(".xml")) continue;
    const doc = xml.parse(strFromU8(data));
    const loc = doc?.cwaopendata?.Resources?.Resource?.Data?.SeaSurfaceObs?.Location;
    const id: string | undefined = loc?.Station?.StationID;
    if (!id) continue;
    const times = loc?.StationObsTimes?.StationObsTime ?? [];
    const rows: ObsRow[] = times.map((t: any) => {
      const w = t.WeatherElements ?? {};
      const a = w.PrimaryAnemometer ?? {};
      const cur = w.SeaCurrents?.Layer?.[0] ?? {};
      return [
        t.DataTime,
        num(w.WaveHeight),
        num(w.WaveDirection),
        num(w.WavePeriod),
        num(w.SeaTemperature),
        num(w.Temperature),
        num(w.StationPressure),
        num(a.WindSpeed),
        num(a.WindDirection),
        num(a.MaximumWindSpeed),
        num(w.TideHeight),
        num(cur.CurrentDirection),
        num(cur.CurrentSpeed),
      ];
    });
    out.set(id, rows);
  }
  return out;
}

/**
 * Merge fresh official rows into a station's rows (prefer-new: new values win, but a gap
 * never replaces a value), sorted by time, dropping rows before `cutoffMs` if given.
 * The same rule as the CSV archive's "prefer-new" merge (scripts/lib/archive.ts).
 */
export function mergeRows(existing: ArchiveRow[], fresh: ObsRow[], source = SOURCE_OPEN_DATA, cutoffMs?: number): ArchiveRow[] {
  const byTime = new Map(existing.map((r) => [String(r[0]), r]));
  for (const r of fresh) {
    const t = String(r[0]);
    const prev = byTime.get(t);
    byTime.set(t, prev ? [...r.map((v, i) => v ?? prev[i]), source] : [...r, source]);
  }
  const ms = (r: ArchiveRow) => Date.parse(String(r[0]));
  return [...byTime.values()].filter((r) => cutoffMs == null || ms(r) >= cutoffMs).sort((a, b) => ms(a) - ms(b));
}

export const obsFile = (id: string, rows: ArchiveRow[]) => ({ id, columns: OBS_COLUMNS, rows });

/** Last `hours` of wave height per station as [unix s, Hs], for the home page sparklines. */
export function recentHs(windows: Record<string, ArchiveRow[]>, hours = 72, nowMs = Date.now()) {
  const cutoff = nowMs - hours * 36e5;
  const out: Record<string, [number, number | null][]> = {};
  for (const [id, rows] of Object.entries(windows)) {
    const pts = rows.filter((r) => Date.parse(String(r[0])) >= cutoff).map((r) => [Date.parse(String(r[0])) / 1000, r[1] as number | null] as [number, number | null]);
    if (pts.some((p) => p[1] != null)) out[id] = pts;
  }
  return out;
}

/** Archive start and row count for the station page: the CSV's index plus newer live rows. */
export function archiveInfo(window: ArchiveRow[], idx?: { start: string; end: string; rows: number }) {
  if (!idx) return window.length ? { start: String(window[0][0]), rows: window.length } : undefined;
  const end = Date.parse(idx.end);
  return { start: idx.start, rows: idx.rows + window.filter((r) => Date.parse(String(r[0])) > end).length };
}

// ---------- recreation forecast (M-B0078-001) ----------

// CWA gives forecast directions as 16-point text like "東北東(ENE)". Convert to degrees ("from").
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export function dirFromText(s: unknown): number | null {
  const m = /\(([A-Za-z]+)\)/.exec(String(s ?? ""));
  if (!m) return null;
  const i = COMPASS.indexOf(m[1].toUpperCase());
  return i < 0 ? null : i * 22.5;
}

export type RecreationPoint = { name: string; lat: number; lon: number; rows: unknown[][] };
export function parseRecreation(doc: any) {
  const ds = doc.cwaopendata.dataset;
  const issued: string = ds.datasetInfo.IssueTime;
  const points: Record<string, RecreationPoint> = {};
  for (const l of arr<any>(ds.location)) {
    const p = (points[l.LocationCode] ??= { name: l.LocationName, lat: Number(l.Latitude), lon: Number(l.Longitude), rows: [] });
    p.rows.push([l.DateTime, num(l.SignificantWaveHeight), dirFromText(l.WaveDirectionForecast), num(l.WavePeriod), dirFromText(l.OceanCurrentDirectionForecast), num(l.OceanCurrentSpeed)]);
  }
  return { issued, columns: ["time", "wave_height_m", "wave_dir_deg", "wave_period_s", "current_dir_deg", "current_speed_ms"], points };
}
export type Recreation = ReturnType<typeof parseRecreation>;

/** Just the surf spots' forecast points (the full file has every beach and harbour). */
export const spotForecast = (rec: Recreation) => {
  const codes = new Set(SPOTS.map((s) => s.cwaPoint));
  return { ...rec, points: Object.fromEntries(Object.entries(rec.points).filter(([c]) => codes.has(c))) };
};

// ---------- tides (F-A0021-001) ----------

export type TideLocation = { id: string; name: string; lat: number; lon: number; events: unknown[][] };
export function parseTides(doc: any) {
  const locations = arr<any>(doc.cwaopendata.Resources.Resource.Data.TideForecasts).map((t): TideLocation => {
    const l = t.Location;
    const events: unknown[][] = [];
    for (const d of arr<any>(l.TimePeriods?.Daily)) {
      for (const e of arr<any>(d.Time)) events.push([e.DateTime, e.Tide === "滿潮" ? "high" : "low", num(e.TideHeights?.AboveLocalMSL)]);
    }
    return { id: l.LocationId, name: l.LocationName, lat: Number(l.Latitude), lon: Number(l.Longitude), events };
  });
  return { tides: { unit: "cm above local MSL", locations }, sent: doc.cwaopendata.Sent as string | undefined };
}

export function nearestTide(locations: TideLocation[], lat: number, lon: number): TideLocation | null {
  let best: TideLocation | null = null, bd = Infinity;
  for (const l of locations) {
    const d = (l.lat - lat) ** 2 + ((l.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}

/** Each surf spot's nearest tide forecast, so pages don't load all 266 locations. */
export const spotTides = (locations: TideLocation[]) =>
  Object.fromEntries(SPOTS.map((s) => {
    const t = nearestTide(locations, s.lat, s.lon);
    return [s.id, t ? { name: t.name, events: t.events } : null];
  }));
