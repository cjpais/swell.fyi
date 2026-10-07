import type uPlot from "uplot";
import { renderChart, sec, type Series } from "./chart";
import { fetchMarine, fetchWind, partitioned, WAVE_MODELS, WIND_MODELS, km, type Grid, type Partitioned as Sea } from "./openmeteo";
import { toCsv, downloadText } from "./csv";
import { fmt, compass } from "./format";
import { renderCompass } from "./compass";
import { renderTimeline } from "./timeline";
import { makeConditions, roseSwells, swellNote, timelineRows } from "./conditions";
import { createMap, marker, conditionOverlay } from "./map";
import { PARTS, esc, legendHtml, slots, swIcon, tideAt, windChip, windIcon, windKey } from "./ui";
import { HOUR as H, at, facesDeg, fetchSST, fetchSpotWind, hhmm, nowS, obsTable, tideSeries, whenLabel, type ObsFile, type Wind } from "./surf";
import { cwaUrl, getCwa, loadSpotForecast, loadSpotTides, loadStations, loadWrfWind, type ForecastRow, type LiveStation } from "./data";

type BuoyRef = { id: string; name: string; zh: string; lat: number; lon: number; km: number };
type Built = { spot: { id: string; name: string; lat: number; lon: number; model: [number, number]; faces: string; cwaPoint: string }; buoys: BuoyRef[] };
type Payload = {
  spot: Built["spot"];
  cwa: { code: string; name: string; lat: number; lon: number; issued: string; rows: ForecastRow[] } | null;
  buoy: (BuoyRef & { hs: number | null; time: string | null }) | null;
  tide: { name: string; events: [string, string, number | null][] } | null;
  wrf: Wrf[];
};
/** One CWA WRF run at this spot: 10 m wind every 6 h. */
type Wrf = { id: string; short: string; color: string; dataId: string; label: string; init: string; lat: number; lon: number; t: number[]; speed: number[]; dir: number[] };
const WRF_STYLE: Record<string, { short: string; color: string }> = { wrf3: { short: "WRF 3 km", color: "--s2" }, wrf15: { short: "WRF 15 km", color: "--s9" } };

const $ = (id: string) => document.getElementById(id)!;

/** The live pieces from the swell-data Worker: CWA's forecasts, the tide, and the nearest working buoy. */
async function live(b: Built): Promise<Payload> {
  const [rec, tides, stations, wrf] = await Promise.all([loadSpotForecast(), loadSpotTides(), loadStations().catch(() => [] as LiveStation[]), loadWrfWind()]);
  const point = rec?.points[b.spot.cwaPoint];
  const byId = new Map(stations.map((s) => [s.id, s]));
  // Nearest buoy (in the spot's order) with a wave reading in the last 12 hours.
  const working = b.buoys.find((x) => {
    const l = byId.get(x.id)?.latest;
    return l?.values.wave_height_m != null && Date.now() - Date.parse(l.time) < 12 * 36e5;
  });
  const l = working ? byId.get(working.id)!.latest! : null;
  return {
    spot: b.spot,
    cwa: point && rec ? { code: b.spot.cwaPoint, name: point.name, lat: point.lat, lon: point.lon, issued: rec.issued, rows: point.rows } : null,
    buoy: working ? { ...working, hs: l!.values.wave_height_m, time: l!.time } : null,
    tide: tides?.[b.spot.id] ?? null,
    wrf: Object.entries(WRF_STYLE).flatMap(([id, style]) => {
      const run = wrf?.models[id as keyof typeof wrf.models], at = run?.spots[b.spot.id];
      return run && at ? [{ id, ...style, dataId: run.dataId, label: run.label, init: run.init, lat: at.lat, lon: at.lon, t: run.time, speed: at.speed, dir: at.dir }] : [];
    }),
  };
}

function buoyLine(p: Payload, all: BuoyRef[]) {
  const link = (b: BuoyRef) => `<a href="/buoys/${b.id}/">${esc(b.name)}</a>`;
  const others = all.filter((b) => b.id !== p.buoy?.id);
  $("buoys").innerHTML =
    (p.buoy ? ` Nearest working buoy: ${link(p.buoy)}, ${p.buoy.km.toFixed(0)} km away.` : all.length ? " No nearby buoy is reporting waves right now." : "") +
    (others.length ? ` ${p.buoy ? "Also nearby" : "Nearby"}: ${others.map(link).join(", ")}.` : "");
}

export async function initSpot(built: Built) {
  const p = await live(built);
  buoyLine(p, built.buoys);
  const s = p.spot;
  const now = nowS();
  const faces = facesDeg(s.faces);
  const buoyName = p.buoy?.name ?? null;
  const tide = p.tide ? tideSeries(p.tide.events) : null;

  // ---------- hero: readout, compass, map ----------
  const R = slots($("readout"));
  const map = createMap($("map"), { center: [s.lon, s.lat], zoom: 10.6, minZoom: 7, cooperative: true });
  const overlay = conditionOverlay(map, [s.lon, s.lat]);
  if (p.buoy) marker(map, [p.buoy.lon, p.buoy.lat], `<span>${esc(p.buoy.name)} buoy</span>`, "map-tag tag-buoy", `/buoys/${p.buoy.id}/`);
  marker(map, [s.lon, s.lat], `<span>${esc(s.name.replace(/ \(.*\)$/, ""))}</span>`, "map-tag tag-spot");

  const [marine, models, wind, obsFile, sst] = await Promise.all([
    fetchMarine(s.model[0], s.model[1], 3, 10).catch((e: Error) => e),
    fetchWind(s.lat, s.lon, 3, 10).catch((e: Error) => e),
    fetchSpotWind(s.lat, s.lon, { past: 1, days: 7 }).catch(() => null),
    p.buoy ? getCwa<ObsFile>(`obs/${p.buoy.id}.json`).catch(() => null) : Promise.resolve(null),
    fetchSST(s.model[0], s.model[1]).catch(() => null),
  ]);
  const sea = partitioned(marine);
  const obs = obsTable(obsFile);
  const obsHs = obs?.col("wave_height_m") ?? [];
  const lastObs = obs ? obs.t.findLast((_, i) => obsHs[i] != null) ?? null : null;

  const conditions = makeConditions(sea, wind, faces);
  const note = swellNote;

  function show(tsIn: number | null) {
    const ts = tsIn ?? Math.round(now / H) * H;
    const { parts, w, hs } = conditions(ts);
    R.text("kind", tsIn == null ? "Right now" : ts < now ? "Earlier" : "Forecast for");
    R.text("when", whenLabel(ts));
    R.text("fc-hs", fmt(hs));
    R.text("fc-src", sea ? `${sea.label} model, total sea offshore` : "Model unavailable");
    if (obs && lastObs != null) {
      const past = ts <= lastObs + H;
      const bt = past ? ts : lastObs;
      R.text("ms-hs", fmt(at(obs.t, obsHs, bt, 2 * H)));
      R.text("ms-src", past ? `${buoyName} buoy, ${hhmm(bt)}` : `${buoyName}, latest ${hhmm(bt)}`);
    } else { R.text("ms-hs", "–"); R.text("ms-src", "No working buoy nearby"); }
    R.text("note", note(parts));
    parts.forEach((x, i) => {
      const some = x.h != null && x.h >= 0.1;
      R.text(`sw${i + 1}`, some ? `${fmt(x.h)} m at ${fmt(x.period, 0)} s from ${compass(x.dir)}` : "None to speak of");
      R.text(`sw${i + 1}-sub`, some ? (x.blocked ? "Blocked by the coast" : x.exposure[0].toUpperCase() + x.exposure.slice(1)) : "");
    });
    R.html("wind", windChip(w));
    R.text("wind-sub", w?.gust != null ? `Gusts ${fmt(w.gust)} m/s, ECMWF model` : "");
    const [tMain, tSub] = tideAt(tide, ts);
    R.text("tide", tMain); R.text("tide-sub", tSub);
    const wt = obs && lastObs != null && ts <= lastObs + H ? at(obs.t, obs.col("sea_temp_c"), ts, 3 * H) : null;
    const wm = sst ? at(sst.time, sst.sea_surface_temperature, ts) : null;
    R.text("water", wt != null ? `${fmt(wt)} °C` : wm != null ? `${fmt(wm)} °C` : "–");
    R.text("water-sub", wt != null ? `Measured at ${buoyName} buoy` : wm != null ? "Sea surface, model" : "");
    renderCompass($("rose"), { faces, swells: roseSwells(parts), wind: w, label: `Swell from ${compass(parts[0].dir)}, wind from ${compass(w?.dir)}` });
    overlay.update({ faces, swells: roseSwells(parts), wind: w });
  }
  show(null);

  function tip(ts: number, el: HTMLElement) {
    const { parts, hs, w } = conditions(ts);
    const p1 = parts[0];
    el.innerHTML = `<div class="tip-rose"></div><div>
      <div class="tip-line">${whenLabel(ts)}</div>
      <div class="tip-hs">${fmt(hs)}<small>m</small></div>
      <div class="tip-line">${swIcon("p1")}Swell ${fmt(p1.h)} m, ${fmt(p1.period, 0)} s, ${compass(p1.dir)}${p1.blocked ? " (blocked)" : ""}</div>
      <div class="tip-line">${windIcon}${windChip(w)}</div>
    </div>`;
    renderCompass(el.firstElementChild!, { faces, swells: roseSwells(parts), wind: w, label: "" });
  }

  $("legend").innerHTML = legendHtml([
    ["tl-total", "Total sea, includes local chop", "area"],
    ...PARTS.map((x): [string, string] => [x.cls, x.label]),
    ...(obs ? [["tl-obs", `${buoyName} buoy, measured`, "dot"] as [string, string, string]] : []),
  ]) + windKey(true);

  const rows = timelineRows({ sea, wind, obs, tide, tideName: p.tide?.name, faces });
  renderTimeline($("timeline"), { t0: now - 24 * H, t1: now + 6 * 24 * H, now, sun: wind?.sun ?? [], rows, onScrub: show, tip });

  sourceTable(p, { now, sea, marine, wind });

  // ---------- every source, side by side ----------
  initCompare(p, marine, models, obsFile, tide);
}

function sourceTable(p: Payload, { now, sea, marine, wind }: { now: number; sea: Sea | null; marine: Grid | Error; wind: Wind | null }) {
  const peak = (t: number[], v: (number | null)[]) => {
    let m: number | null = null;
    t.forEach((ts, i) => { const x = v[i]; if (ts >= now && ts <= now + 24 * H && x != null && (m == null || x > m)) m = x; });
    return m;
  };
  const cwaPeak = p.cwa ? peak(p.cwa.rows.map((r) => Date.parse(r[0]) / 1000), p.cwa.rows.map((r) => r[1])) : null;
  const seaUrl = marine instanceof Error ? "" : marine.url;
  $("source-table").innerHTML = `
    <table class="data">
      <thead><tr><th>Source</th><th>What it gives</th><th class="n">Next 24 h peak</th><th>Raw data</th></tr></thead>
      <tbody>
        ${p.buoy ? `<tr><td>${esc(p.buoy.name)} buoy (CWA O-B0075)</td><td>Measured height, period, direction, water temperature</td><td class="n">${fmt(p.buoy.hs)} m at ${p.buoy.time ? hhmm(Date.parse(p.buoy.time) / 1000) : "–"}</td><td><a href="${cwaUrl(`obs/${p.buoy.id}.json`)}">JSON</a>, <a href="${cwaUrl(`csv/${p.buoy.id}.csv`)}">CSV</a></td></tr>` : ""}
        ${p.cwa ? `<tr><td>CWA recreation forecast, ${esc(p.cwa.name)} (M-B0078-001)</td><td>CWA's own WW3 run: height, period, direction, every 3 h</td><td class="n">${fmt(cwaPeak)} m</td><td><a href="${cwaUrl("recreation.json")}">JSON</a></td></tr>` : ""}
        ${sea ? `<tr><td>${sea.label} via Open-Meteo</td><td>Total sea plus swell trains, hourly</td><td class="n">${fmt(peak(sea.time, sea.get("wave_height")))} m</td><td><a href="${esc(seaUrl)}">API</a></td></tr>` : `<tr><td>Open-Meteo marine</td><td colspan="3">Request failed${marine instanceof Error ? `: ${esc(marine.message)}` : ""}</td></tr>`}
        ${wind ? `<tr><td>ECMWF IFS via Open-Meteo</td><td>10 m wind and gusts, hourly</td><td class="n">${fmt(peak(wind.time, wind.wind_speed_10m))} m/s</td><td><a href="${esc(wind.url)}">API</a></td></tr>` : ""}
        ${p.wrf.map((w) => `<tr><td>${esc(w.label)} (${w.dataId})</td><td>10 m wind, every 6 h to 84 h, run of ${whenLabel(Date.parse(w.init) / 1000)}</td><td class="n">${fmt(peak(w.t, w.speed))} m/s</td><td><a href="${cwaUrl("wrf-wind.json")}">JSON</a></td></tr>`).join("")}
        ${p.tide ? `<tr><td>CWA tide forecast, ${esc(p.tide.name)} (F-A0021-001)</td><td>High and low times; the curve between is interpolated</td><td class="n"></td><td><a href="${cwaUrl("tides.json")}">JSON</a></td></tr>` : ""}
      </tbody>
    </table>`;
}

const RANGES: Record<string, () => [number, number]> = {
  past: () => [Date.now() / 1000 - 3 * 24 * H, Date.now() / 1000 + 6 * H],
  "3d": () => [Date.now() / 1000 - 24 * H, Date.now() / 1000 + 3 * 24 * H],
  "10d": () => [Date.now() / 1000 - 24 * H, Date.now() / 1000 + 10 * 24 * H],
};

function initCompare(p: Payload, marine: Grid | Error, wind: Grid | Error, obs: ObsFile | null, tide: { t: number[]; v: number[] } | null) {
  const charts: uPlot[] = [];
  let range = RANGES["3d"]();
  let partModel = "meteofrance_wave";

  const gridEl = $("grid-cell");
  if (marine instanceof Error) {
    gridEl.textContent = `Open-Meteo request failed (${marine.message}).`;
  } else {
    const parts = WAVE_MODELS.filter((m) => marine.cells[m.id]).map((m) => {
      const c = marine.cells[m.id];
      return `${m.short} ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)} (${km(p.spot.lat, p.spot.lon, c.lat, c.lon).toFixed(0)} km)`;
    });
    if (!(wind instanceof Error)) parts.push(`wind ${wind.lat.toFixed(2)}, ${wind.lon.toFixed(2)}`);
    for (const w of p.wrf) parts.push(`${w.short} ${w.lat.toFixed(2)}, ${w.lon.toFixed(2)} (${km(p.spot.lat, p.spot.lon, w.lat, w.lon).toFixed(0)} km)`);
    gridEl.textContent = parts.join("; ") + ".";
  }

  // --- series builders ---
  const cwaT = p.cwa?.rows.map((r) => sec(r[0])) ?? [];
  const cwa = (i: number): Series[] => (p.cwa ? [{ label: "CWA WW3", color: "--s2", t: cwaT, v: p.cwa.rows.map((r) => r[i] as number | null), style: "line+points" }] : []);

  const obsT = obs?.rows.map((r) => sec(String(r[0]))) ?? [];
  const col = (name: string) => {
    const i = obs?.columns.indexOf(name) ?? -1;
    return obs && i >= 0 ? obs.rows.map((r) => r[i] as number | null) : [];
  };
  const buoy = (name: string, label = p.buoy?.name ?? "Buoy"): Series[] =>
    obs ? [{ label, color: "--s1", t: obsT, v: col(name), width: 2.5 }] : [];

  const models = (g: Grid | Error, variable: string): Series[] =>
    g instanceof Error ? [] : WAVE_MODELS.filter((m) => g.has(variable, m.id)).map((m) => ({ label: m.short, color: m.color, t: g.time, v: g.get(variable, m.id) }));

  const partitions = (g: Grid | Error, model: string, kind: "height" | "period" | "direction"): Series[] =>
    g instanceof Error
      ? []
      : [
          { label: "Primary swell", color: "--s6", t: g.time, v: g.get(`swell_wave_${kind}`, model) },
          { label: "Secondary swell", color: "--s7", t: g.time, v: g.get(`secondary_swell_wave_${kind}`, model) },
          { label: "Wind waves", color: "--s8", t: g.time, v: g.get(`wind_wave_${kind}`, model), dash: [4, 3] },
        ];

  // CWA's WRF is 6-hourly, so its speed gets points like CWA's WW3. Direction charts are points already.
  const windSeries = (variable: "wind_speed_10m" | "wind_direction_10m"): Series[] => [
    ...(wind instanceof Error ? [] : WIND_MODELS.map((m) => ({ label: m.short, color: m.color, t: wind.time, v: wind.get(variable, m.id) }))),
    ...p.wrf.map((w): Series =>
      variable === "wind_speed_10m" ? { label: w.short, color: w.color, t: w.t, v: w.speed, style: "line+points" } : { label: w.short, color: w.color, t: w.t, v: w.dir }),
  ];

  function draw() {
    charts.splice(0).forEach((c) => c.destroy());
    const [xMin, xMax] = range;
    const x = { xMin, xMax };
    const push = (c: uPlot | null) => c && charts.push(c);
    push(renderChart($("c-hs"), { ...x, unit: "m", series: [...buoy("wave_height_m"), ...cwa(1), ...models(marine, "wave_height")] }));
    const pm = WAVE_MODELS.find((m) => m.id === partModel)!.short;
    push(renderChart($("c-part-h"), { ...x, unit: "m", title: `${pm} height`, height: 200, series: partitions(marine, partModel, "height") }));
    push(renderChart($("c-part-t"), { ...x, unit: "s", digits: 1, title: `${pm} period`, height: 180, series: partitions(marine, partModel, "period") }));
    push(renderChart($("c-part-d"), { ...x, unit: "", direction: true, title: `${pm} direction (from)`, height: 180, series: partitions(marine, partModel, "direction") }));
    push(renderChart($("c-tp"), { ...x, unit: "s", series: [...buoy("wave_period_s"), ...cwa(3), ...models(marine, "wave_period")] }));
    push(renderChart($("c-dir"), { ...x, unit: "", direction: true, series: [...buoy("wave_dir_deg"), ...cwa(2), ...models(marine, "wave_direction")] }));
    push(renderChart($("c-wind"), { ...x, unit: "m/s", title: "Speed", series: [...buoy("wind_speed_ms"), ...windSeries("wind_speed_10m")] }));
    push(renderChart($("c-wdir"), { ...x, unit: "", direction: true, title: "Direction (from)", height: 180, series: [...buoy("wind_dir_deg"), ...windSeries("wind_direction_10m")] }));
  }
  draw();

  $("range").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    range = RANGES[b.dataset.range!]();
    $("range").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    for (const c of charts) c.setScale("x", { min: range[0], max: range[1] });
  });
  $("part-model").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    partModel = b.dataset.model!;
    $("part-model").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    draw();
  });
  $("dl").addEventListener("click", () => {
    // One row per hour across every source; the buoy and CWA columns are blank where they have no value.
    const cols: { name: string; t: number[]; v: (number | null)[] }[] = [];
    const add = (name: string, t: number[], v: (number | null)[]) => v.some((x) => x != null) && cols.push({ name, t, v });
    for (const [c, name] of [["wave_height_m", "hs"], ["wave_period_s", "tm"], ["wave_dir_deg", "dir"], ["wind_speed_ms", "wind"], ["wind_dir_deg", "wind_dir"]] as const)
      if (obs) add(`buoy_${p.buoy!.id}_${name}`, obsT, col(c));
    if (p.cwa) ["hs", "dir", "tm", "current_dir", "current_speed"].forEach((n, i) => add(`cwa_${n}`, cwaT, p.cwa!.rows.map((r) => r[i + 1] as number | null)));
    if (!(marine instanceof Error))
      for (const m of WAVE_MODELS)
        for (const v of ["wave_height", "wave_period", "wave_direction", "swell_wave_height", "swell_wave_period", "swell_wave_direction", "secondary_swell_wave_height", "secondary_swell_wave_period", "secondary_swell_wave_direction", "wind_wave_height", "wind_wave_period", "wind_wave_direction"])
          add(`${m.short.toLowerCase()}_${v}`, marine.time, marine.get(v, m.id));
    if (!(wind instanceof Error))
      for (const m of WIND_MODELS) for (const v of ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"]) add(`${m.id}_${v}`, wind.time, wind.get(v, m.id));
    for (const w of p.wrf) { add(`cwa_${w.id}_wind_speed_10m`, w.t, w.speed); add(`cwa_${w.id}_wind_direction_10m`, w.t, w.dir); }
    if (tide) add("tide_m_interp", tide.t, tide.v.map((x) => +x.toFixed(3)));
    const times = [...new Set(cols.flatMap((c) => c.t))].sort((a, b) => a - b);
    const idx = cols.map((c) => new Map(c.t.map((t, i) => [t, c.v[i]])));
    const rows = times.map((t) => [new Date(t * 1000).toISOString(), ...idx.map((m) => m.get(t) ?? null)]);
    downloadText(`${p.spot.id}-${new Date().toISOString().slice(0, 13)}.csv`, toCsv(["time_utc", ...cols.map((c) => c.name)], rows));
  });
}

