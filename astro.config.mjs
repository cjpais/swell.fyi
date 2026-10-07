// @ts-check
import { defineConfig } from 'astro/config';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pages load the map module with import() (src/lib/lazy-map.ts), so their numbers don't wait on
 * MapLibre. That alone would only start its download once the page's own script has run; this
 * adds a modulepreload for it to every page with a map, so it downloads alongside.
 * @returns {import('astro').AstroIntegration}
 */
function preloadMap() {
  return {
    name: 'preload-map',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const chunk = (await readdir(join(root, '_astro'))).find((f) => /^map\.[\w-]+\.js$/.test(f));
        if (!chunk) throw new Error('preload-map: no map chunk in dist/_astro');
        const tag = `<link rel="modulepreload" href="/_astro/${chunk}">`;
        let n = 0;
        for (const file of await readdir(root, { recursive: true })) {
          if (!file.endsWith('.html')) continue;
          const html = await readFile(join(root, file), 'utf8');
          if (!html.includes('id="map"')) continue;
          await writeFile(join(root, file), html.replace('</head>', `${tag}</head>`));
          n++;
        }
        logger.info(`modulepreload ${chunk} on ${n} pages`);
      },
    },
  };
}

// https://astro.build/config
export default defineConfig({
  site: 'https://swell.fyi',
  server: { port: 4747 },
  integrations: [preloadMap()],
  vite: {
    // MapLibre's worker is bundled via `?worker&url` (see src/lib/map.ts) as an ES module worker.
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['maplibre-gl'] },
    // The map chunk is ~280 KB gzipped by design (MapLibre), and loads on its own.
    build: { chunkSizeWarningLimit: 1200 },
  },
});
