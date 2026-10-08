// Keeps the live CWA files in R2 (cwa/*) fresh. Each run HEADs CWA's four S3 objects and only
// downloads and re-derives the ones whose ETag changed, so most runs cost four tiny requests.
// The 48 h observations get a new ETag every ~10 minutes whether or not anything in them changed
// (new readings come once an hour, at about half past, and a few corrections at :50), so their
// readings are hashed too, and the windows only rewritten when those differ.
//
// Writers are split so nothing races:
//   this Worker   cwa/stations.json, meta.json, obs/{id}.json (120-day windows), recent-hs.json,
//                 recreation.json, spot-forecast.json, tides.json, spot-tides.json
//   CI (archive)  cwa/csv/{id}.csv (the whole archive) and cwa/archive-index.json
// The obs windows are seeded once from the archive (scripts/publish-archive.sh --windows);
// after that this Worker merges each new 48 h file into them.
import {
  SOURCES, OBS_WINDOW_DAYS, s3Url, download, downloadJson, parseStations, parseObsZip, parseRecreation, parseTides,
  mergeRows, latestOf, archiveInfo, obsFile, recentHs, spotTides, spotForecast, withLatest,
  type ArchiveIndex, type ArchiveRow, type Latest, type Recreation, type Source, type StationMeta, type TideLocation,
} from "../../../scripts/lib/cwa";
import { SPOTS } from "../../../src/data/spots";

type Station = StationMeta & { latest: Latest | null };
type Meta = { fetchedAt: string | null; checkedAt: string; via: string; builder: string; datasets: Record<string, unknown> };
type State = { etags: Record<string, string>; obsHash?: string; spotIds?: string };

const P = "cwa/";
const STATE = "internal/cwa-state.json";
const LIVE: Source[] = [SOURCES.stations, SOURCES.obs48h, SOURCES.recreation, SOURCES.tides];

const getJson = async <T>(b: R2Bucket, key: string): Promise<T | null> => {
  const o = await b.get(key);
  return o ? ((await o.json()) as T) : null;
};
const putJson = (b: R2Bucket, key: string, v: unknown) => b.put(key, JSON.stringify(v), { httpMetadata: { contentType: "application/json" } });
/** SHA-256 of every station's readings, in station order. */
async function readingsHash(obs: Map<string, unknown[]>) {
  const bytes = new TextEncoder().encode(JSON.stringify([...obs].sort(([a], [b]) => a.localeCompare(b))));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Run `fn` over `items`, `n` at a time. */
async function inBatches<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn));
}

export async function refreshCwa(B: R2Bucket, { key, force = false }: { key?: string; force?: boolean } = {}): Promise<string[]> {
  const nowIso = new Date().toISOString();
  const state = (await getJson<State>(B, STATE)) ?? { etags: {} };
  // The spot list can change while CWA's tide file does not, so its ids are tracked separately.
  const spotIds = SPOTS.map((s) => s.id).join(",");
  const etags = await Promise.all(LIVE.map(async (s) => (await fetch(s3Url(s), { method: "HEAD", cache: "no-store" })).headers.get("etag")));
  const todo = new Set(LIVE.filter((s, i) => force || !etags[i] || etags[i] !== state.etags[s.id]).map((s) => s.id));
  const done = (s: Source) => { const e = etags[LIVE.indexOf(s)]; if (e) state.etags[s.id] = e; };

  const meta: Meta = { fetchedAt: null, datasets: {}, ...(await getJson<Meta>(B, `${P}meta.json`)), checkedAt: nowIso, via: key ? "opendata.cwa.gov.tw file API" : "CWA public S3 bucket", builder: "swell-data" };
  const log: string[] = [], errors: string[] = [];
  const step = async (s: Source, fn: () => Promise<string>) => {
    if (!todo.has(s.id)) return;
    try { log.push(`${s.id}: ${await fn()}`); done(s); }
    catch (e) { errors.push(`${s.id}: ${(e as Error).message}`); }
  };

  let stations: Station[] | null = null, stationsDirty = false;
  const current = async () => (stations ??= (await getJson<Station[]>(B, `${P}stations.json`)) ?? []);

  await step(SOURCES.stations, async () => {
    const { stations: list, updated } = parseStations(await downloadJson(SOURCES.stations, key));
    const prev = new Map((await current()).map((s) => [s.id, s.latest]));
    stations = withLatest(list, Object.fromEntries(prev));
    stationsDirty = true;
    meta.datasets[SOURCES.stations.id] = { name: SOURCES.stations.name, updated };
    return `${list.length} stations`;
  });

  await step(SOURCES.obs48h, async () => {
    const obs = parseObsZip(await download(SOURCES.obs48h, key));
    const hash = await readingsHash(obs);
    if (!force && hash === state.obsHash) return `${obs.size} stations, readings unchanged`;
    const index = await getJson<ArchiveIndex>(B, `${P}archive-index.json`);
    const cutoff = Date.now() - OBS_WINDOW_DAYS * 86400e3;
    const latest: Record<string, Latest | null> = {}, recent: Record<string, ArchiveRow[]> = {};
    let added = 0;
    // A few stations at a time keeps memory flat: each window is ~3k rows.
    await inBatches([...obs], 6, async ([id, rows]) => {
      const prev = (await getJson<{ rows: ArchiveRow[] }>(B, `${P}obs/${id}.json`))?.rows ?? [];
      const merged = mergeRows(prev, rows, undefined, cutoff);
      added += Math.max(0, merged.length - prev.length);
      await putJson(B, `${P}obs/${id}.json`, obsFile(id, merged));
      latest[id] = latestOf(merged, archiveInfo(merged, index?.stations[id]));
      recent[id] = merged.slice(-96);
    });
    await putJson(B, `${P}recent-hs.json`, recentHs(recent));
    stations = (await current()).map((s) => (s.id in latest ? { ...s, latest: latest[s.id] } : s));
    stationsDirty = true;
    meta.fetchedAt = nowIso;
    meta.datasets[SOURCES.obs48h.id] = { name: SOURCES.obs48h.name };
    state.obsHash = hash;
    return `${obs.size} stations, ${added} new hourly rows`;
  });
  if (stationsDirty && stations) await putJson(B, `${P}stations.json`, stations);

  await step(SOURCES.recreation, async () => {
    const rec = parseRecreation(await downloadJson(SOURCES.recreation, key));
    await putJson(B, `${P}recreation.json`, rec);
    await putJson(B, `${P}spot-forecast.json`, spotForecast(rec));
    meta.datasets[SOURCES.recreation.id] = { name: SOURCES.recreation.name, issued: rec.issued };
    return `issued ${rec.issued}`;
  });

  await step(SOURCES.tides, async () => {
    const { tides, sent } = parseTides(await downloadJson(SOURCES.tides, key));
    await putJson(B, `${P}tides.json`, tides);
    await putJson(B, `${P}spot-tides.json`, spotTides(tides.locations));
    meta.datasets[SOURCES.tides.id] = { name: SOURCES.tides.name, sent };
    return `${tides.locations.length} locations`;
  });

  // CWA's own files only change when it republishes them, so a new or renamed spot would keep
  // the old per-spot cuts: re-cut them from the stored sources whenever the spot list moves.
  if (state.spotIds !== spotIds) {
    const [tides, rec] = await Promise.all([
      getJson<{ locations: TideLocation[] }>(B, `${P}tides.json`),
      getJson<Recreation>(B, `${P}recreation.json`),
    ]);
    const cut: string[] = [];
    if (tides?.locations) { await putJson(B, `${P}spot-tides.json`, spotTides(tides.locations)); cut.push("spot-tides.json"); }
    if (rec) { await putJson(B, `${P}spot-forecast.json`, spotForecast(rec)); cut.push("spot-forecast.json"); }
    if (cut.length) {
      state.spotIds = spotIds;
      log.push(`${cut.join(", ")}: re-cut for ${SPOTS.length} spots`);
    }
  }

  await putJson(B, `${P}meta.json`, meta);
  await putJson(B, STATE, state);
  if (!todo.size) log.push("CWA files unchanged");
  if (errors.length) throw new Error(`CWA refresh: ${errors.join("; ")} (done: ${log.join("; ") || "nothing"})`);
  return log;
}
