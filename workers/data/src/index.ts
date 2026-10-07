// swell.fyi live data (Cloudflare Worker, data.swell.fyi). The site is static; everything
// that changes by the hour comes from here, out of R2 and through the edge cache.
//
//   GET /field.json        wave + wind field and per-spot series for the explore map (Open-Meteo)
//   GET /cwa/...           CWA buoys, tides and forecast (see src/cwa.ts for the files), plus
//                          each station's full archive at /cwa/csv/{id}.csv (uploaded by CI),
//                          and CWA's WRF wind at each spot at /cwa/wrf-wind.json
//   GET /pages/...         each page's slice of all that (scripts/lib/pages.ts): /pages/home.json,
//                          /pages/spots/{id}.json. The site Worker writes them into the HTML.
//   GET /status            when each part was last built
//   POST /refresh          rebuild now (Authorization: Bearer $REFRESH_TOKEN)
//                          ?only=field|cwa|wrf|pages to pick one, ?force=1 to rebuild even if current
//
// A cron runs every 10 minutes. Each part checks cheaply whether its upstream changed (Open-Meteo
// model metadata, CWA's S3 ETags) and only downloads and rebuilds when it has. The pages go
// last, and are rebuilt when any file they're cut from has changed.
import { buildField, latestRuns } from "../../../scripts/lib/field";
import { buildWrf, wrfEtags, WRF_MODELS, type WrfFile } from "../../../scripts/lib/wrf";
import { homePage, spotPage, workingBuoy, type ObsFile, type PageSources } from "../../../scripts/lib/pages";
import { SPOTS } from "../../../src/data/spots";
import { refreshCwa } from "./cwa";

interface Env {
  BUCKET: R2Bucket;
  OPEN_METEO_API_KEY?: string;
  CWA_API_KEY?: string;
  REFRESH_TOKEN?: string;
}

const FIELD = "data/field.json";
const WRF = "cwa/wrf-wind.json";
const HOME = "pages/home.json";
/** What the pages are cut from, in PageSources order. */
const PAGE_SOURCES = [FIELD, "cwa/stations.json", "cwa/spot-forecast.json", "cwa/spot-tides.json", "cwa/recent-hs.json", WRF];
// The site, plus any local dev or preview port. The data is public and read-only.
const allowed = (o: string) => o === "https://swell.fyi" || /^http:\/\/localhost:\d+$/.test(o);
/** Rebuild the field anyway past this age, so the past-day/7-day window keeps sliding. */
const MAX_AGE_S = 6 * 3600;
/** Edge and browser cache. Short: a new build should show up within minutes. */
const CACHE_S = 300;

async function refreshField(env: Env, force = false): Promise<string> {
  const key = env.OPEN_METEO_API_KEY || undefined;
  const runs = await latestRuns(key);
  const head = await env.BUCKET.head(FIELD);
  const m = head?.customMetadata ?? {};
  const age = head ? Date.now() / 1000 - Number(m.builtAt ?? 0) : Infinity;
  const fresh = Number(m.wave) >= runs.wave && Number(m.wind) >= runs.wind && age < MAX_AGE_S;
  if (fresh && !force) return `field.json up to date (built ${Math.round(age / 60)} min ago)`;
  const field = await buildField({ key, runs });
  await env.BUCKET.put(FIELD, JSON.stringify(field), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { builtAt: String(Math.round(Date.now() / 1000)), wave: String(runs.wave), wind: String(runs.wind) },
  });
  return `field.json rebuilt (wave run ${new Date(runs.wave * 1000).toISOString()}, wind run ${new Date(runs.wind * 1000).toISOString()})`;
}

/** CWA's WRF runs: rebuild a model when its last lead file changes, i.e. a new run has fully landed. */
async function refreshWrf(env: Env, force = false): Promise<string[]> {
  const etags = await wrfEtags();
  const obj = await env.BUCKET.get(WRF);
  const seen = (obj?.customMetadata?.etags ?? "").split(",");
  const ids = WRF_MODELS.filter((m, i) => force || !etags[i] || etags[i] !== seen[i]).map((m) => m.id);
  if (!ids.length) { await obj?.body.cancel(); return ["wrf-wind.json up to date"]; }
  const prev = obj ? ((await obj.json()) as WrfFile) : null;
  const { file, built, errors } = await buildWrf(prev, { ids });
  if (built.length) {
    // Record an ETag only for models that built, so the others retry on the next run.
    const next = WRF_MODELS.map((m, i) => (built.includes(m.id) ? etags[i] : seen[i] ?? ""));
    await env.BUCKET.put(WRF, JSON.stringify(file), { httpMetadata: { contentType: "application/json" }, customMetadata: { etags: next.join(",") } });
  }
  const log = built.map((id) => `${id} rebuilt (run ${file.models[id]!.init})`);
  if (errors.length) throw new Error(`WRF refresh: ${errors.join("; ")}${log.length ? ` (done: ${log.join("; ")})` : ""}`);
  return log;
}

/**
 * Each page's slice (scripts/lib/pages.ts), rebuilt when any of its sources has changed, and at
 * least hourly, since which buoy counts as working depends on the time too.
 */
async function refreshPages(env: Env, force = false): Promise<string> {
  const [heads, home] = await Promise.all([Promise.all(PAGE_SOURCES.map((k) => env.BUCKET.head(k))), env.BUCKET.head(HOME)]);
  const sources = heads.map((h) => h?.etag ?? "").join(",");
  const ageS = home ? (Date.now() - home.uploaded.getTime()) / 1000 : Infinity;
  if (!force && home?.customMetadata?.sources === sources && ageS < 3600) return `pages up to date (built ${Math.round(ageS / 60)} min ago)`;

  const read = async <T>(key: string) => {
    const obj = await env.BUCKET.get(key);
    return obj ? ((await obj.json()) as T) : null;
  };
  const [field, stations, forecast, tides, recentHs, wrf] = await Promise.all(PAGE_SOURCES.map((k) => read<unknown>(k)));
  const src = { field, stations: stations ?? [], forecast, tides, recentHs, wrf } as PageSources;
  const now = Date.now();
  const buoys = new Map(SPOTS.map((s) => [s.id, workingBuoy(s, src.stations, now)?.id ?? null]));
  const ids = [...new Set([...buoys.values()].filter((id) => id != null))];
  const obs = new Map(await Promise.all(ids.map(async (id) => [id, await read<ObsFile>(`cwa/obs/${id}.json`)] as const)));

  const put = (key: string, body: unknown, meta: Record<string, string> = {}) =>
    env.BUCKET.put(key, JSON.stringify(body), { httpMetadata: { contentType: "application/json" }, customMetadata: meta });
  await Promise.all(SPOTS.map((s) => {
    const id = buoys.get(s.id);
    return put(`pages/spots/${s.id}.json`, spotPage(s, src, id ? obs.get(id) ?? null : null, now));
  }));
  // Home last: its metadata marks the whole set as built from these sources.
  await put(HOME, homePage(src, now), { sources });
  return `pages rebuilt (home + ${SPOTS.length} spots)`;
}

async function refresh(env: Env, { only, force = false }: { only?: string | null; force?: boolean } = {}): Promise<string[]> {
  const jobs: [string, () => Promise<string | string[]>][] = [
    ["field", () => refreshField(env, force)],
    ["cwa", () => refreshCwa(env.BUCKET, { key: env.CWA_API_KEY || undefined, force })],
    ["wrf", () => refreshWrf(env, force)],
  ];
  const results = await Promise.allSettled(jobs.filter(([name]) => !only || only === name).map(([, fn]) => fn()));
  // The pages are cut from the files above, so they go after them.
  if (!only || only === "pages") results.push(...(await Promise.allSettled([refreshPages(env, force)])));
  const out = results.flatMap((r) => (r.status === "fulfilled" ? [r.value].flat() : [`FAILED ${(r.reason as Error).message}`]));
  out.forEach((l) => (l.startsWith("FAILED") ? console.error(l) : console.log(l)));
  return out;
}

function cors(req: Request, headers: Headers) {
  const origin = req.headers.get("Origin");
  if (origin && allowed(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

async function fromR2(env: Env, key: string, extra: Record<string, string> = {}): Promise<Response> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const type = key.endsWith(".csv") ? "text/csv; charset=utf-8" : "application/json";
  return new Response(obj.body, { headers: { "Content-Type": type, ETag: obj.httpEtag, ...extra } });
}

async function handle(url: URL, env: Env): Promise<Response> {
  const path = url.pathname;
  if (path === "/field.json") return fromR2(env, FIELD);
  const cwa = /^\/cwa\/((?:obs\/|csv\/)?[\w-]+\.(json|csv))$/.exec(path);
  if (cwa) {
    const file = cwa[1];
    return fromR2(env, `cwa/${file}`, file.endsWith(".csv") ? { "Content-Disposition": `attachment; filename="${file.split("/").pop()}"` } : {});
  }
  const page = /^\/pages\/((?:spots\/)?[\w-]+\.json)$/.exec(path);
  if (page) return fromR2(env, `pages/${page[1]}`);
  if (path === "/status") {
    const [field, meta, index, wrf, home] = await Promise.all([env.BUCKET.head(FIELD), env.BUCKET.get("cwa/meta.json"), env.BUCKET.get("cwa/archive-index.json"), env.BUCKET.get(WRF), env.BUCKET.head(HOME)]);
    const m = field?.customMetadata ?? {};
    const iso = (s?: string) => (s ? new Date(Number(s) * 1000).toISOString() : null);
    const cwaMeta = meta ? ((await meta.json()) as { fetchedAt: string; checkedAt: string; datasets: unknown }) : null;
    return Response.json({
      field: field ? { builtAt: iso(m.builtAt), waveRun: iso(m.wave), windRun: iso(m.wind), bytes: field.size } : null,
      cwa: cwaMeta ? { fetchedAt: cwaMeta.fetchedAt, checkedAt: cwaMeta.checkedAt, datasets: cwaMeta.datasets } : null,
      archive: index ? { updatedAt: ((await index.json()) as { updatedAt: string }).updatedAt } : null,
      pages: home ? { builtAt: home.uploaded.toISOString() } : null,
      wrf: wrf ? await wrf.json<WrfFile>().then((w) => ({ fetchedAt: w.fetchedAt, runs: Object.fromEntries(Object.entries(w.models).map(([id, m]) => [id, m!.init])) })) : null,
    });
  }
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/refresh") {
      const ok = env.REFRESH_TOKEN && req.headers.get("Authorization") === `Bearer ${env.REFRESH_TOKEN}`;
      if (!ok) return new Response("Unauthorized", { status: 401 });
      const out = await refresh(env, { only: url.searchParams.get("only"), force: url.searchParams.has("force") });
      return new Response(out.join("\n") + "\n", { status: out.some((l) => l.startsWith("FAILED")) ? 502 : 200 });
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req, new Headers({ "Access-Control-Allow-Methods": "GET" })) });
    if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405 });

    const cacheKey = new Request(url.origin + url.pathname);
    const cache = caches.default;
    const cacheControl = `public, max-age=${url.pathname === "/status" ? 60 : CACHE_S}`;
    let res = await cache.match(cacheKey);
    if (!res) {
      res = await handle(url, env);
      if (res.status === 200) {
        res = new Response(res.body, res);
        res.headers.set("Cache-Control", cacheControl);
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
      }
    }
    // Cached copies are origin-agnostic; add CORS per request. Set Cache-Control again too:
    // copies out of the edge cache come back carrying the zone's Browser Cache TTL (4 h).
    const out = new Response(res.body, res);
    cors(req, out.headers);
    if (out.status === 200) out.headers.set("Cache-Control", cacheControl);
    return out;
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(refresh(env));
  },
} satisfies ExportedHandler<Env>;
