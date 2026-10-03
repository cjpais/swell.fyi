// The long-term observation archive: one CSV per station in data/archive/cwa-obs/,
// hourly rows keyed by time, with a `source` column recording where each row came from.
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");
/** Local snapshot of the live CWA files, laid out as the Worker serves them under /cwa/. */
export const PUBLIC_DATA = join(ROOT, "public", "data", "cwa");
export const ARCHIVE = join(ROOT, "data", "archive");
export const OBS_ARCHIVE = join(ARCHIVE, "cwa-obs");

// Column list, row types and parsing helpers are shared with the Worker (scripts/lib/cwa.ts).
export { OBS_COLUMNS, SOURCE_OPEN_DATA, SOURCE_OCEAN_PORTAL, num, arr, type ObsRow, type ArchiveRow } from "./cwa";
import { OBS_COLUMNS, SOURCE_OPEN_DATA, num, type ObsRow, type ArchiveRow } from "./cwa";

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (header: readonly string[], rows: unknown[][]) =>
  [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";

export function parseCsv(text: string): string[][] {
  // Our own CSVs: no quoted newlines, so line-splitting is safe.
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const out: string[] = [];
      let cur = "", q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') q = false;
          else cur += c;
        } else if (c === '"') q = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
      out.push(cur);
      return out;
    });
}

export async function readArchive(id: string): Promise<Map<string, ArchiveRow>> {
  const file = join(OBS_ARCHIVE, `${id}.csv`);
  const byTime = new Map<string, ArchiveRow>();
  if (!existsSync(file)) return byTime;
  const [header, ...rows] = parseCsv(await readFile(file, "utf8"));
  const hasSource = header.includes("source");
  const n = OBS_COLUMNS.length - 1;
  for (const r of rows) {
    const values = r.slice(0, n).map((v, i) => (i === 0 ? v : num(v)));
    byTime.set(r[0], [...values, hasSource ? r[n] || SOURCE_OPEN_DATA : SOURCE_OPEN_DATA]);
  }
  return byTime;
}

/**
 * Merge rows into a station's archive.
 * - "prefer-new" (official open data): new values win, but never replace a value with a gap.
 * - "fill-gaps" (unofficial backfill): existing values win; only empty fields/hours get filled.
 */
export async function mergeIntoArchive(id: string, fresh: ObsRow[], source: string, mode: "prefer-new" | "fill-gaps") {
  const byTime = await readArchive(id);
  let added = 0;
  for (const r of fresh) {
    const t = String(r[0]);
    const prev = byTime.get(t);
    if (!prev) {
      byTime.set(t, [...r, source]);
      added++;
      continue;
    }
    const prevVals = prev.slice(0, -1);
    const merged = mode === "prefer-new" ? r.map((v, i) => v ?? prevVals[i]) : prevVals.map((v, i) => v ?? r[i]);
    const src = mode === "prefer-new" ? source : (prev[prev.length - 1] as string);
    byTime.set(t, [...merged, src]);
  }
  const rows = [...byTime.values()].sort((a, b) => Date.parse(String(a[0])) - Date.parse(String(b[0])));
  await writeFile(join(OBS_ARCHIVE, `${id}.csv`), toCsv(OBS_COLUMNS, rows));
  return { rows, added };
}
