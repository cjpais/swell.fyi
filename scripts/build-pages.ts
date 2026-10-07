#!/usr/bin/env bun
// Cut each page's live data out of the local snapshot, into public/data/pages/.
//
//   bun run fetch:pages
//
// In production the swell-data Worker (workers/data) builds the same files whenever one of their
// sources changes; this is for offline work (PUBLIC_DATA_BASE=/data), after `bun run fetch`,
// `fetch:field` and `fetch:wrf`. The cut itself lives in scripts/lib/pages.ts, shared with the Worker.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SPOTS } from "../src/data/spots";
import { buoyPage, homePage, spotPage, workingBuoy, type PageSources } from "./lib/pages";

const DATA = join(process.cwd(), "public", "data");
const OUT = join(DATA, "pages");
const read = (path: string) => readFile(join(DATA, path), "utf8").then(JSON.parse).catch(() => null);

const src: PageSources = {
  field: await read("field.json"),
  stations: (await read("cwa/stations.json")) ?? [],
  forecast: await read("cwa/spot-forecast.json"),
  tides: await read("cwa/spot-tides.json"),
  recentHs: await read("cwa/recent-hs.json"),
  wrf: await read("cwa/wrf-wind.json"),
  buoyModels: await read("buoy-models.json"),
  buoysUpdated: (await read("cwa/meta.json"))?.fetchedAt ?? null,
};
await mkdir(join(OUT, "spots"), { recursive: true });
await mkdir(join(OUT, "buoys"), { recursive: true });
for (const spot of SPOTS) {
  const buoy = workingBuoy(spot, src.stations);
  await writeFile(join(OUT, "spots", `${spot.id}.json`), JSON.stringify(spotPage(spot, src, buoy ? await read(`cwa/obs/${buoy.id}.json`) : null)));
}
for (const { id } of src.stations) await writeFile(join(OUT, "buoys", `${id}.json`), JSON.stringify(buoyPage(id, src, await read(`cwa/obs/${id}.json`))));
await writeFile(join(OUT, "home.json"), JSON.stringify(homePage(src)));
console.log(`✓ ${OUT} (home, ${SPOTS.length} spots, ${src.stations.length} stations)`);
