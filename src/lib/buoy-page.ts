import type uPlot from "uplot";
import { renderChart, sec, type Series } from "./chart";
import { fetchMarine, fetchWind, partitioned, WAVE_MODELS, WIND_MODELS, km, type Grid } from "./openmeteo";
import { fmt, compass, taipeiTime } from "./format";
import { renderCompass } from "./compass";
import { renderTimeline, type Row } from "./timeline";
import { createMap, marker, conditionOverlay } from "./map";
import { PARTS, esc, legendHtml, slots, swIcon, windChip, windIcon, windKey } from "./ui";
import { HOUR, at, facesDeg, fetchSpotWind, nowS, obsTable, whenLabel, windState, type ObsFile, type Tone } from "./surf";
import { cwaUrl, getCwa, loadStations } from "./data";

type Payload = { id: string; name: string; lat: number; lon: number; wave: boolean; spots: { id: string; name: string; lat: number; lon: number; faces: string }[] };
type Obs = { columns: string[]; rows: (string | number | null)[][] };

const $ = (id: string) => document.getElementById(id)!;
const H = 3600;

type Panel = {
  col: string;
  title: string;
  unit: string;
  digits?: number;
  direction?: boolean;
  zero?: boolean;
  note?: string;
  /** Open-Meteo variable to overlay, if any. */
  wave?: string;
  wind?: string;
};

const PANELS: Panel[] = [
  { col: "wave_height_m", title: "Wave height", unit: "m", wave: "wave_height", note: "Significant wave height (Hs)." },
  { col: "wave_period_s", title: "Wave period", unit: "s", wave: "wave_period", note: "Mean period. Models: mean period too." },
  { col: "wave_dir_deg", title: "Wave direction", unit: "", direction: true, wave: "wave_direction", note: "Direction waves come from." },
  { col: "wind_speed_ms", title: "Wind speed", unit: "m/s", wind: "wind_speed_10m", note: "Buoy anemometer (~3–4 m above sea level) vs model 10 m wind, so models read a little high." },
  { col: "wind_dir_deg", title: "Wind direction", unit: "", direction: true, wind: "wind_direction_10m", note: "Direction wind comes from." },
  { col: "wind_gust_ms", title: "Wind gust", unit: "m/s" },
  { col: "sea_temp_c", title: "Water temperature", unit: "°C", digits: 1, zero: false },
  { col: "air_temp_c", title: "Air temperature", unit: "°C", digits: 1, zero: false },
  { col: "pressure_hpa", title: "Air pressure", unit: "hPa", digits: 1, zero: false },
  { col: "tide_height_m", title: "Tide height", unit: "m", digits: 2, zero: false, note: "Observed sea level, TWVD2001 datum." },
  { col: "current_speed_ms", title: "Surface current speed", unit: "m/s", digits: 2 },
  { col: "current_dir_deg", title: "Surface current direction", unit: "", direction: true, note: "Direction the current flows toward." },
];

export async function initBuoy(p: Payload) {
  // The hero map starts loading tiles while the data comes in.
  const hero = p.wave ? startHero(p) : null;
  // The station's archive size and status, from the live list.
  loadStations().then((list) => {
    const s = list.find((x) => x.id === p.id), l = s?.latest;
    $("archive").textContent = l ? `${l.archiveRows.toLocaleString("en")} hourly rows since ${l.archiveStart.slice(0, 10)}` : "Empty";
    if (s) $("status").textContent = s.active ? "Transmitting" : "Not transmitting (per O-B0076-001)";
  }).catch(() => ($("archive").textContent = "Unavailable"));
  let obs: Obs;
  try {
    obs = await getCwa<Obs>(`obs/${p.id}.json`);
  } catch {
    $("charts").innerHTML = `<p class="note">This station's readings are unavailable right now.</p>`;
    return;
  }
  const recent = obs;
  let t = obs.rows.map((r) => sec(String(r[0])));
  let fullLoaded = false;
  const col = (name: string) => {
    const i = obs.columns.indexOf(name);
    return obs.rows.map((r) => r[i] as number | null);
  };
  // The JSON holds the last 120 days; the whole archive is the CSV.
  async function loadFull() {
    if (fullLoaded) return;
    const text = await fetch(cwaUrl(`csv/${p.id}.csv`)).then((r) => r.text());
    const [header, ...lines] = text.trim().split("\n");
    const columns = header.split(",");
    const rows = lines.map((l) => l.split(",").map((v, i) => (i === 0 || columns[i] === "source" ? v : v === "" ? null : Number(v))));
    obs = { columns, rows };
    t = rows.map((r) => sec(String(r[0])));
    fullLoaded = true;
  }
  const panels = PANELS.filter((pn) => col(pn.col).some((v) => v != null));
  // Tide gauges: lead with the tide.
  if (!p.wave) panels.sort((a, b) => Number(b.col === "tide_height_m") - Number(a.col === "tide_height_m"));

  // Build the chart containers once.
  const host = $("charts");
  for (const pn of panels) {
    const section = document.createElement("section");
    section.className = "panel";
    const h = document.createElement("h2");
    h.textContent = pn.title;
    const src = document.createElement("p");
    src.className = "src";
    src.textContent = `CWA O-B0075, older rows backfilled from ocean.cwa.gov.tw (see the source column in the CSV) · ${p.id}${pn.note ? `. ${pn.note}` : ""}`;
    const plot = document.createElement("div");
    plot.className = "plot loading";
    plot.id = `c-${pn.col}`;
    section.append(h, src, plot);
    host.append(section);
  }
  renderRaw(obs);

  let marine: Grid | Error | null = null;
  let wind: Grid | Error | null = null;
  let days: number | "all" = 7;
  let showModels = p.wave;
  const charts: uPlot[] = [];

  function xWindow(): [number, number] {
    const now = Date.now() / 1000;
    const start = days === "all" ? t[0] : now - days * 24 * H;
    const end = showModels && marine && !(marine instanceof Error) ? now + 2 * 24 * H : now + 2 * H;
    return [start, end];
  }

  function draw() {
    charts.splice(0).forEach((c) => c.destroy());
    const [xMin, xMax] = xWindow();
    for (const pn of panels) {
      const series: Series[] = [{ label: `Observed ${p.id}`, color: "--s1", t, v: col(pn.col), width: 2.5 }];
      if (showModels && pn.wave && marine && !(marine instanceof Error)) {
        const g = marine;
        for (const m of WAVE_MODELS) if (g.has(pn.wave, m.id)) series.push({ label: m.short, color: m.color, t: g.time, v: g.get(pn.wave, m.id), width: 1.5 });
      }
      if (showModels && pn.wind && wind && !(wind instanceof Error)) {
        const g = wind;
        for (const m of WIND_MODELS) series.push({ label: m.short, color: m.color, t: g.time, v: g.get(pn.wind, m.id), width: 1.5 });
      }
      const c = renderChart($(`c-${pn.col}`), { xMin, xMax, unit: pn.unit, digits: pn.digits, direction: pn.direction, zero: pn.zero, series, height: pn.direction ? 200 : 240 });
      if (c) charts.push(c);
    }
    if (p.wave) renderSkill(xMin);
  }

  function renderSkill(from: number) {
    const el = $("skill");
    if (!marine || marine instanceof Error) {
      el.textContent = marine instanceof Error ? `Open-Meteo request failed: ${marine.message}` : "Loading models…";
      return;
    }
    const g = marine;
    const now = Date.now() / 1000;
    const hs = new Map(t.map((ts, i) => [ts, col("wave_height_m")[i]]));
    const tp = new Map(t.map((ts, i) => [ts, col("wave_period_s")[i]]));
    const rows = WAVE_MODELS.filter((m) => g.has("wave_height", m.id)).map((m) => {
      const mh = g.get("wave_height", m.id), mt = g.get("wave_period", m.id);
      const pairs: [number, number][] = [], tpairs: [number, number][] = [];
      g.time.forEach((ts, i) => {
        if (ts < from || ts > now) return;
        const o = hs.get(ts), v = mh[i];
        if (o != null && v != null) pairs.push([o, v]);
        const ot = tp.get(ts), vt = mt[i];
        if (ot != null && vt != null) tpairs.push([ot, vt]);
      });
      return { m, ...stats(pairs), tBias: stats(tpairs).bias };
    });
    const table = document.createElement("table");
    table.className = "data";
    table.innerHTML = "<thead><tr><th>Model</th><th>Hours matched</th><th>Bias (model − buoy)</th><th>RMSE</th><th>Correlation</th><th>Mean buoy Hs</th><th>Period bias</th></tr></thead>";
    const tb = document.createElement("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      const cells = [r.m.label, String(r.n), r.n ? `${r.bias >= 0 ? "+" : ""}${fmt(r.bias, 2)} m (${r.pct >= 0 ? "+" : ""}${fmt(r.pct, 0)}%)` : "–", r.n ? fmt(r.rmse, 2, " m") : "–", r.n > 2 ? fmt(r.r, 2) : "–", r.n ? fmt(r.meanObs, 2, " m") : "–", r.n ? `${r.tBias >= 0 ? "+" : ""}${fmt(r.tBias, 1)} s` : "–"];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.append(td);
      }
      tb.append(tr);
    }
    table.append(tb);
    const note = document.createElement("p");
    note.className = "faint";
    const cells = WAVE_MODELS.filter((m) => g.cells[m.id]).map((m) => `${m.short} ${km(p.lat, p.lon, g.cells[m.id].lat, g.cells[m.id].lon).toFixed(1)} km`);
    note.textContent = `Distance from the buoy to each model's grid cell: ${cells.join(", ")}. Window ${taipeiTime(Math.max(from, g.time[0]) * 1000)} to now.`;
    el.replaceChildren(table, note);
  }

  draw();

  if (p.wave) {
    [marine, wind] = await Promise.all([
      fetchMarine(p.lat, p.lon, 92, 3).catch((e: Error) => e),
      fetchWind(p.lat, p.lon, 92, 3).catch((e: Error) => e),
    ]);
    draw();
    hero?.(recent, marine);
    $("models").addEventListener("change", (e) => {
      showModels = (e.target as HTMLInputElement).checked;
      draw();
    });
  }

  $("range").addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    days = b.dataset.days === "all" ? "all" : Number(b.dataset.days);
    $("range").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (days === "all") await loadFull();
    draw();
  });
}

function stats(pairs: [number, number][]) {
  const n = pairs.length;
  if (!n) return { n, bias: NaN, pct: NaN, rmse: NaN, r: NaN, meanObs: NaN };
  const mo = pairs.reduce((a, p) => a + p[0], 0) / n;
  const mm = pairs.reduce((a, p) => a + p[1], 0) / n;
  let se = 0, cov = 0, vo = 0, vm = 0;
  for (const [o, m] of pairs) {
    se += (m - o) ** 2;
    cov += (o - mo) * (m - mm);
    vo += (o - mo) ** 2;
    vm += (m - mm) ** 2;
  }
  return { n, bias: mm - mo, pct: ((mm - mo) / mo) * 100, rmse: Math.sqrt(se / n), r: cov / Math.sqrt(vo * vm), meanObs: mo };
}

function renderRaw(obs: Obs) {
  const rows = obs.rows.slice(-48).reverse();
  const keep = obs.columns.map((_, i) => i).filter((i) => i === 0 || rows.some((r) => r[i] != null));
  const table = document.createElement("table");
  table.className = "data";
  const head = document.createElement("tr");
  for (const i of keep) {
    const th = document.createElement("th");
    th.textContent = obs.columns[i];
    head.append(th);
  }
  table.createTHead().append(head);
  const tb = table.createTBody();
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const i of keep) {
      const td = document.createElement("td");
      td.textContent = i === 0 ? taipeiTime(String(r[0])) : r[i] == null ? "–" : String(r[i]);
      tr.append(td);
    }
    tb.append(tr);
  }
  $("raw").replaceChildren(table);
}

/**
 * The top of a wave buoy's page: measured readout, compass, map and a six-day timeline.
 * Starts the map and the wind request right away; call the returned function with the
 * observations and the marine models once they're in.
 */
function startHero(p: Payload) {
  const now = nowS();
  const ref = p.spots[0];
  const faces = ref ? facesDeg(ref.faces) : null;
  const R = slots($("readout"));
  const map = createMap($("map"), { center: [p.lon, p.lat], zoom: 9.2, minZoom: 6, cooperative: true });
  const overlay = conditionOverlay(map, [p.lon, p.lat]);
  for (const s of p.spots) marker(map, [s.lon, s.lat], `<span>${esc(s.name.replace(/ \(.*\)$/, ""))}</span>`, "map-tag tag-spot", `/spots/${s.id}/`);
  const windReq = fetchSpotWind(p.lat, p.lon, { past: 7, days: 2 }).catch(() => null);

  return async (obsFile: ObsFile, marine: Grid | Error | null) => {
    const wind = await windReq;
    const sea = marine ? partitioned(marine) : null;
    const obs = obsTable(obsFile)!;
    const C = (n: string) => obs.col(n);
    const hasObsWind = C("wind_speed_ms").some((v) => v != null);
    const t0 = now - 6 * 24 * HOUR, t1 = now + 12 * HOUR;
    const lastObs = obs.t.findLast((_, i) => C("wave_height_m")[i] != null) ?? now;

    const windAt = (ts: number) => {
      if (hasObsWind && ts <= lastObs + HOUR) {
        const dir = at(obs.t, C("wind_dir_deg"), ts), speed = at(obs.t, C("wind_speed_ms"), ts);
        return { dir, speed, gust: at(obs.t, C("wind_gust_ms"), ts), ...windState(dir, speed, faces), src: "measured at the buoy" };
      }
      if (!wind) return null;
      const dir = at(wind.time, wind.wind_direction_10m, ts), speed = at(wind.time, wind.wind_speed_10m, ts);
      return { dir, speed, gust: at(wind.time, wind.wind_gusts_10m, ts), ...windState(dir, speed, faces), src: "ECMWF model, no anemometer" };
    };
    const partsAt = (ts: number) => PARTS.map((x) => ({ ...x, h: sea ? at(sea.time, sea.get(`${x.key}_height`), ts) : null, dir: sea ? at(sea.time, sea.get(`${x.key}_direction`), ts) : null, period: sea ? at(sea.time, sea.get(`${x.key}_period`), ts) : null }));

    function show(tsIn: number | null) {
      const ts = tsIn ?? lastObs;
      const measured = ts <= lastObs + HOUR;
      const hs = measured ? at(obs.t, C("wave_height_m"), ts) : null, tp = measured ? at(obs.t, C("wave_period_s"), ts) : null, dir = measured ? at(obs.t, C("wave_dir_deg"), ts) : null;
      const parts = partsAt(ts), w = windAt(ts);
      R.text("kind", tsIn == null ? "Latest reading" : measured ? "Measured" : "Model only");
      R.text("when", whenLabel(ts));
      R.text("ms-hs", fmt(hs));
      R.text("ms-src", measured ? `${p.name} buoy` : "After the last reading");
      R.text("fc-hs", fmt(sea ? at(sea.time, sea.get("wave_height"), ts) : null));
      R.text("fc-src", sea ? `${sea.label}, same spot` : "Model unavailable");
      R.text("note", "");
      R.text("waves", hs != null ? `${fmt(tp)} s from ${compass(dir)}` : "No reading");
      R.text("waves-sub", hs != null ? "Mean period, measured" : "");
      parts.forEach((x, i) => {
        R.text(`sw${i + 1}`, x.h != null && x.h >= 0.1 ? `${fmt(x.h)} m at ${fmt(x.period, 0)} s from ${compass(x.dir)}` : "None to speak of");
        R.text(`sw${i + 1}-sub`, "Model");
      });
      R.html("wind", windChip(w));
      R.text("wind-sub", w ? `${w.gust != null ? `Gusts ${fmt(w.gust)}, ` : ""}${w.src}` : "");
      const temp = measured ? at(obs.t, C("sea_temp_c"), ts, 3 * HOUR) : null;
      R.text("water", temp != null ? `${fmt(temp)} °C` : "–");
      R.text("water-sub", temp != null ? "Measured" : "");
      const swells = [{ dir, h: hs, cls: "obs", name: "Waves", period: tp }, ...parts.map((x) => ({ dir: x.dir, h: x.h, period: x.period, cls: x.cls, name: x.name }))];
      renderCompass($("rose"), { faces: null, swells, wind: w, label: `Measured waves from ${compass(dir)}${w ? `, wind from ${compass(w.dir)}` : ""}` });
      overlay.update({ swells: swells.slice(0, 2), wind: w });
    }
    show(null);

    function tip(ts: number, el: HTMLElement) {
      const measured = ts <= lastObs + HOUR;
      const hs = measured ? at(obs.t, C("wave_height_m"), ts) : sea ? at(sea.time, sea.get("wave_height"), ts) : null;
      const dir = measured ? at(obs.t, C("wave_dir_deg"), ts) : null, tp = measured ? at(obs.t, C("wave_period_s"), ts) : null;
      const w = windAt(ts);
      el.innerHTML = `<div class="tip-rose"></div><div>
        <div class="tip-line">${whenLabel(ts)}, ${measured ? "measured" : "model"}</div>
        <div class="tip-hs">${fmt(hs)}<small>m</small></div>
        ${dir != null ? `<div class="tip-line">${swIcon("obs")}${fmt(tp)} s from ${compass(dir)}</div>` : ""}
        <div class="tip-line">${windIcon}${windChip(w)}</div>
      </div>`;
      renderCompass(el.firstElementChild!, { faces: null, swells: [{ dir, h: hs, cls: "obs" }], wind: w, label: "" });
    }

    $("legend").innerHTML = legendHtml([
      ["obs", "Buoy, measured"],
      ...(sea ? [["tl-total", `Total sea, ${sea.label} model`, "area"] as [string, string, string], ...PARTS.map((x): [string, string] => [x.cls, `${x.label}, model`])] : []),
    ]) + (faces != null ? windKey(true) : "");

    const rows: Row[] = [{
      kind: "height", label: "Wave height", h: 168,
      total: sea ? { t: sea.time, v: sea.get("wave_height") } : null,
      parts: [...(sea ? PARTS.map((x) => ({ t: sea.time, v: sea.get(`${x.key}_height`), cls: `${x.cls} faint` })) : []), { t: obs.t, v: C("wave_height_m"), cls: "obs" }],
      obs: { t: obs.t, v: C("wave_height_m") },
    }, {
      kind: "arrows", label: "Wave direction", h: sea ? 52 : 30,
      series: [{ t: obs.t, dir: C("wave_dir_deg"), h: C("wave_height_m"), cls: "obs", short: "Buoy" }, ...(sea ? [{ t: sea.time, dir: sea.get("swell_wave_direction"), h: sea.get("swell_wave_height"), cls: "p1", short: "Swell" }] : [])],
    }];
    const wsrc = hasObsWind
      ? { t: obs.t, speed: C("wind_speed_ms"), gust: C("wind_gust_ms"), dir: C("wind_dir_deg"), label: "Wind, measured" }
      : wind ? { t: wind.time, speed: wind.wind_speed_10m, gust: wind.wind_gusts_10m, dir: wind.wind_direction_10m, label: "Wind, ECMWF model (no anemometer)" } : null;
    if (wsrc) rows.push({ kind: "wind", h: 86, ...wsrc, tone: (i): Tone => (faces == null ? "none" : windState(wsrc.dir[i], wsrc.speed[i], faces).tone) });
    if (C("sea_temp_c").some((v) => v != null)) rows.push({ kind: "line", label: "Water temperature", unit: "°", h: 44, series: [{ t: obs.t, v: C("sea_temp_c"), cls: "obs" }] });
    if (C("tide_height_m").some((v) => v != null)) rows.push({ kind: "tide", label: "Sea level, measured", h: 56, t: obs.t, v: C("tide_height_m"), events: [] });
    renderTimeline($("timeline"), { t0, t1, now, sun: wind?.sun ?? [], rows, onScrub: show, tip });
  };
}
