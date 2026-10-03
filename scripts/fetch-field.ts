#!/usr/bin/env bun
// Build the explore map's field.json locally, into public/data/field.json.
//
//   bun run fetch:field
//
// In production the swell-data Worker (workers/data) builds the same file on a cron and
// serves it at https://data.swell.fyi/field.json; this script is for offline work. To make
// the dev server read the local copy: PUBLIC_DATA_BASE=/data bun run dev
// The build itself lives in scripts/lib/field.ts, shared with the Worker.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildField, latestRuns } from "./lib/field";

const OUT = join(process.cwd(), "public", "data", "field.json");
const key = process.env.OPEN_METEO_API_KEY || undefined;

const runs = await latestRuns(key).catch(() => null);
const field = await buildField({ key, runs, log: console.log });
await mkdir(join(process.cwd(), "public", "data"), { recursive: true });
const body = JSON.stringify(field);
await writeFile(OUT, body);
console.log(`✓ ${OUT} (${(body.length / 1024).toFixed(0)} KB)`);
