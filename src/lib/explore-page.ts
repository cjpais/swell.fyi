// Explore map in the browser. One clock and one selected spot drive everything: the spot
// pins, the compass that opens around the open spot, the panel (top left) and the forecast
// bar (bottom). With no spot open, the panel lists every spot.
// Written as a mountable module so the home page can use it later.
import type { GeoJSONSource, MapGeoJSONFeature, SymbolLayerSpecification } from "maplibre-gl";
import { createMap } from "./map";
import { loadField, fieldProblem, type Field } from "./field";
import { makeConditions, type SeaSeries, type WindSeries } from "./conditions";
import { renderCompass, type RoseTag } from "./compass";
import { forecastStrip, type Readout } from "./forecast-strip";
import { slots, tideAt } from "./ui";
import { fmt, compass } from "./format";
import { HOUR as H, facesDeg, hhmm, nowS, tideSeries, whenLabel, type SwellWindow, type Tide } from "./surf";
import { isFresh, loadSpotTides, loadStations, type LiveStation, type SpotTide } from "./data";

type SpotP = { id: string; name: string; nameZh: string; region: string; lat: number; lon: number; faces: number; swell: SwellWindow };
type Payload = {
  spots: SpotP[];
  buoys: { id: string; name: string; lat: number; lon: number }[];
};

const LAST = "swell.lastSpot";
const SPOT_ZOOM = 11.5;
const OVERVIEW: [[number, number], [number, number]] = [[119.4, 21.7], [122.1, 25.4]];
const FONT = ["Noto Sans Medium"];
const short = (n: string) => n.replace(/ \(.*\)$/, "").replace(/ \/ .*/, "");
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
/** "45° NE" */
const deg = (d: number | null | undefined) => (d == null ? "–" : `${Math.round(d)}° ${compass(d)}`);

export async function initExplore(root: HTMLElement, p: Payload) {
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const $$ = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];

  const now = nowS(), nowH = Math.round(now / H) * H;
  const T0 = nowH - 24 * H;

  // ---------- map ----------
  const map = createMap($("#map"), {
    center: [120.95, 23.6], zoom: 6.6, minZoom: 5, nav: "bottom-right",
    attribution: 'Waves, wind: <a href="https://open-meteo.com/">Open-Meteo</a> (MFWAM, ECMWF IFS) · Buoys, tides: CWA',
  });
  const mapReady = new Promise<void>((r) => map.once("load", () => r()));
  const [field, tides, stations]: [Field | null, Record<string, SpotTide> | null, LiveStation[]] = await Promise.all([
    loadField(), loadSpotTides(), loadStations().catch(() => [] as LiveStation[]),
  ]);
  const latest = new Map(stations.map((s) => [s.id, s.latest]));
  const problem = fieldProblem(field), warn = root.querySelector<HTMLElement>("#field-warn");
  if (warn) { warn.hidden = !problem; warn.textContent = problem ?? ""; }
  const T1 = nowH + 6 * 24 * H;
  const spotsById = new Map(p.spots.map((s) => [s.id, s]));

  // Keep the visible middle of the map clear of the panel.
  const stage = $(".ex-stage"), card = $("#card");
  function padding() {
    const box = stage.getBoundingClientRect(), r = card.getBoundingClientRect(), wide = box.width > 760;
    return { left: Math.round(wide ? r.right - box.left : 0), right: 0, top: 0, bottom: Math.round(wide ? 0 : Math.min(r.height, box.height * 0.5)) };
  }
  // Setting padding stops a camera move in progress, so wait for a fly-to to land first.
  function pad() {
    const want = padding(), have = map.getPadding();
    if (want.left === have.left && want.bottom === have.bottom) return;
    if (map.isMoving()) { map.once("moveend", pad); return; }
    map.setPadding(want);
  }
  new ResizeObserver(pad).observe(card);
  addEventListener("resize", pad);

  // ---------- numbers per spot (field.json: the same models as the spot page) ----------
  const series = (id: string) => {
    const f = field?.spots[id];
    if (!f) return { sea: null, wind: null, sst: null };
    const w = f.wave;
    const sea: SeaSeries = { label: w.label, time: w.time, get: (v) => (w[v] as (number | null)[]) ?? w.time.map(() => null) };
    const wind: WindSeries = f.wind;
    return { sea, wind, sst: f.sst };
  };
  const conds = new Map(p.spots.map((s) => { const x = series(s.id); return [s.id, makeConditions(x.sea, x.wind, facesDeg(s.faces), s.swell)]; }));

  // ---------- state ----------
  let sel: SpotP | null = null, tide: Tide | null = null;
  let pinned = nowH, preview: number | null = null;
  const cur = () => preview ?? pinned;

  // ---------- spots and buoys, drawn by MapLibre so labels never collide ----------
  const spotData = (ts: number) => ({
    type: "FeatureCollection" as const,
    features: p.spots.map((s) => {
      const c = conds.get(s.id)!(ts);
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
        properties: { id: s.id, name: short(s.name), hs: c.hs != null ? fmt(c.hs) : "–", sel: s.id === sel?.id, rank: (s.id === sel?.id ? 100 : 0) + (c.hs ?? 0) },
      };
    }),
  });
  const buoyData = {
    type: "FeatureCollection" as const,
    features: p.buoys.map((s) => {
      const l = latest.get(s.id), hs = l?.values.wave_height_m ?? null;
      const ok = isFresh(l?.time, now) && hs != null;
      return { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] }, properties: { id: s.id, label: ok ? `${s.name} buoy ${fmt(hs)} m` : `${s.name} buoy`, ok } };
    }),
  };

  /** Round pin: a face, an ink ring, and a small yellow offset like the rest of the print. */
  function pin(ring: string, face: string) {
    const r = 2, S = 34 * r, c = document.createElement("canvas");
    c.width = c.height = S;
    const x = c.getContext("2d")!;
    x.fillStyle = css("--third"); x.beginPath(); x.arc(S / 2 + 2 * r, S / 2 + 2 * r, 13 * r, 0, 7); x.fill();
    x.fillStyle = face; x.beginPath(); x.arc(S / 2, S / 2, 13 * r, 0, 7); x.fill();
    x.strokeStyle = ring; x.lineWidth = 3.5 * r; x.beginPath(); x.arc(S / 2, S / 2, 11.2 * r, 0, 7); x.stroke();
    return { image: x.getImageData(0, 0, S, S), pixelRatio: r };
  }

  const src = (id: string) => map.getSource(id) as GeoJSONSource | undefined;
  mapReady.then(() => {
    const ink = css("--ink"), surface = css("--surface"), land = css("--map-land");
    const a = pin(ink, surface), b = pin(ink, ink);
    map.addImage("pin", a.image, { pixelRatio: a.pixelRatio });
    map.addImage("pin-sel", b.image, { pixelRatio: b.pixelRatio });
    map.addSource("buoys", { type: "geojson", data: buoyData });
    map.addSource("spots", { type: "geojson", data: spotData(cur()) });
    map.addLayer({
      id: "buoys", type: "circle", source: "buoys",
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 2.5, 10, 4.5], "circle-color": css("--buoy"), "circle-opacity": ["case", ["get", "ok"], 1, 0.35], "circle-stroke-color": land, "circle-stroke-width": 1 },
    });
    const buoyLabel: SymbolLayerSpecification["layout"] = { "text-field": ["get", "label"], "text-font": FONT, "text-size": 11, "text-anchor": "left", "text-offset": [0.8, 0] };
    map.addLayer({ id: "buoy-labels", type: "symbol", source: "buoys", minzoom: 9, layout: buoyLabel, paint: { "text-color": ink, "text-halo-color": land, "text-halo-width": 1.5 } });
    // A small dot for every spot, so a pin hidden by a neighbour still marks its place.
    map.addLayer({ id: "spot-dots", type: "circle", source: "spots", paint: { "circle-radius": 3.5, "circle-color": css("--spot"), "circle-stroke-color": land, "circle-stroke-width": 1.5 } });
    map.addLayer({ id: "spot-hot", type: "circle", source: "spots", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": 19, "circle-opacity": 0, "circle-stroke-color": css("--seal"), "circle-stroke-width": 2.5 } });
    map.addLayer({
      id: "spot-pins", type: "symbol", source: "spots",
      layout: {
        "icon-image": ["case", ["get", "sel"], "pin-sel", "pin"],
        "text-field": ["get", "hs"], "text-font": FONT, "text-size": 12.5,
        "symbol-sort-key": ["-", 0, ["get", "rank"]], "icon-padding": 1,
      },
      paint: { "text-color": ["case", ["get", "sel"], surface, ink] },
    });
    map.addLayer({
      id: "spot-names", type: "symbol", source: "spots",
      layout: {
        "text-field": ["get", "name"], "text-font": FONT, "text-size": ["case", ["get", "sel"], 14, 12.5],
        "text-variable-anchor": ["left", "right", "top", "bottom"], "text-radial-offset": 1.45, "text-justify": "auto",
        "symbol-sort-key": ["-", 0, ["get", "rank"]],
      },
      paint: { "text-color": ink, "text-halo-color": land, "text-halo-width": 2 },
    });
    const pointer = (id: string) => {
      map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
    };
    for (const id of ["spot-pins", "spot-names", "spot-dots"]) {
      map.on("click", id, (e) => { const f = e.features?.[0] as MapGeoJSONFeature | undefined; if (f) location.hash = String(f.properties.id); });
      pointer(id);
    }
    map.on("click", "buoys", (e) => { const f = e.features?.[0]; if (f) location.href = `/buoys/${f.properties.id}/`; });
    pointer("buoys");
    // Start with the credits folded into the (i) button; they sit over the sea otherwise.
    root.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    paintTime();
  });

  // ---------- the compass, opened around the spot on the map ----------
  // Arrows run in from the rim to the pin, each labelled with its numbers.
  const rose = document.createElement("div");
  rose.className = "ex-rose";
  rose.setAttribute("aria-hidden", "true");
  map.getContainer().append(rose);
  function placeRose() {
    if (!sel) return;
    const c = map.project([sel.lon, sel.lat]);
    rose.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
  }
  map.on("move", placeRose);
  function paintRose(ts: number) {
    rose.hidden = !sel;
    if (!sel) return;
    const c = conds.get(sel.id)!(ts);
    const tags: RoseTag[] = [];
    c.parts.forEach((x) => { if (x.dir != null && x.h != null && x.h >= 0.1) tags.push({ dir: x.dir, cls: x.cls, text: `${x.name} ${fmt(x.h)} m · ${fmt(x.period, 0)} s` }); });
    if (c.w?.dir != null) tags.push({ dir: c.w.dir, cls: "wind", text: `Wind ${fmt(c.w.speed, 0)} m/s` });
    // No coastline or swell window yet: each spot's bounds still need picking by hand.
    // The spot's swell window on the rose; the map underneath already shows the coast.
    renderCompass(rose, { faces: facesDeg(sel.faces), window: sel.swell, swells: c.parts.map((x) => ({ dir: x.dir, h: x.h, cls: x.cls, blocked: x.blocked })), wind: c.w, tags, label: "" });
    placeRose();
  }

  // ---------- the clock: one forecast bar along the bottom ----------
  const strip = forecastStrip($("#strip"), {
    t0: T0, t1: T1, now, empty: "Pick a spot for its waves, wind and tide", readout,
    onPreview: (ts) => { preview = ts; paintTime(); },
    onPick: (ts) => { pinned = ts; preview = null; paintTime(); },
  });
  $("#now").addEventListener("click", () => { pinned = nowH; preview = null; strip.setPinned(pinned); paintTime(); });

  function refreshStrip() {
    if (!sel) return strip.setData(null);
    const { sea, wind } = series(sel.id);
    strip.setData({
      waves: sea ? { t: sea.time, v: sea.get("wave_height") } : null,
      wind: wind ? { t: wind.time, speed: wind.wind_speed_10m, dir: wind.wind_direction_10m } : null,
      tide: tide ? { t: tide.t, v: tide.v } : null,
    });
  }
  /** The bar's left side: the numbers for each row at the cursor. */
  function readout(ts: number): Readout | null {
    if (!sel) return null;
    const c = conds.get(sel.id)!(ts), sw = c.parts[0];
    const [h, trend] = tide ? tideAt(tide, ts)[0].split(", ") : ["–", ""];
    const next = tide?.events.find((e) => e.t > ts);
    return {
      title: `${short(sel.name)} ${sel.nameZh}`,
      waves: [`Waves ${fmt(c.hs)} m`, sw.h != null ? `Swell ${fmt(sw.h)} m · ${fmt(sw.period, 0)} s · ${deg(sw.dir)}` : "No swell data"],
      wind: [`Wind ${fmt(c.w?.speed, 0)} m/s`, c.w?.dir != null ? `${deg(c.w.dir)} · gusts ${fmt(c.w.gust, 0)} m/s` : "No wind data"],
      tide: tide ? [`Tide ${h}`, `${trend}${next ? ` · ${next.kind} ${hhmm(next.t)}` : ""}`] : ["Tide –", "No forecast nearby"],
    };
  }

  // ---------- painting for the current time ----------
  const R = slots($("#spot"));
  function paintTime() {
    const ts = cur();
    const kind = ts === nowH ? "Right now" : ts < now ? "Earlier" : "Forecast for";
    $$("[data-kind]").forEach((n) => (n.textContent = kind));
    $$("[data-when]").forEach((n) => (n.textContent = whenLabel(ts)));
    root.classList.toggle("is-future", ts !== nowH);
    src("spots")?.setData(spotData(ts));
    for (const s of p.spots) {
      const row = root.querySelector(`[data-pick="${s.id}"]`);
      if (!row) continue;
      const c = conds.get(s.id)!(ts);
      row.querySelector("[data-hs]")!.innerHTML = c.hs != null ? `${fmt(c.hs)}<small>m</small>` : "–";
      row.querySelector("[data-wind]")!.textContent = c.w?.speed != null ? `${fmt(c.w.speed, 0)} m/s ${compass(c.w.dir)}` : "";
    }
    paintSpot(ts);
    paintRose(ts);
  }

  // The open spot: its name, then the two numbers that matter most.
  function paintSpot(ts: number) {
    if (!sel) return;
    const c = conds.get(sel.id)!(ts);
    R.text("kind", ts === nowH ? "Right now" : ts < now ? "Earlier" : "Forecast for");
    R.text("when", whenLabel(ts));
    R.text("hs", fmt(c.hs));
    R.text("ws", fmt(c.w?.speed, 0));
    R.text("wdir", c.w?.dir != null ? `Wind from ${deg(c.w.dir)}` : "Wind");
  }

  // ---------- selection ----------
  function select(id: string | null, how: "jump" | "fly" = "fly") {
    const s = id ? spotsById.get(id) ?? null : null;
    const was = sel;
    sel = s;
    root.classList.toggle("has-spot", !!s);
    $("#pick").hidden = !!s;
    $("#spot").hidden = !s;
    const t = s ? tides?.[s.id] : null;
    tide = t ? tideSeries(t.events) : null;
    pad();
    refreshStrip();
    paintTime();
    if (!s) {
      if (was) map.fitBounds(OVERVIEW, { duration: 1200, padding: 60 });
      return;
    }
    localStorage.setItem(LAST, s.id);
    R.text("zh", s.nameZh);
    R.text("en", short(s.name));
    root.querySelector<HTMLAnchorElement>('[data-k="more"]')!.href = `/spots/${s.id}/`;
    // Always close in on the beach, once the panel has switched so the padding is right.
    requestAnimationFrame(() => {
      const target = { center: [s.lon, s.lat] as [number, number], zoom: Math.max(map.getZoom(), SPOT_ZOOM), padding: padding() };
      if (how === "jump") map.jumpTo(target); else map.flyTo({ ...target, duration: 1600, essential: true });
    });
  }

  // ---------- list ↔ map ----------
  const hot = (id: string) => { if (map.getLayer("spot-hot")) map.setFilter("spot-hot", ["==", ["get", "id"], id]); };
  $("#pick").addEventListener("pointerover", (e) => hot((e.target as HTMLElement).closest<HTMLElement>("[data-pick]")?.dataset.pick ?? ""));
  $("#pick").addEventListener("pointerleave", () => hot(""));
  $("#close").addEventListener("click", () => { history.pushState(null, "", location.pathname); select(null); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && sel && !(e.target as HTMLElement).closest("input, svg")) $("#close").click(); });
  addEventListener("hashchange", () => select(location.hash.slice(1) || null));

  // ---------- start: URL hash, then the last spot you opened, then the whole coast ----------
  const startId = location.hash.slice(1) || localStorage.getItem(LAST);
  const start = startId && spotsById.has(startId) ? startId : null;
  pad();
  if (start) {
    if (!location.hash) history.replaceState(null, "", `#${start}`);
    select(start, "jump");
  } else {
    select(null, "jump");
    // Once the bar has drawn and the map has its final size.
    mapReady.then(() => { if (!sel) map.fitBounds(OVERVIEW, { duration: 0, padding: 50 }); });
  }
}
