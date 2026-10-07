#!/usr/bin/env bun
// Build the explore map's field.json locally, into public/data/field.json, and the same models at
// each wave buoy into public/data/buoy-models.json (needs public/data/cwa/stations.json).
//
//   bun run fetch:field
//
// In production the swell-data Worker (workers/data) builds the same file on a cron and
// serves it at https://data.swell.fyi/field.json; this script is for offline work. To make
// the dev server read the local copy: PUBLIC_DATA_BASE=/data bun run dev
// The build itself lives in scripts/lib/field.ts, shared with the Worker.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildBuoyModels, buildField, latestRuns } from "./lib/field";
import { isWaveStation } from "./lib/pages";

const DIR = join(process.cwd(), "public", "data");
const OUT = join(DIR, "field.json");
const key = process.env.OPEN_METEO_API_KEY || undefined;

const runs = await latestRuns(key).catch(() => null);
const field = await buildField({ key, runs, log: console.log });
await mkdir(DIR, { recursive: true });
const body = JSON.stringify(field);
await writeFile(OUT, body);
console.log(`✓ ${OUT} (${(body.length / 1024).toFixed(0)} KB)`);

const stations = await readFile(join(DIR, "cwa", "stations.json"), "utf8").then(JSON.parse).catch(() => null);
if (!stations) console.log("No public/data/cwa/stations.json (run bun run fetch first): skipping buoy-models.json");
else {
  const buoys = await buildBuoyModels(stations.filter(isWaveStation), { key, runs, log: console.log });
  const out = join(DIR, "buoy-models.json"), b = JSON.stringify(buoys);
  await writeFile(out, b);
  console.log(`✓ ${out} (${(b.length / 1024).toFixed(0)} KB)`);
}
