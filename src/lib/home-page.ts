// Home page in the browser: the overview map, then the wind at every spot (one Open-Meteo
// request) to colour the strips, chips and callouts. The lists themselves are built at build time.
import { createMap, marker, spotCallouts } from "./map";
import { arrowSvg } from "./glyphs";
import { esc, strip } from "./ui";
import { fmt, compass } from "./format";
import { at, facesDeg, fetchManyWind, windState, nowS } from "./surf";

type Payload = {
  yMax: number;
  spots: { id: string; name: string; lat: number; lon: number; faces: string; peak: number | null; rows: [number, number | null][] }[];
  stations: { id: string; name: string; lat: number; lon: number; hs: number | null; tp: number | null; dir: number | null; time: string | null }[];
};

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);

export async function initHome(p: Payload) {
  const now = nowS();
  // Narrow maps zoom out so the callouts pushed out to sea still fit.
  const narrow = $("#map")!.clientWidth < 600;
  const map = createMap($("#map")!, { center: narrow ? [120.95, 23.65] : [120.95, 23.6], zoom: narrow ? 5.8 : 6.55 });

  // Buoys as small measured tags; stale ones shrink to a grey dot.
  map.on("load", () => {
    for (const s of p.stations) {
      const ok = s.time != null && now - Date.parse(s.time) / 1000 < 3 * 3600 && s.hs != null;
      const el = marker(map, [s.lon, s.lat], `<span>${ok ? fmt(s.hs) : ""}</span>${ok ? arrowSvg(s.dir, 11) : ""}`, `buoy-dot${ok ? "" : " stale"}`, `/buoys/${s.id}/`);
      el.title = `${s.name}: ${ok ? `${fmt(s.hs)} m, ${fmt(s.tp)} s from ${compass(s.dir)}` : "no current reading"}`;
    }
  });

  // Spots as callouts pushed out to sea, east or west of the island.
  const callouts = spotCallouts(map, p.spots.map((s) => ({
    id: s.id, lat: s.lat, lon: s.lon,
    side: s.lon < 120.8 ? "west" : "east",
    href: `/spots/${s.id}/`,
    html: `<span class="co-name">${esc(s.name.replace(/ \(.*\)$/, "").replace(/ \/ .*/, ""))}</span><span class="co-val">${fmt(s.peak)}</span><i class="co-tone t-none" data-tone="${s.id}"></i>`,
  })));

  try {
    const winds = await fetchManyWind(p.spots.map((s) => [s.lat, s.lon]));
    p.spots.forEach((s, i) => {
      const w = winds[i];
      if (!w) return;
      const faces = facesDeg(s.faces);
      const stateAt = (ts: number) => windState(at(w.time, w.wind_direction_10m, ts), at(w.time, w.wind_speed_10m, ts), faces);
      const row = $(`[data-spot="${s.id}"]`);
      if (!row) return;
      $("[data-strip]", row)!.innerHTML = strip(s.rows, (ts) => stateAt(ts).tone, p.yMax);
      const ws = stateAt(now);
      const chip = $("[data-chip]", row)!;
      chip.className = `wind-chip t-${ws.tone}`;
      chip.textContent = ws.label;
      const tone = $(`[data-tone="${s.id}"]`);
      if (tone) { tone.className = `co-tone t-${ws.tone}`; tone.title = `Wind now: ${ws.label}`; }
    });
  } catch {
    document.querySelectorAll("[data-chip]").forEach((c) => (c.textContent = "Wind unavailable"));
  }
  callouts.layout();
}
