// spots/*.md → src/data/spots.json, which the site, the scripts and the swell-data Worker all read
// (through src/data/spots.ts). The Markdown is the only place to edit a spot; this checks every
// file and stops with the file and the problem if anything is off. `bun run build` and
// `bun run deploy:data` run it first; run it yourself (`bun run spots`) after editing a spot.
//
// Front matter: name, nameZh, region, location [lat, lon], faces (degrees), swell.best and
// swell.works ([from, to], clockwise, degrees the swell comes from), cwaPoint, buoys, and
// optionally model [lat, lon]. The file name is the spot's id. The body is written prose, shown
// on the spot page; it isn't read here.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REGIONS } from "../src/data/regions";

const DIR = join(import.meta.dir, "../spots");
const OUT = join(import.meta.dir, "../src/data/spots.json");
/** How far out from the break to read the wave models, along the way it faces. */
const MODEL_KM = 5;

type Range = [number, number];
const problems: string[] = [];
const bad = (file: string, msg: string) => problems.push(`spots/${file}: ${msg}`);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBearing = (v: unknown): v is number => isNum(v) && v >= 0 && v < 360;
const isRange = (v: unknown): v is Range => Array.isArray(v) && v.length === 2 && v.every(isBearing);
/** Is bearing d inside the clockwise range [a, b]? (Same test as src/lib/surf.ts.) */
const within = (d: number, [a, b]: Range) => (d - a + 360) % 360 <= (b - a + 360) % 360;

function modelPoint(lat: number, lon: number, faces: number): [number, number] {
  const a = (faces * Math.PI) / 180;
  return [
    Math.round((lat + (MODEL_KM * Math.cos(a)) / 111.32) * 1000) / 1000,
    Math.round((lon + (MODEL_KM * Math.sin(a)) / (111.32 * Math.cos((lat * Math.PI) / 180))) * 1000) / 1000,
  ];
}

const files = (await readdir(DIR)).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
const spots = [];
for (const file of files) {
  const id = file.replace(/\.md$/, "");
  const text = await readFile(join(DIR, file), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) { bad(file, "no front matter (--- ... ---) at the top"); continue; }
  let f: Record<string, unknown>;
  try { f = Bun.YAML.parse(m[1]) as Record<string, unknown>; }
  catch (e) { bad(file, `front matter isn't valid YAML: ${(e as Error).message}`); continue; }
  const n0 = problems.length;

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) bad(file, "the file name is the id: lowercase letters, digits and hyphens");
  for (const k of ["name", "nameZh", "cwaPoint"]) if (typeof f[k] !== "string" || !f[k]) bad(file, `${k} is missing`);
  if (!REGIONS.includes(f.region as (typeof REGIONS)[number])) bad(file, `region must be one of: ${REGIONS.join(", ")}`);
  const loc = f.location;
  if (!Array.isArray(loc) || loc.length !== 2 || !loc.every(isNum)) bad(file, "location must be [lat, lon]");
  else if (loc[0] < 21 || loc[0] > 26.5 || loc[1] < 118 || loc[1] > 123) bad(file, `location ${loc} isn't around Taiwan; is it [lat, lon]?`);
  if (!isBearing(f.faces)) bad(file, "faces must be a bearing in degrees, 0 to 359");
  const sw = f.swell as { best?: unknown; works?: unknown } | undefined;
  if (!sw || !isRange(sw.best) || !isRange(sw.works)) bad(file, "swell.best and swell.works must each be [from, to] in degrees");
  else {
    if (!within(sw.best[0], sw.works) || !within(sw.best[1], sw.works)) bad(file, "swell.best must sit inside swell.works");
    if (isBearing(f.faces) && !within(f.faces, sw.works)) bad(file, "faces should point into swell.works");
  }
  if (!Array.isArray(f.buoys) || !f.buoys.length || !f.buoys.every((b) => typeof b === "string")) bad(file, "buoys must be a list of CWA station ids");
  if (f.model != null && (!Array.isArray(f.model) || f.model.length !== 2 || !f.model.every(isNum))) bad(file, "model, if given, must be [lat, lon]");
  const known = new Set(["name", "nameZh", "region", "location", "faces", "swell", "cwaPoint", "buoys", "model"]);
  for (const k of Object.keys(f)) if (!known.has(k)) bad(file, `unknown field "${k}" (anything else belongs in the written text)`);
  if (problems.length > n0) continue;

  const [lat, lon] = loc as [number, number];
  spots.push({
    id, name: f.name, nameZh: f.nameZh, region: f.region, lat, lon,
    faces: f.faces, swell: { best: sw!.best, works: sw!.works },
    model: (f.model as [number, number] | undefined) ?? modelPoint(lat, lon, f.faces as number),
    cwaPoint: f.cwaPoint, buoys: f.buoys,
  });
}

if (problems.length) {
  console.error(`${problems.length} problem${problems.length > 1 ? "s" : ""} in spots/:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
// Regions in their order, then north to south (west to east on the same latitude).
spots.sort((a, b) => REGIONS.indexOf(a.region as never) - REGIONS.indexOf(b.region as never) || b.lat - a.lat || a.lon - b.lon);
const json = `${JSON.stringify(spots, null, 2)}\n`;
const old = await readFile(OUT, "utf8").catch(() => "");
if (json !== old) await writeFile(OUT, json);
console.log(`spots: ${spots.length} checked${json !== old ? ", src/data/spots.json updated" : ""}`);
