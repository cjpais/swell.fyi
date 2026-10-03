#!/usr/bin/env bun
// Fetch CWA (Central Weather Administration, Taiwan) marine open data, append observations
// to the long-term CSV archive, and write the site's JSON into public/data/cwa/.
//
//   bun run fetch               latest 48h buoy/tide obs + forecasts
//   bun run fetch --backfill    also pull the 30-day obs file (O-B0075-002, ~42 MB)
//
// In production the swell-data Worker (workers/data) keeps the live JSON fresh on its own.
// This script's job there is the archive: CWA's real-time obs only cover 48h (30 days via
// -002), so CI runs it on a schedule to build an unbroken history in data/archive/, then
// scripts/publish-archive.sh uploads the CSVs and the 120-day windows to R2.
// Locally, public/data/ is a full snapshot the dev server can read (PUBLIC_DATA_BASE=/data).
//
// With CWA_API_KEY set, requests go through the official file API, which redirects to the
// same public S3 objects; without one, the S3 objects are read directly.

import { mkdir, readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SPOTS } from "../src/data/spots";
import { PUBLIC_DATA, ARCHIVE, OBS_ARCHIVE, SOURCE_OPEN_DATA, toCsv, parseCsv, mergeIntoArchive } from "./lib/archive";
import {
  SOURCES, OBS_WINDOW_DAYS, download, downloadJson, parseStations, parseObsZip, parseRecreation, parseTides,
  latestOf, withLatest, obsFile, recentHs, spotTides, spotForecast, type ArchiveIndex, type ArchiveRow, type Latest,
} from "./lib/cwa";

const FC_ARCHIVE = join(ARCHIVE, "cwa-recreation-forecast");
const KEY = process.env.CWA_API_KEY || undefined;
const via = KEY ? "(official file API)" : "(public S3)";

async function main() {
  const backfill = process.argv.includes("--backfill");
  for (const d of [PUBLIC_DATA, join(PUBLIC_DATA, "obs"), join(PUBLIC_DATA, "csv"), OBS_ARCHIVE, FC_ARCHIVE]) {
    await mkdir(d, { recursive: true });
  }
  const write = (name: string, v: unknown, pretty = false) => writeFile(join(PUBLIC_DATA, name), JSON.stringify(v, null, pretty ? 2 : undefined));
  const meta = { fetchedAt: new Date().toISOString(), via: KEY ? "opendata.cwa.gov.tw file API" : "CWA public S3 bucket", builder: "fetch-cwa", datasets: {} as Record<string, unknown> };
  const ds = meta.datasets;

  // Stations
  console.log(`↓ ${SOURCES.stations.id}  ${via}`);
  const { stations, updated } = parseStations(await downloadJson(SOURCES.stations, KEY));
  ds[SOURCES.stations.id] = { name: SOURCES.stations.name, updated };

  // Observations → archive, then the live 120-day windows from the archive.
  console.log(`↓ ${SOURCES.obs48h.id}  ${via}`);
  const obs = parseObsZip(await download(SOURCES.obs48h, KEY));
  ds[SOURCES.obs48h.id] = { name: SOURCES.obs48h.name };
  if (backfill) {
    console.log(`↓ ${SOURCES.obs30d.id}  ${via}`);
    const obs30 = parseObsZip(await download(SOURCES.obs30d, KEY));
    for (const [id, rows] of obs30) obs.set(id, [...rows, ...(obs.get(id) ?? [])]);
    ds[SOURCES.obs30d.id] = { name: SOURCES.obs30d.name };
  }

  const latest: Record<string, Latest | null> = {};
  const windows: Record<string, ArchiveRow[]> = {};
  const index: ArchiveIndex = { updatedAt: new Date().toISOString(), stations: {} };
  const cutoff = Date.now() - OBS_WINDOW_DAYS * 86400e3;
  let totalAdded = 0;
  for (const [id, rows] of obs) {
    const { rows: all, added } = await mergeIntoArchive(id, rows, SOURCE_OPEN_DATA, "prefer-new");
    totalAdded += added;
    windows[id] = all.filter((r) => Date.parse(String(r[0])) >= cutoff);
    await write(join("obs", `${id}.json`), obsFile(id, windows[id]));
    await copyFile(join(OBS_ARCHIVE, `${id}.csv`), join(PUBLIC_DATA, "csv", `${id}.csv`));
    if (all.length) index.stations[id] = { start: String(all[0][0]), end: String(all[all.length - 1][0]), rows: all.length };
    latest[id] = latestOf(all);
  }
  await write("stations.json", withLatest(stations, latest));
  await write("recent-hs.json", recentHs(windows));
  await write("archive-index.json", index);
  console.log(`  ${obs.size} stations, ${totalAdded} new hourly rows archived`);

  // Recreation sea forecast (incl. the surf points)
  console.log(`↓ ${SOURCES.recreation.id}  ${via}`);
  const rec = parseRecreation(await downloadJson(SOURCES.recreation, KEY));
  await write("recreation.json", rec);
  await write("spot-forecast.json", spotForecast(rec));
  ds[SOURCES.recreation.id] = { name: SOURCES.recreation.name, issued: rec.issued };
  // Archive every issue for the spot points so we can score CWA's forecast against buoys later.
  for (const code of new Set(SPOTS.map((s) => s.cwaPoint))) {
    const p = rec.points[code];
    if (!p) continue;
    const file = join(FC_ARCHIVE, `${code}.csv`);
    const header = ["issued", "time", "lead_h", "wave_height_m", "wave_dir_deg", "wave_period_s", "current_dir_deg", "current_speed_ms"];
    const existing = existsSync(file) ? parseCsv(await readFile(file, "utf8")).slice(1) : [];
    if (existing.some((r) => r[0] === rec.issued)) continue;
    const rows = [
      ...existing,
      ...p.rows.map((r) => [rec.issued, r[0], Math.round((Date.parse(String(r[0])) - Date.parse(rec.issued)) / 36e5), ...r.slice(1)]),
    ];
    await writeFile(file, toCsv(header, rows));
  }
  console.log(`  recreation forecast issued ${rec.issued}, ${Object.keys(rec.points).length} points`);

  // Tide forecast (high/low times, 1 month)
  console.log(`↓ ${SOURCES.tides.id}  ${via}`);
  const { tides, sent } = parseTides(await downloadJson(SOURCES.tides, KEY));
  await write("tides.json", tides);
  await write("spot-tides.json", spotTides(tides.locations));
  ds[SOURCES.tides.id] = { name: SOURCES.tides.name, sent };
  console.log(`  tides: ${tides.locations.length} locations`);

  await write("meta.json", meta, true);
  const archived = (await readdir(OBS_ARCHIVE)).length;
  console.log(`✓ done. Archive: ${archived} station CSVs in data/archive/cwa-obs/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
