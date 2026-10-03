// Standalone server for the design explorations. Does not touch the Astro app.
//   bun design/serve.mjs        → http://localhost:4848
// Serves design/ at /, the app's generated data (public/data, public/map) read-only,
// the local PMTiles basemap with byte ranges, and a few browser modules from node_modules.
import { join, extname, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";
import { SPOTS, REGIONS } from "../src/data/spots.ts";

const ROOT = join(import.meta.dir, "..");
const PORT = Number(process.env.PORT ?? 4848);

const MOUNTS = [
  ["/data/", join(ROOT, "public/data")],
  ["/map/", join(ROOT, "public/map")],
  ["/tiles/", join(ROOT, "tiles")],
  ["/vendor/", join(ROOT, "node_modules")],
  ["/", join(ROOT, "design")],
];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".pmtiles": "application/octet-stream",
};

function resolve(pathname) {
  for (const [prefix, dir] of MOUNTS) {
    if (!pathname.startsWith(prefix)) continue;
    let file = normalize(join(dir, decodeURIComponent(pathname.slice(prefix.length))));
    if (!file.startsWith(dir)) return null;
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (existsSync(file)) return file;
  }
  return null;
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/spots.json") return Response.json({ regions: REGIONS, spots: SPOTS });
    // Folder without a trailing slash: redirect, or the page's relative links (theme.css, riso.js…) break.
    const dir = join(ROOT, "design", decodeURIComponent(url.pathname));
    if (!url.pathname.endsWith("/") && dir.startsWith(join(ROOT, "design")) && existsSync(dir) && statSync(dir).isDirectory())
      return Response.redirect(`${url.pathname}/${url.search}${url.hash}`, 301);
    const file = resolve(url.pathname);
    if (!file) return new Response("Not found", { status: 404 });
    const f = Bun.file(file);
    const headers = { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Accept-Ranges": "bytes", "Cache-Control": "no-cache" };
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get("range") ?? "");
    if (!m) return new Response(f, { headers });
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), f.size - 1) : f.size - 1;
    return new Response(f.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${f.size}`, "Content-Length": String(end - start + 1) },
    });
  },
});

console.log(`Design explorations: http://localhost:${PORT}/`);
