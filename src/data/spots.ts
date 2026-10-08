// The surf spots. Each is a Markdown file in spots/ (one per spot, the only place to edit them);
// scripts/spots.ts checks them and writes spots.json, which this reads. See spots/README.md.
// `faces` is the bearing the break faces, in degrees: wind within about 45° of the opposite way
// is offshore. `swell.best` and `swell.works` are the directions swell can come from, clockwise
// [from, to] in degrees. `cwaPoint` is the spot's point in CWA's recreation sea forecast
// (M-B0078-001); `buoys` are CWA marine stations, nearest or most relevant first. `model` is a
// point about 5 km out along `faces`, where the wave models are read; each snaps to its nearest
// sea cell (shown on the spot page).
import data from "./spots.json";

export { REGIONS } from "./regions";

export type SwellWindow = { best: [number, number]; works: [number, number] };
export type Spot = {
  id: string;
  name: string;
  nameZh: string;
  region: string;
  lat: number;
  lon: number;
  model: [number, number];
  faces: number;
  swell: SwellWindow;
  cwaPoint: string;
  buoys: string[];
};

export const SPOTS = data as Spot[];

export const spotById = (id: string) => SPOTS.find((s) => s.id === id);
