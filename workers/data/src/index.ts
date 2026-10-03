// swell.fyi model data (Cloudflare Worker, data.swell.fyi).
//
//   GET /field.json    wave + wind field and per-spot series for the explore map
//   GET /status        when field.json was built, from which model runs
//   POST /refresh      rebuild now (Authorization: Bearer $REFRESH_TOKEN; ?force=1 even if current)
//
// A cron checks Open-Meteo's model metadata every 30 minutes and rebuilds field.json only
// when MFWAM or ECMWF IFS has a new run (or the file is getting old), then stores it in R2.
// Visitors read it through the edge cache, so Open-Meteo never sees per-visitor traffic.
import { buildField, latestRuns } from "../../../scripts/lib/field";

interface Env {
  BUCKET: R2Bucket;
  OPEN_METEO_API_KEY?: string;
  REFRESH_TOKEN?: string;
}

const KEY = "data/field.json";
const ALLOWED_ORIGINS = new Set(["https://swell.fyi", "http://localhost:4747"]);
/** Rebuild anyway past this age, so the past-day/7-day window keeps sliding. */
const MAX_AGE_S = 6 * 3600;
/** Edge and browser cache. Short: a new build should show up within minutes. */
const CACHE_S = 300;

async function refresh(env: Env, force = false): Promise<string> {
  const key = env.OPEN_METEO_API_KEY || undefined;
  const runs = await latestRuns(key);
  const head = await env.BUCKET.head(KEY);
  const m = head?.customMetadata ?? {};
  const age = head ? Date.now() / 1000 - Number(m.builtAt ?? 0) : Infinity;
  const fresh = Number(m.wave) >= runs.wave && Number(m.wind) >= runs.wind && age < MAX_AGE_S;
  if (fresh && !force) {
    const msg = `field.json up to date (built ${Math.round(age / 60)} min ago)`;
    console.log(msg);
    return msg;
  }
  const field = await buildField({ key, runs, log: console.log });
  await env.BUCKET.put(KEY, JSON.stringify(field), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { builtAt: String(Math.round(Date.now() / 1000)), wave: String(runs.wave), wind: String(runs.wind) },
  });
  const msg = `field.json rebuilt (wave run ${new Date(runs.wave * 1000).toISOString()}, wind run ${new Date(runs.wind * 1000).toISOString()})`;
  console.log(msg);
  return msg;
}

function cors(req: Request, headers: Headers) {
  const origin = req.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

async function handle(url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/field.json") {
    const obj = await env.BUCKET.get(KEY);
    if (!obj) return new Response("Not built yet", { status: 404 });
    const headers = new Headers({ "Content-Type": "application/json", ETag: obj.httpEtag });
    return new Response(obj.body, { headers });
  }
  if (url.pathname === "/status") {
    const head = await env.BUCKET.head(KEY);
    const m = head?.customMetadata ?? {};
    const iso = (s?: string) => (s ? new Date(Number(s) * 1000).toISOString() : null);
    return Response.json({ field: head ? { builtAt: iso(m.builtAt), waveRun: iso(m.wave), windRun: iso(m.wind), bytes: head.size } : null });
  }
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/refresh") {
      const ok = env.REFRESH_TOKEN && req.headers.get("Authorization") === `Bearer ${env.REFRESH_TOKEN}`;
      if (!ok) return new Response("Unauthorized", { status: 401 });
      try {
        return new Response(await refresh(env, url.searchParams.has("force")) + "\n");
      } catch (e) {
        return new Response(`refresh failed: ${(e as Error).message}\n`, { status: 502 });
      }
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req, new Headers({ "Access-Control-Allow-Methods": "GET" })) });
    if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405 });

    const cacheKey = new Request(url.origin + url.pathname);
    const cache = caches.default;
    let res = await cache.match(cacheKey);
    if (!res) {
      res = await handle(url, env);
      if (res.status === 200) {
        res = new Response(res.body, res);
        res.headers.set("Cache-Control", `public, max-age=${url.pathname === "/status" ? 60 : CACHE_S}`);
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
      }
    }
    // Cached copies are origin-agnostic; add CORS per request.
    const out = new Response(res.body, res);
    cors(req, out.headers);
    return out;
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(refresh(env));
  },
} satisfies ExportedHandler<Env>;
