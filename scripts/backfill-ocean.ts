#!/usr/bin/env bun
// Backfill buoy history (~2 years) from CWA's ocean portal, ocean.cwa.gov.tw.
//
//   bun run backfill:history            all wave buoys
//   bun run backfill:history 46699A     one station
//
// This is an UNDOCUMENTED endpoint behind the portal's map, not the open-data API.
// It can change or disappear, and its values look QC-filtered, so it fills gaps only:
// official O-B0075 rows always win, and backfilled rows are tagged
// source=ocean.cwa.gov.tw in the archive CSV.
// One request covers a year per station and can take 30-60 s; be patient and polite.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PUBLIC_DATA, SOURCE_OCEAN_PORTAL, SOURCE_OPEN_DATA, num, mergeIntoArchive, readArchive, type ObsRow } from "./lib/archive";

const ENDPOINT = "https://ocean.cwa.gov.tw/V2/map_common/get_station_info";
const YEAR_H = 8760;
const MAX_YEARS = 4;
const CONCURRENCY = 3;

type Station = { id: string; type: string; observes: string[]; latest: { values: Record<string, number | null> } | null };

// The portal returns Taiwan local time without an offset.
const tw = (s: string) => `${s.replace(" ", "T").slice(0, 19)}+08:00`;
const fmtLocal = (d: Date) => new Date(d.getTime() + 8 * 36e5).toISOString().slice(0, 13).replace("T", " ") + ":00:00";

async function fetchYear(id: string, end: Date, retrySparse: boolean): Promise<ObsRow[]> {
  const body = new URLSearchParams({ end_time: fmtLocal(end), station_id: id, kind: "buoy", time_range: String(YEAR_H) });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        body,
        headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      const byTime = new Map<string, ObsRow>();
      const row = (t: string) => {
        const k = tw(t);
        let r = byTime.get(k);
        if (!r) byTime.set(k, (r = [k, null, null, null, null, null, null, null, null, null, null, null, null]));
        return r;
      };
      for (const c of d.chart_data ?? []) {
        const r = row(c.datetime);
        r[1] = num(c.wh);
        r[2] = num(c.wdir);
        r[3] = num(c.wp);
        r[7] = num(c.swind);
        r[8] = num(c.dwind);
      }
      for (const c of d.sea_temp?.chart_data ?? []) row(c.dtime)[4] = num(c.ST);
      for (const c of d.flow_speed?.chart_data ?? []) {
        const r = row(c.dtime);
        r[11] = num(c.DCURR);
        r[12] = num(c.SCURR);
      }
      const rows = [...byTime.values()]
        .filter((r) => r.slice(1).some((v) => v != null))
        .sort((a, b) => Date.parse(String(a[0])) - Date.parse(String(b[0])));
      // The portal sometimes answers with a mostly-null year that comes back full on retry.
      const waveHours = rows.filter((r) => r[1] != null).length;
      if (retrySparse && attempt < 3 && rows.length > 2000 && waveHours < rows.length * 0.2) throw new Error(`sparse response (${waveHours}/${rows.length} wave hours)`);
      return rows;
    } catch (e) {
      if (attempt >= 3) throw e;
      await Bun.sleep(5000 * attempt);
      console.warn(`  ${id}: ${(e as Error).message}, retrying`);
    }
  }
}

async function backfill(id: string) {
  const existing = await readArchive(id);
  let end = new Date();
  let total = 0;
  for (let y = 0; y < MAX_YEARS; y++) {
    const rows = await fetchYear(id, end, y === 0);
    const withWaves = rows.filter((r) => r[1] != null);
    if (!withWaves.length) break;

    // Sanity check against official data where both exist (catches time-zone or unit mix-ups).
    let both = 0, same = 0;
    for (const r of withWaves) {
      const prev = existing.get(String(r[0]));
      const o = prev?.[prev.length - 1] === SOURCE_OPEN_DATA ? prev[1] : null;
      if (o != null) { both++; if (Math.abs((o as number) - (r[1] as number)) < 0.051) same++; }
    }
    const { added } = await mergeIntoArchive(id, rows, SOURCE_OCEAN_PORTAL, "fill-gaps");
    total += added;
    console.log(
      `  ${id}: ${String(rows[0][0]).slice(0, 10)} → ${String(rows[rows.length - 1][0]).slice(0, 10)}, ${withWaves.length} wave hours, ${added} new` +
        (both ? `, matches official data in ${same}/${both} overlapping hours` : ""),
    );
    // Older years thin out fast; stop once a year is mostly empty.
    if (withWaves.length < 1000) break;
    end = new Date(end.getTime() - YEAR_H * 36e5);
  }
  return total;
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const stations: Station[] = JSON.parse(await readFile(join(PUBLIC_DATA, "stations.json"), "utf8"));
  const ids = only.length
    ? only
    : stations.filter((s) => s.type.includes("浮")).filter((s) => s.observes.includes("WaveHeight") || s.latest?.values.wave_height_m != null).map((s) => s.id);
  console.log(`Backfilling ${ids.length} stations from ${ENDPOINT}`);
  const queue = [...ids];
  let grand = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let id; (id = queue.shift()); ) {
        try {
          grand += await backfill(id);
        } catch (e) {
          console.warn(`  ${id}: failed (${(e as Error).message})`);
        }
      }
    }),
  );
  console.log(`✓ ${grand} hourly rows added. Run \`bun run fetch\` to republish the site data.`);
}

main();
