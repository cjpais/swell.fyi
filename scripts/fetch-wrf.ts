#!/usr/bin/env bun
// Build CWA's WRF spot winds locally, into public/data/cwa/wrf-wind.json.
//
//   bun run fetch:wrf
//
// In production the swell-data Worker (workers/data) builds the same file when a new run lands
// and serves it at https://data.swell.fyi/cwa/wrf-wind.json; this script is for offline work.
// The build itself lives in scripts/lib/wrf.ts, shared with the Worker.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildWrf } from "./lib/wrf";

const DIR = join(process.cwd(), "public", "data", "cwa");
const OUT = join(DIR, "wrf-wind.json");

const prev = await readFile(OUT, "utf8").then(JSON.parse).catch(() => null);
const { file, errors } = await buildWrf(prev, { log: console.log });
errors.forEach((e) => console.error(`✗ ${e}`));
await mkdir(DIR, { recursive: true });
const body = JSON.stringify(file);
await writeFile(OUT, body);
console.log(`✓ ${OUT} (${(body.length / 1024).toFixed(0)} KB)`);
if (errors.length) process.exitCode = 1;
