// @ts-check
import { defineConfig } from 'astro/config';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * modulepreload links, so a page's JS downloads in one round trip instead of one per level of
 * imports (each a round trip to the edge; ~150 ms from Taiwan on the Free plan):
 *  - every module the page's scripts import, directly or not (Astro links only the entry), and
 *  - on pages with a map, the map chunk, which pages load with import() (src/lib/lazy-map.ts)
 *    so their numbers don't wait on MapLibre. Listed last, so it doesn't go ahead of the rest.
 * @returns {import('astro').AstroIntegration}
 */
function modulePreload() {
  return {
    name: 'module-preload',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const assets = join(root, '_astro');
        const files = await readdir(assets);
        const mapChunk = files.find((f) => /^map\.[\w-]+\.js$/.test(f));
        if (!mapChunk) throw new Error('module-preload: no map chunk in dist/_astro');
        // Static imports only: `import("./x.js")` is left to load when asked for.
        /** @type {Map<string, string[]>} */
        const deps = new Map();
        /** @param {string} file @returns {Promise<string[]>} */
        const depsOf = async (file) => {
          if (!deps.has(file)) {
            const code = await readFile(join(assets, file), 'utf8');
            deps.set(file, [...code.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)].map((m) => m[1]));
          }
          return deps.get(file) ?? [];
        };
        let n = 0;
        for (const file of await readdir(root, { recursive: true })) {
          if (!file.endsWith('.html')) continue;
          const html = await readFile(join(root, file), 'utf8');
          const entries = [...html.matchAll(/<script type="module" src="\/_astro\/([^"]+\.js)"/g)].map((m) => m[1]);
          const seen = new Set(entries), queue = [...entries];
          while (queue.length) for (const d of await depsOf(/** @type {string} */ (queue.shift()))) if (!seen.has(d)) { seen.add(d); queue.push(d); }
          const preload = [...seen].filter((f) => !entries.includes(f));
          if (html.includes('id="map"') && !preload.includes(mapChunk)) preload.push(mapChunk);
          if (!preload.length) continue;
          const tags = preload.map((f) => `<link rel="modulepreload" href="/_astro/${f}">`).join('');
          await writeFile(join(root, file), html.replace('</head>', `${tags}</head>`));
          n++;
        }
        logger.info(`modulepreload links on ${n} pages (map chunk ${mapChunk})`);
      },
    },
  };
}

// https://astro.build/config
export default defineConfig({
  site: 'https://swell.fyi',
  server: { port: 4747 },
  integrations: [modulePreload()],
  vite: {
    // MapLibre's worker is bundled via `?worker&url` (see src/lib/map.ts) as an ES module worker.
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['maplibre-gl'] },
    // The map chunk is ~280 KB gzipped by design (MapLibre), and loads on its own.
    build: { chunkSizeWarningLimit: 1200 },
  },
});
