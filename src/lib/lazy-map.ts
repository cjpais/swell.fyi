// MapLibre is most of a page's JS (~280 KB gzipped), so pages load the map module on its own and
// draw their numbers without waiting for it. The build (astro.config.mjs) adds a modulepreload
// for it to every page with a map, so its download starts alongside the page's own scripts.
import type { OverlayState } from "./map";

export type MapModule = typeof import("./map");
export const loadMap = (): Promise<MapModule> => import("./map");

/**
 * A map with the swell/wind overlay at `lngLat`, built by `build` once MapLibre is in. `update`
 * can be called before then: the latest state is drawn as soon as the overlay exists.
 */
export function lazyOverlay(lngLat: [number, number], build: (m: MapModule) => ReturnType<MapModule["createMap"]>) {
  let overlay: ReturnType<MapModule["conditionOverlay"]> | null = null;
  let last: OverlayState | null = null;
  loadMap()
    .then((m) => {
      overlay = m.conditionOverlay(build(m), lngLat);
      if (last) overlay.update(last);
    })
    .catch((e) => console.error("Map failed to load:", e));
  return {
    update(s: OverlayState) {
      last = s;
      overlay?.update(s);
    },
  };
}
