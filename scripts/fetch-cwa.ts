#!/usr/bin/env bun
// Fetch CWA (Central Weather Administration, Taiwan) marine open data, convert it to
// compact JSON for the site, and append observations to a long-term CSV archive.
//
//   bun run fetch               latest 48h buoy/tide obs + forecasts
//   bun run fetch --backfill    also pull the 30-day obs file (O-B0075-002, ~42 MB)
//
// CWA's real-time obs only cover 48h (30 days via -002), so run this at least daily
// (ideally every few hours) to build an unbroken history in data/archive/.
//
// With CWA_API_KEY set, requests go through the official file API
// (opendata.cwa.gov.tw/fileapi), which redirects to the same public S3 objects.
// Without a key we read the S3 objects directly: unauthenticated, but undocumented.

import { mkdir, readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { SPOTS } from "../src/data/spots";
import { PUBLIC_DATA, ARCHIVE, OBS_ARCHIVE, OBS_COLUMNS, SOURCE_OPEN_DATA, num, arr, toCsv, parseCsv, mergeIntoArchive, type ObsRow } from "./lib/archive";

const FC_ARCHIVE = join(ARCHIVE, "cwa-recreation-forecast");

const S3 = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com";
const KEY = process.env.CWA_API_KEY;

type Source = { id: string; s3Path: string; format: "JSON" | "ZIP" };
const SOURCES = {
  obs48h: { id: "O-B0075-001", s3Path: "Observation/O-B0075-001.zip", format: "ZIP" },
  obs30d: { id: "O-B0075-002", s3Path: "Observation/O-B0075-002.zip", format: "ZIP" },
  stations: { id: "O-B0076-001", s3Path: "Observation/O-B0076-001.json", format: "JSON" },
  recreation: { id: "M-B0078-001", s3Path: "Model/M-B0078-001.json", format: "JSON" },
  tides: { id: "F-A0021-001", s3Path: "Forecast/F-A0021-001.json", format: "JSON" },
} satisfies Record<string, Source>;

function urlFor(src: Source) {
  return KEY
    ? `https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/${src.id}?Authorization=${KEY}&downloadType=WEB&format=${src.format}`
    : `${S3}/${src.s3Path}`;
}

async function download(src: Source): Promise<Uint8Array> {
  const url = urlFor(src);
  console.log(`↓ ${src.id}  ${KEY ? "(official file API)" : "(public S3)"}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${src.id}: HTTP ${res.status} from ${url.replace(KEY ?? "\0", "***")}`);
  return new Uint8Array(await res.arrayBuffer());
}

const downloadJson = async (src: Source) => JSON.parse(strFromU8(await download(src)));

// ---------- observations (O-B0075-001 / -002) ----------

const xml = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (name) => name === "StationObsTime" || name === "Layer",
});

function parseObsZip(buf: Uint8Array): Map<string, ObsRow[]> {
  const files = unzipSync(buf);
  const out = new Map<string, ObsRow[]>();
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith(".xml")) continue;
    const doc = xml.parse(strFromU8(data));
    const loc = doc?.cwaopendata?.Resources?.Resource?.Data?.SeaSurfaceObs?.Location;
    const id: string | undefined = loc?.Station?.StationID;
    if (!id) continue;
    const times = loc?.StationObsTimes?.StationObsTime ?? [];
    const rows: ObsRow[] = times.map((t: any) => {
      const w = t.WeatherElements ?? {};
      const a = w.PrimaryAnemometer ?? {};
      const cur = w.SeaCurrents?.Layer?.[0] ?? {};
      return [
        t.DataTime,
        num(w.WaveHeight),
        num(w.WaveDirection),
        num(w.WavePeriod),
        num(w.SeaTemperature),
        num(w.Temperature),
        num(w.StationPressure),
        num(a.WindSpeed),
        num(a.WindDirection),
        num(a.MaximumWindSpeed),
        num(w.TideHeight),
        num(cur.CurrentDirection),
        num(cur.CurrentSpeed),
      ];
    });
    out.set(id, rows);
  }
  return out;
}

// CWA's English names, where they're garbled or misleading.
const NAME_FIXES: Record<string, string> = {
  OAC005: "Honeymoon Bay Buoy",
  OAC003: "Bitou Cape Buoy",
  "46761F": "Chenggong Buoy",
  A6S01: "Green Island Gongguan Buoy",
  "1596": "Dawu",
  C4B03: "Changtanli",
};

// ---------- main ----------

async function main() {
  const backfill = process.argv.includes("--backfill");
  for (const d of [PUBLIC_DATA, join(PUBLIC_DATA, "obs"), join(PUBLIC_DATA, "csv"), OBS_ARCHIVE, FC_ARCHIVE]) {
    await mkdir(d, { recursive: true });
  }
  const fetchedAt = new Date().toISOString();
  const meta: Record<string, unknown> = { fetchedAt, via: KEY ? "opendata.cwa.gov.tw file API" : "CWA public S3 bucket", datasets: {} };
  const datasets = meta.datasets as Record<string, unknown>;

  // Stations
  const stDoc = await downloadJson(SOURCES.stations);
  const stLocs = arr<any>(stDoc.cwaopendata.Resources.Resource.Data.SeaSurfaceObs.Location);
  const stations = stLocs.map((l) => {
    const s = l.Station;
    return {
      id: s.StationID,
      name: s.StationName,
      nameEn: NAME_FIXES[s.StationID] ?? String(s.StationNameEN ?? "").replace(/\s+/g, " ").trim(),
      lat: Number(s.StationLatitude),
      lon: Number(s.StationLongitude),
      type: s.StationAttribute,
      typeEn: s.StationAttributeEN,
      county: s.County?.CountyNameEN ?? "",
      countyZh: s.County?.CountyName ?? "",
      area: s.Area?.AreaNameEN ?? "",
      address: s.StationAddressEN ?? s.StationAddress ?? "",
      owner: s.StationChargeInsEN ?? s.StationChargeIns ?? "",
      active: l.StationObsStatus?.StationStatus === "1",
      observes: String(l.StationObsStatus?.ObservedPropertyNames ?? "").split(",").filter(Boolean),
    };
  });
  datasets[SOURCES.stations.id] = { name: "Marine station metadata", updated: stDoc.cwaopendata.Resources.Resource.Metadata.Temporal?.Update };

  // Observations
  const obs = parseObsZip(await download(SOURCES.obs48h));
  datasets[SOURCES.obs48h.id] = { name: "Marine observations, past 48h (hourly)" };
  if (backfill) {
    const obs30 = parseObsZip(await download(SOURCES.obs30d));
    for (const [id, rows] of obs30) obs.set(id, [...rows, ...(obs.get(id) ?? [])]);
    datasets[SOURCES.obs30d.id] = { name: "Marine observations, past 30 days (hourly)" };
  }

  const latest: Record<string, unknown> = {};
  const KEEP_DAYS = 120;
  const cutoff = Date.now() - KEEP_DAYS * 86400e3;
  let totalAdded = 0;
  for (const [id, rows] of obs) {
    const { rows: all, added } = await mergeIntoArchive(id, rows, SOURCE_OPEN_DATA, "prefer-new");
    totalAdded += added;
    const recent = all.filter((r) => Date.parse(String(r[0])) >= cutoff);
    await writeFile(join(PUBLIC_DATA, "obs", `${id}.json`), JSON.stringify({ id, columns: OBS_COLUMNS, rows: recent }));
    await copyFile(join(OBS_ARCHIVE, `${id}.csv`), join(PUBLIC_DATA, "csv", `${id}.csv`));
    // Latest row with any wave reading, else latest row at all.
    const last = [...all].reverse().find((r) => r[1] !== null) ?? all[all.length - 1];
    if (last) latest[id] = { time: last[0], values: Object.fromEntries(OBS_COLUMNS.slice(1, -1).map((c, i) => [c, last[i + 1]])), archiveStart: all[0]?.[0], archiveRows: all.length };
  }
  await writeFile(join(PUBLIC_DATA, "stations.json"), JSON.stringify(stations.map((s) => ({ ...s, latest: latest[s.id] ?? null }))));
  console.log(`  ${obs.size} stations, ${totalAdded} new hourly rows archived`);

  // Recreation sea forecast (incl. 13 surf points)
  const rec = await downloadJson(SOURCES.recreation);
  const ds = rec.cwaopendata.dataset;
  const issued: string = ds.datasetInfo.IssueTime;
  const points: Record<string, { name: string; lat: number; lon: number; rows: unknown[][] }> = {};
  for (const l of arr<any>(ds.location)) {
    const p = (points[l.LocationCode] ??= { name: l.LocationName, lat: Number(l.Latitude), lon: Number(l.Longitude), rows: [] });
    p.rows.push([l.DateTime, num(l.SignificantWaveHeight), dirFromText(l.WaveDirectionForecast), num(l.WavePeriod), dirFromText(l.OceanCurrentDirectionForecast), num(l.OceanCurrentSpeed)]);
  }
  await writeFile(
    join(PUBLIC_DATA, "cwa-recreation.json"),
    JSON.stringify({ issued, columns: ["time", "wave_height_m", "wave_dir_deg", "wave_period_s", "current_dir_deg", "current_speed_ms"], points }),
  );
  datasets[SOURCES.recreation.id] = { name: "Recreation sea forecast (WW3-based), 3-hourly, 72h", issued };
  // Archive every issue for the spot points so we can score CWA's forecast against buoys later.
  const spotCodes = new Set(SPOTS.map((s) => s.cwaPoint));
  for (const code of spotCodes) {
    const p = points[code];
    if (!p) continue;
    const file = join(FC_ARCHIVE, `${code}.csv`);
    const header = ["issued", "time", "lead_h", "wave_height_m", "wave_dir_deg", "wave_period_s", "current_dir_deg", "current_speed_ms"];
    const existing = existsSync(file) ? parseCsv(await readFile(file, "utf8")).slice(1) : [];
    if (existing.some((r) => r[0] === issued)) continue;
    const rows = [
      ...existing,
      ...p.rows.map((r) => [issued, r[0], Math.round((Date.parse(String(r[0])) - Date.parse(issued)) / 36e5), ...r.slice(1)]),
    ];
    await writeFile(file, toCsv(header, rows));
  }
  console.log(`  recreation forecast issued ${issued}, ${Object.keys(points).length} points`);

  // Tide forecast (high/low times, 1 month)
  const tideDoc = await downloadJson(SOURCES.tides);
  const tides = arr<any>(tideDoc.cwaopendata.Resources.Resource.Data.TideForecasts).map((t) => {
    const l = t.Location;
    const events: unknown[][] = [];
    for (const d of arr(l.TimePeriods?.Daily)) {
      for (const e of arr(d.Time)) {
        events.push([e.DateTime, e.Tide === "滿潮" ? "high" : "low", num(e.TideHeights?.AboveLocalMSL)]);
      }
    }
    return { id: l.LocationId, name: l.LocationName, lat: Number(l.Latitude), lon: Number(l.Longitude), events };
  });
  await writeFile(join(PUBLIC_DATA, "tides.json"), JSON.stringify({ unit: "cm above local MSL", locations: tides }));
  datasets[SOURCES.tides.id] = { name: "Tide forecast, high/low times, 1 month", sent: tideDoc.cwaopendata.Sent };
  console.log(`  tides: ${tides.length} locations`);

  await writeFile(join(PUBLIC_DATA, "meta.json"), JSON.stringify(meta, null, 2));
  const archived = (await readdir(OBS_ARCHIVE)).length;
  console.log(`✓ done. Archive: ${archived} station CSVs in data/archive/cwa-obs/`);
}

// CWA gives forecast directions as 16-point text like "東北東(ENE)". Convert to degrees ("from").
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
function dirFromText(s: unknown): number | null {
  const m = /\(([A-Za-z]+)\)/.exec(String(s ?? ""));
  if (!m) return null;
  const i = COMPASS.indexOf(m[1].toUpperCase());
  return i < 0 ? null : i * 22.5;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
