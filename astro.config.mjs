// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://swell.fyi',
  server: { port: 4747 },
  vite: {
    // MapLibre's worker is bundled via `?worker&url` (see src/lib/map.ts) as an ES module worker.
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['maplibre-gl'] },
  },
});
