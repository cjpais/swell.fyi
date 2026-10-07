// swell.fyi (Cloudflare Worker): the static site in dist/, served by Workers static assets, with
// each page's live data written into its HTML. The data is one small JSON file per page in R2
// (pages/home.json, pages/spots/{id}.json), cut by the swell-data Worker's cron whenever its
// sources change (scripts/lib/pages.ts). With it in the HTML, a page draws its numbers as soon as
// its script runs, instead of after another round trip to data.swell.fyi.
//
// Only the paths in run_worker_first (wrangler.jsonc) come through here; everything else is
// served as a plain static file. If the data is missing, the page goes out as built and fetches
// the same file from data.swell.fyi itself.

interface Env {
  ASSETS: Fetcher;
  BUCKET: R2Bucket;
}

/** Edge cache for the data files. The cron rewrites them at most every 10 minutes. */
const CACHE_S = 60;

function dataKey(path: string): string | null {
  if (path === "/") return "pages/home.json";
  const spot = /^\/spots\/([\w-]+)\/$/.exec(path);
  return spot ? `pages/spots/${spot[1]}.json` : null;
}

async function pageData(env: Env, ctx: ExecutionContext, key: string): Promise<string | null> {
  const cacheKey = new Request(`https://swell.fyi/__page-data/${key}`);
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit.text();
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  const text = await obj.text();
  ctx.waitUntil(caches.default.put(cacheKey, new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_S}` } })));
  return text;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const key = req.method === "GET" ? dataKey(new URL(req.url).pathname) : null;
    if (!key) return env.ASSETS.fetch(req);

    // The HTML now changes with the data, so the built file's ETag no longer describes it:
    // always fetch it whole, and send it out without validators.
    const headers = new Headers(req.headers);
    headers.delete("If-None-Match");
    headers.delete("If-Modified-Since");
    const [page, data] = await Promise.all([env.ASSETS.fetch(new Request(req, { headers })), pageData(env, ctx, key).catch(() => null)]);
    if (!data || page.status !== 200 || !page.headers.get("Content-Type")?.startsWith("text/html")) return page;

    // JSON only has "<" inside strings, where \u003c means the same thing and can't close the script.
    const script = `<script type="application/json" id="page-data">${data.replace(/</g, "\\u003c")}</script>`;
    const out = new HTMLRewriter().on("body", { element: (el) => void el.append(script, { html: true }) }).transform(page);
    const res = new Response(out.body, out);
    res.headers.delete("ETag");
    res.headers.delete("Last-Modified");
    res.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    return res;
  },
} satisfies ExportedHandler<Env>;
