// Page builders shared by every direction. Each direction's HTML is a thin shell that
// loads its own theme.css and calls one of these, so the information architecture is
// identical across directions and only the visual language changes.
import * as D from "./data.js";
import { renderCompass } from "./compass.js";
import { renderTimeline } from "./timeline.js";
import { createMap, marker, spotCallouts, conditionOverlay, windGlyph, esc } from "./map.js";

const H = D.HOUR;
const app = () => document.getElementById("app");
const q = (k) => new URLSearchParams(location.search).get(k);
const $ = (sel, root = document) => root.querySelector(sel);

export const DIRECTIONS = [
  { id: "riso-almanac", name: "Riso almanac" },
  { id: "tide-calendar", name: "Tide calendar" },
];
const current = location.pathname.split("/")[1];

// Wind waves (local chop) are left out on purpose: they're inside the total-sea number,
// and as a separate line they mostly added noise.
export const PARTS = [
  { key: "swell_wave", cls: "p1", label: "Swell", name: "Swell", short: "Swell" },
  { key: "secondary_swell_wave", cls: "p2", label: "2nd swell", name: "2nd swell", short: "2nd" },
];

const cleanName = (s) => s.replace(/ (Data )?Buoy$/i, "").replace(/ Buoy Station$/i, "");

// ---------- chrome ----------

function chrome(active, meta) {
  const nav = [["./", "Now", "now"], ["buoy.html?id=46708A", "Buoys", "buoys"], ["https://swell.fyi/research/", "Data sources", "src"]];
  const fetched = meta?.fetchedAt ? `CWA data ${D.relTime(Date.parse(meta.fetchedAt) / 1000)}` : "";
  const here = location.pathname.split("/").pop() + location.search;
  return `
  <header class="site">
    <div class="wrap bar">
      <a class="brand" href="./"><span class="brand-mark" aria-hidden="true"></span><span class="brand-en">Taiwan Waves</span><span class="brand-zh" lang="zh-Hant">台灣浪況</span></a>
      <nav aria-label="Main">${nav.map(([h, l, k]) => `<a href="${h}"${k === active ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav>
      <p class="fresh">${fetched}</p>
    </div>
  </header>
  <nav class="dz-switch" aria-label="Design direction">
    <span>Direction</span>${DIRECTIONS.map((d) => `<a href="/${d.id}/${here}"${d.id === current ? ' aria-current="true"' : ""}>${d.name}</a>`).join("")}<a href="/">All</a>
  </nav>`;
}

function footer() {
  return `<footer class="site-foot wrap"><p>Observations, tides and the recreation forecast come from the Central Weather Administration (中央氣象署) open data. Model forecasts are from Open-Meteo (CC BY 4.0): Météo-France MFWAM for sea state and swell partitions, ECMWF IFS for wind. Map: Protomaps, © OpenStreetMap contributors; depth from NOAA ETOPO 2022. Times are Taiwan time.</p></footer>`;
}

const toneLabel = { good: "Offshore or light", fair: "Cross-shore", poor: "Onshore" };
export const windKey = (gust = false) => `<ul class="wind-key">${["good", "fair", "poor"].map((t) => `<li><i class="sw t-${t}"></i>${toneLabel[t]}</li>`).join("")}${gust ? `<li><i class="lg lg-gust"></i>Wind, pale top is gusts</li>` : ""}</ul>`;
const arrowSvg = (from, size = 14) => (from == null ? "" : `<svg class="dir-arrow" viewBox="-8 -8 16 16" width="${size}" height="${size}" style="transform:rotate(${(from + 180) % 360}deg)" aria-hidden="true"><path d="M0 -7 L5 4 L0 1.5 L-5 4 Z"/></svg>`);

export function sparkline(points, yMax, w = 132, h = 30) {
  const pts = points.filter(([, v]) => v != null);
  if (pts.length < 2) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
  const t0 = points[0][0], t1 = points[points.length - 1][0];
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * (w - 4) + 2, y = (v) => h - 3 - (v / yMax) * (h - 6);
  let d = "", pen = false;
  for (const [t, v] of points) { if (v == null) { pen = false; continue; } d += `${pen ? "L" : "M"}${x(t).toFixed(1)} ${y(v).toFixed(1)}`; pen = true; }
  const [lt, lv] = pts[pts.length - 1];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><line class="spark-base" x1="0" x2="${w}" y1="${h - 3}" y2="${h - 3}"/><path d="${d}"/><circle cx="${x(lt).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="2.5"/></svg>`;
}

/** 3-day strip: one bar per 3 h, height = wave height, color = wind at the beach. */
export function strip(rows, toneAt, yMax, now) {
  const w = 168, h = 34, n = rows.length;
  if (!n) return "";
  const bw = w / n;
  const out = [];
  rows.forEach(([ts, hs], i) => {
    if (hs == null) return;
    const bh = Math.max(2, Math.min(1, hs / yMax) * (h - 6));
    out.push(`<rect class="t-${toneAt(ts)}" x="${(i * bw + 0.6).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 1.2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"/>`);
    if (D.hour(ts) < 3 && i > 0) out.push(`<line class="strip-day" x1="${(i * bw).toFixed(1)}" x2="${(i * bw).toFixed(1)}" y1="0" y2="${h}"/>`);
  });
  return `<svg class="strip" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${out.join("")}</svg>`;
}

// ---------- home ----------

export async function home() {
  const [{ spots, regions }, stations, rec, meta] = await Promise.all([D.loadSpots(), D.loadStations(), D.loadRecreation(), D.loadMeta()]);
  const byId = new Map(stations.map((s) => [s.id, s]));
  const now = D.nowS();
  const EAST = ["46694A", "OAC005", "46708A", "46706A", "46699A", "46761F", "WRA007", "C6S94", "46759A"];
  const east = EAST.map((id) => byId.get(id)).filter(Boolean);
  const fresh = (s) => s.latest && now - Date.parse(s.latest.time) / 1000 < 3 * H;

  const cwaRows = (s) => (rec?.points[s.cwaPoint]?.rows ?? []).map((r) => [Date.parse(r[0]) / 1000, r[1], r[2], r[3]]).filter(([t]) => t >= now - 3 * H);
  const yMax = Math.max(1.5, ...spots.flatMap((s) => cwaRows(s).map((r) => r[1] ?? 0)));

  app().innerHTML = `${chrome("now", meta)}
  <main class="wrap home">
    <section class="home-intro">
      <h1>Taiwan's coast, right now</h1>
      <p class="lede">Surf spots up front, with CWA's 3-day forecast and the wind at each beach. Buoys underneath show what the ocean is actually doing.</p>
    </section>
    <section class="home-grid">
      <figure class="map-frame home-map">
        <div id="map" class="map" aria-label="Map of surf spots and wave buoys"></div>
        <figcaption class="map-key"><span><i class="key-spot"></i>Surf spot, next 24 h peak</span><span><i class="key-buoy"></i>Buoy, measured now</span></figcaption>
      </figure>
      <div class="spots-panel">
        <div class="panel-head"><h2>Surf spots</h2>${windKey()}</div>
        <p class="note">Bars run 3 days, one per 3 hours: height is CWA's wave forecast, color is ECMWF wind relative to the beach.</p>
        <div class="regions">
          ${regions.map((r) => `
            <div class="region"><h3>${r}</h3><ul>
              ${spots.filter((s) => s.region === r).map((s) => {
                const rows = cwaRows(s);
                const next = rows.filter(([t]) => t <= now + 24 * H);
                const peak = next.reduce((a, r) => ((r[1] ?? -1) > (a?.[1] ?? -1) ? r : a), null);
                return `<li><a class="spot-row" href="spot.html?id=${s.id}" data-spot="${s.id}">
                  <span class="nm"><span class="en">${esc(s.name)}</span> <span class="zh" lang="zh-Hant">${esc(s.nameZh)}</span></span>
                  <span class="hs">${peak ? `${D.fmt(peak[1])}<small>m</small>` : "–"}</span>
                  <span class="wind-chip t-none" data-chip>…</span>
                  <span class="strip-wrap" data-strip>${strip(rows.map((r) => [r[0], r[1]]), () => "none", yMax, now)}</span>
                </a></li>`;
              }).join("")}
            </ul></div>`).join("")}
        </div>
      </div>
    </section>
    <section class="buoys-panel">
      <div class="panel-head"><h2>East coast buoys</h2><p class="note">North to south. Measured by CWA every hour. The line is the last 72 hours, on one scale for every buoy.</p></div>
      <ol class="buoy-list">
        ${east.map((s) => {
          const v = s.latest?.values ?? {};
          const ok = fresh(s);
          return `<li><a class="buoy-row${ok ? "" : " stale"}" href="buoy.html?id=${s.id}">
            <span class="nm"><span class="en">${esc(cleanName(s.nameEn))}</span> <span class="zh" lang="zh-Hant">${esc(s.name.replace(/(資料)?浮標$|浮球式波浪站$/, ""))}</span></span>
            <span class="hs">${ok ? D.fmt(v.wave_height_m) : "–"}<small>m</small></span>
            <span class="tp">${ok ? D.fmt(v.wave_period_s) : "–"}<small>s</small></span>
            <span class="dir">${ok ? `${arrowSvg(v.wave_dir_deg)}<span>${D.compass(v.wave_dir_deg)}</span>` : ""}</span>
            <span class="sp" data-spark="${s.id}"></span>
            <span class="meta">${!s.latest ? "No data" : ok ? (v.sea_temp_c != null ? `${D.fmt(v.sea_temp_c)} °C water` : "") : `${Math.round((now - Date.parse(s.latest.time) / 1000) / H)} h old`}</span>
          </a></li>`;
        }).join("")}
      </ol>
      <p class="more"><a href="buoy.html?id=46708A">All ${stations.filter((s) => s.observes.includes("WaveHeight")).length} wave stations</a></p>
    </section>
  </main>${footer()}`;

  // Sparklines from each buoy's obs file.
  Promise.all(east.map((s) => D.loadObs(s.id))).then((files) => {
    const series = files.map((o) => { const t = D.obsTable(o); if (!t) return []; const hs = t.col("wave_height_m"); return t.t.map((ts, i) => [ts, hs[i]]).filter(([ts]) => ts >= now - 72 * H); });
    const max = Math.max(1, ...series.flat().map((p) => p[1] ?? 0));
    east.forEach((s, i) => { const el = $(`[data-spark="${s.id}"]`); if (el) el.innerHTML = sparkline(series[i], max); });
  });

  // Map: spots as callouts pushed out to sea, buoys as small measured dots.
  const map = createMap($("#map"), { center: [120.95, 23.6], zoom: 6.55, cooperative: false });
  map.on("load", () => {
    for (const s of stations.filter((s) => s.observes.includes("WaveHeight") || s.latest?.values.wave_height_m != null)) {
      const ok = fresh(s), v = s.latest?.values ?? {};
      const el = marker(map, [s.lon, s.lat], `<span>${ok && v.wave_height_m != null ? D.fmt(v.wave_height_m) : ""}</span>${ok ? arrowSvg(v.wave_dir_deg, 11) : ""}`, `buoy-dot${ok && v.wave_height_m != null ? "" : " stale"}`, `buoy.html?id=${s.id}`);
      el.title = `${cleanName(s.nameEn)}: ${ok && v.wave_height_m != null ? `${D.fmt(v.wave_height_m)} m, ${D.fmt(v.wave_period_s)} s from ${D.compass(v.wave_dir_deg)}` : "no current reading"}`;
    }
  });
  const callouts = spotCallouts(map, spots.map((s) => {
    const next = cwaRows(s).filter(([t]) => t <= now + 24 * H);
    const peak = next.reduce((a, r) => ((r[1] ?? -1) > (a?.[1] ?? -1) ? r : a), null);
    return { id: s.id, lat: s.lat, lon: s.lon, side: s.lon < 120.8 ? "west" : "east", href: `spot.html?id=${s.id}`, html: `<span class="co-name">${esc(s.name.replace(/ \(.*\)$/, "").replace(/ \/ .*/, ""))}</span><span class="co-val">${peak ? D.fmt(peak[1]) : "–"}</span><i class="co-tone t-none" data-tone="${s.id}"></i>` };
  }));

  // Wind at every spot in one request, then colour the strips, chips and callouts.
  try {
    const pts = await D.fetchMany(spots.map((s) => [s.lat, s.lon]));
    spots.forEach((s, i) => {
      const w = pts[i]?.wind;
      if (!w) return;
      const faces = D.facesDeg(s.faces);
      const toneAt = (ts) => { const dir = D.at(w.time, w.wind_direction_10m, ts), sp = D.at(w.time, w.wind_speed_10m, ts); return D.windState(dir, sp, faces).tone; };
      const row = $(`[data-spot="${s.id}"]`);
      $("[data-strip]", row).innerHTML = strip(cwaRows(s).map((r) => [r[0], r[1]]), toneAt, yMax, now);
      const ws = D.windState(D.at(w.time, w.wind_direction_10m, now), D.at(w.time, w.wind_speed_10m, now), faces);
      const chip = $("[data-chip]", row);
      chip.className = `wind-chip t-${ws.tone}`;
      chip.textContent = ws.label;
      const tone = $(`[data-tone="${s.id}"]`);
      if (tone) { tone.className = `co-tone t-${ws.tone}`; tone.title = `Wind now: ${ws.label}`; }
    });
  } catch (e) {
    document.querySelectorAll("[data-chip]").forEach((c) => (c.textContent = "Wind unavailable"));
  }
  callouts.layout();
}

// ---------- shared detail-page pieces ----------

// The readout is built once and then only its text changes, so scrubbing never changes its
// size (no layout shift) and screen readers aren't flooded on every mouse move.
export const windIcon = `<svg class="wind-icon" width="22" height="14" viewBox="0 0 22 14" aria-hidden="true"><path class="m-wind-casing" d="${windGlyph([3, 7], [20, 7], 15, 0.7)}"/><path class="m-wind" d="${windGlyph([3, 7], [20, 7], 15, 0.7)}"/></svg>`;
export const swIcon = (cls) => `<i class="sw ${cls}"></i>`;

export function readoutShell({ measuredLabel = "Measured", forecastLabel = "Forecast", primary = "forecast", rows }) {
  const col = (k, label) => `<div class="ro-col ro-${k}"><p class="ro-label">${label}</p><div class="ro-big"><span class="ro-hs" data-k="${k}-hs">–</span><span class="ro-unit">m</span></div><p class="ro-src" data-k="${k}-src">&nbsp;</p></div>`;
  const cols = primary === "forecast" ? col("fc", forecastLabel) + col("ms", measuredLabel) : col("ms", measuredLabel) + col("fc", forecastLabel);
  return `
    <p class="ro-when"><span class="ro-kind" data-k="kind">&nbsp;</span> <span data-k="when"></span></p>
    <div class="ro-pair">${cols}</div>
    <p class="ro-note" data-k="note">&nbsp;</p>
    <dl class="ro-list">
      ${rows.map(([k, icon, label]) => `<div class="ro-item" data-row="${k}"><dt>${icon}${label}</dt><dd><span class="ro-main" data-k="${k}">–</span><span class="ro-sub2" data-k="${k}-sub">&nbsp;</span></dd></div>`).join("")}
    </dl>`;
}

export function slots(root) {
  const map = new Map([...root.querySelectorAll("[data-k]")].map((n) => [n.dataset.k, n]));
  return {
    text: (k, v) => { const n = map.get(k); if (n) n.textContent = v == null || v === "" ? " " : v; },
    html: (k, v) => { const n = map.get(k); if (n) n.innerHTML = v || "&nbsp;"; },
  };
}

export function legendHtml(items) {
  return `<ul class="legend">${items.map(([cls, label, kind = "line"]) => `<li><i class="lg lg-${kind} ${cls}"></i>${label}</li>`).join("")}</ul>`;
}

export const glyphKey = `<ul class="glyph-key"><li>${swIcon("p1")}Swell</li><li>${swIcon("p2")}2nd swell</li><li>${windIcon}Wind, barbs = 10 kt</li></ul>`;
export const windChip = (w) => (w?.speed == null ? "No wind data" : `<span class="wind-chip t-${w.tone}">${w.label}</span> ${D.fmt(w.speed)} m/s from ${D.compass(w.dir)}`);

export function tideAt(tide, ts) {
  if (!tide) return ["–", "No tide forecast nearby"];
  const h0 = D.lerp(tide.t, tide.v, ts), h1 = D.lerp(tide.t, tide.v, ts + 1800);
  const hi = tide.events.find((e) => e.t > ts && e.kind === "high"), lo = tide.events.find((e) => e.t > ts && e.kind === "low");
  const when = (e) => (e ? `${D.localMidnight(e.t) !== D.localMidnight(ts) ? `${D.dayName(e.t)} ` : ""}${D.hhmm(e.t)}` : "–");
  return [h0 == null ? "–" : `${h0 >= 0 ? "+" : ""}${D.fmt(h0)} m, ${h1 > h0 ? "rising" : "falling"}`, `Next high ${when(hi)}, low ${when(lo)}`];
}

// ---------- spot ----------

export async function spot() {
  const id = q("id") ?? "jinzun";
  const [{ spots }, stations, rec, tides, meta] = await Promise.all([D.loadSpots(), D.loadStations(), D.loadRecreation(), D.loadTides(), D.loadMeta()]);
  const s = spots.find((x) => x.id === id) ?? spots[0];
  document.title = `${s.name} · Taiwan Waves`;
  const now = D.nowS();
  const faces = D.facesDeg(s.faces);
  const point = rec?.points[s.cwaPoint];
  const buoy = s.buoys.map((b) => stations.find((x) => x.id === b)).find((x) => x?.latest?.values.wave_height_m != null && now - Date.parse(x.latest.time) / 1000 < 12 * H);
  const tideLoc = D.nearestTide(tides, s.lat, s.lon);
  const tide = tideLoc ? D.tideCurve(tideLoc.events) : null;
  const buoyKm = buoy ? D.km(s.lat, s.lon, buoy.lat, buoy.lon) : null;
  const buoyName = buoy ? cleanName(buoy.nameEn) : null;

  app().innerHTML = `${chrome("now", meta)}
  <main class="wrap detail spot">
    <p class="crumb"><a href="./">Now</a> / ${esc(s.region)}</p>
    <section class="detail-head">
      <h1><span class="en">${esc(s.name)}</span> <span class="zh" lang="zh-Hant">${esc(s.nameZh)}</span></h1>
      <p class="facts">The beach faces ${D.compassWord(faces)}.${buoy ? ` Nearest working buoy: <a href="buoy.html?id=${buoy.id}">${esc(buoyName)}</a>, ${buoyKm.toFixed(0)} km away.` : ""} ${s.notes ? esc(s.notes) : ""}</p>
    </section>
    <section class="detail-now">
      <div class="readout" id="readout">${readoutShell({
        forecastLabel: "Forecast", measuredLabel: "Measured",
        rows: [["sw1", swIcon("p1"), "Swell"], ["sw2", swIcon("p2"), "2nd swell"], ["wind", windIcon, "Wind"], ["tide", "", "Tide"], ["water", "", "Water"]],
      })}</div>
      <figure class="rose-frame"><div class="rose" id="rose"></div><figcaption>${glyphKey}<span>Shaded: directions swell can reach this beach from.</span></figcaption></figure>
      <figure class="map-frame detail-map"><div id="map" class="map" aria-label="Map of ${esc(s.name)} with swell and wind"></div></figure>
    </section>
    <section class="detail-timeline">
      <div class="panel-head"><h2>Next six days</h2><p class="note">Hover or tap to scrub; the readout, compass and map follow. Arrow keys step by the hour.</p></div>
      <div id="legend"></div>
      <div class="timeline-scroll"><div id="timeline" class="timeline"></div></div>
    </section>
    <section class="detail-sources" id="sources"></section>
  </main>${footer()}`;

  const R = slots($("#readout"));
  const map = createMap($("#map"), { center: [s.lon, s.lat], zoom: 10.6, minZoom: 7, cooperative: true });
  const overlay = conditionOverlay(map, [s.lon, s.lat]);
  if (buoy) marker(map, [buoy.lon, buoy.lat], `<span>${esc(buoyName)} buoy</span>`, "map-tag tag-buoy", `buoy.html?id=${buoy.id}`);
  marker(map, [s.lon, s.lat], `<span>${esc(s.name.replace(/ \(.*\)$/, ""))}</span>`, "map-tag tag-spot");

  const [sea, wind, obsFile, sst] = await Promise.all([
    D.fetchSea(s.model[0], s.model[1], { past: 1, days: 7 }).catch((e) => e),
    D.fetchWind(s.lat, s.lon, { past: 1, days: 7 }).catch((e) => e),
    buoy ? D.loadObs(buoy.id) : Promise.resolve(null),
    D.fetchSST(s.model[0], s.model[1]).catch(() => null),
  ]);
  const seaOk = !(sea instanceof Error), windOk = !(wind instanceof Error);
  const obs = D.obsTable(obsFile);
  const lastObs = obs ? obs.t.findLast((t, i) => obs.col("wave_height_m")[i] != null) : null;
  const t0 = now - 24 * H, t1 = now + 6 * 24 * H;

  const conditions = (ts) => {
    const parts = PARTS.map((p) => {
      const h = seaOk ? D.at(sea.time, sea[`${p.key}_height`], ts) : null, dir = seaOk ? D.at(sea.time, sea[`${p.key}_direction`], ts) : null;
      const exposure = D.swellExposure(dir, faces);
      return { ...p, h, dir, period: seaOk ? D.at(sea.time, sea[`${p.key}_period`], ts) : null, exposure, blocked: exposure === "blocked" };
    });
    let w = null;
    if (windOk) {
      const dir = D.at(wind.time, wind.wind_direction_10m, ts), speed = D.at(wind.time, wind.wind_speed_10m, ts);
      w = { dir, speed, gust: D.at(wind.time, wind.wind_gusts_10m, ts), ...D.windState(dir, speed, faces) };
    }
    return { parts, w, hs: seaOk ? D.at(sea.time, sea.wave_height, ts) : null };
  };
  // The model's number is open-ocean sea state. When the swell can't reach the beach, say so.
  const note = (parts) => {
    const big = parts.filter((p) => p.h != null && p.h >= 0.2);
    if (!big.length) return "";
    if (big.every((p) => p.blocked)) return "Swell is blocked here. Expect much smaller surf.";
    if (big.every((p) => p.blocked || p.exposure === "wrapping")) return "Swell only wraps in. Expect smaller surf.";
    return "";
  };
  const roseSwells = (parts) => parts.map((p) => ({ dir: p.dir, h: p.h, period: p.period, cls: p.cls, name: p.name, blocked: p.blocked }));

  function show(tsIn) {
    const ts = tsIn ?? Math.round(now / H) * H;
    const { parts, w, hs } = conditions(ts);
    R.text("kind", tsIn == null ? "Right now" : ts < now ? "Earlier" : "Forecast for");
    R.text("when", D.whenLabel(ts));
    R.text("fc-hs", D.fmt(hs));
    R.text("fc-src", seaOk ? `${sea.label} model, total sea offshore` : "Model unavailable");
    if (obs) {
      const past = ts <= lastObs + H;
      const bt = past ? ts : lastObs;
      R.text("ms-hs", D.fmt(D.at(obs.t, obs.col("wave_height_m"), bt, 2 * H)));
      R.text("ms-src", past ? `${buoyName} buoy, ${D.hhmm(bt)}` : `${buoyName}, latest ${D.hhmm(bt)}`);
    } else { R.text("ms-hs", "–"); R.text("ms-src", "No working buoy nearby"); }
    R.text("note", note(parts));
    parts.forEach((p, i) => {
      R.text(`sw${i + 1}`, p.h != null && p.h >= 0.1 ? `${D.fmt(p.h)} m at ${D.fmt(p.period, 0)} s from ${D.compass(p.dir)}` : "None to speak of");
      R.text(`sw${i + 1}-sub`, p.h != null && p.h >= 0.1 ? (p.blocked ? "Blocked by the coast" : p.exposure[0].toUpperCase() + p.exposure.slice(1)) : "");
    });
    R.html("wind", windChip(w));
    R.text("wind-sub", w?.gust != null ? `Gusts ${D.fmt(w.gust)} m/s, ECMWF model` : "");
    const [tMain, tSub] = tideAt(tide, ts);
    R.text("tide", tMain); R.text("tide-sub", tSub);
    const wt = obs && ts <= lastObs + H ? D.at(obs.t, obs.col("sea_temp_c"), ts, 3 * H) : null;
    const wm = sst ? D.at(sst.time, sst.sea_surface_temperature, ts) : null;
    R.text("water", wt != null ? `${D.fmt(wt)} °C` : wm != null ? `${D.fmt(wm)} °C` : "–");
    R.text("water-sub", wt != null ? `Measured at ${buoyName} buoy` : wm != null ? "Sea surface, model" : "");
    renderCompass($("#rose"), { faces, swells: roseSwells(parts), wind: w, label: `Swell from ${D.compass(parts[0].dir)}, wind from ${D.compass(w?.dir)}` });
    overlay.update({ faces, swells: roseSwells(parts), wind: w });
  }
  show(null);

  function tip(ts, el) {
    const { parts, hs, w } = conditions(ts);
    const p1 = parts[0];
    el.innerHTML = `<div class="tip-rose"></div><div>
      <div class="tip-line">${D.whenLabel(ts)}</div>
      <div class="tip-hs">${D.fmt(hs)}<small>m</small></div>
      <div class="tip-line">${swIcon("p1")}Swell ${D.fmt(p1.h)} m, ${D.fmt(p1.period, 0)} s, ${D.compass(p1.dir)}${p1.blocked ? " (blocked)" : ""}</div>
      <div class="tip-line">${windIcon}${windChip(w)}</div>
    </div>`;
    renderCompass(el.firstElementChild, { faces, swells: roseSwells(parts), wind: w, label: "" });
  }

  $("#legend").innerHTML = legendHtml([
    ["tl-total", "Total sea, includes local chop", "area"],
    ...PARTS.map((p) => [p.cls, p.label]),
    ...(obs ? [["tl-obs", `${buoyName} buoy, measured`, "dot"]] : []),
  ]) + windKey(true);

  const rows = [];
  if (seaOk) {
    rows.push({ kind: "height", label: "Wave height", h: 168, total: { t: sea.time, v: sea.wave_height }, parts: PARTS.map((p) => ({ t: sea.time, v: sea[`${p.key}_height`], cls: p.cls })), obs: obs ? { t: obs.t, v: obs.col("wave_height_m") } : null });
    rows.push({ kind: "arrows", label: "Swell direction", h: 52, series: PARTS.map((p) => ({ t: sea.time, dir: sea[`${p.key}_direction`], h: sea[`${p.key}_height`], cls: p.cls, short: p.short })) });
  }
  if (windOk) rows.push({ kind: "wind", label: "Wind at the beach", h: 92, t: wind.time, speed: wind.wind_speed_10m, gust: wind.wind_gusts_10m, dir: wind.wind_direction_10m, tone: (i) => D.windState(wind.wind_direction_10m[i], wind.wind_speed_10m[i], faces).tone });
  if (tide) rows.push({ kind: "tide", label: `Tide, ${tideLoc.name}`, h: 58, t: tide.t, v: tide.v, events: tide.events });
  renderTimeline($("#timeline"), { t0, t1, now, sun: windOk ? wind.sun : [], rows, onScrub: show, tip });

  const peak = (t, v) => { let m = null; t.forEach((ts, i) => { if (ts >= now && ts <= now + 24 * H && v[i] != null && (m == null || v[i] > m)) m = v[i]; }); return m; };
  const cwaPeak = point ? peak(point.rows.map((r) => Date.parse(r[0]) / 1000), point.rows.map((r) => r[1])) : null;
  $("#sources").innerHTML = `
    <h2>Forecast or measured?</h2>
    <div class="explain">
      <p><strong>Forecast</strong> numbers come from Météo-France's MFWAM wave model, via Open-Meteo, at a point a few km offshore of the beach. The model splits the sea into separate swell trains, each with its own height, period and direction, which is where the swell rows and arrows come from. It describes open water, so it doesn't know about reefs, sandbars or headlands, and it often reads high.</p>
      <p><strong>Measured</strong> numbers come from a CWA buoy, every hour. A buoy reports one total height, a mean period and one direction. It can't split the sea into swells, and it may be 20 km or more away, or tucked inshore. When the two disagree, the buoy is the truth about the water near it; the model is the better guide to what's coming.</p>
    </div>
    <table class="data">
      <thead><tr><th>Source</th><th>What it gives</th><th>Next 24 h peak</th><th>Raw data</th></tr></thead>
      <tbody>
        ${buoy ? `<tr><td>${esc(buoyName)} buoy (CWA O-B0075)</td><td>Measured height, period, direction, water temperature</td><td>${D.fmt(buoy.latest?.values.wave_height_m)} m at ${D.hhmm(Date.parse(buoy.latest.time) / 1000)}</td><td><a href="/data/obs/${buoy.id}.json">JSON</a></td></tr>` : ""}
        ${point ? `<tr><td>CWA recreation forecast, ${esc(point.name)} (M-B0078-001)</td><td>CWA's own WW3 run: height, period, direction, every 3 h</td><td>${D.fmt(cwaPeak)} m</td><td><a href="/data/cwa-recreation.json">JSON</a></td></tr>` : ""}
        ${seaOk ? `<tr><td>${sea.label} via Open-Meteo</td><td>Total sea plus swell trains, hourly</td><td>${D.fmt(peak(sea.time, sea.wave_height))} m</td><td><a href="${sea.url}">API</a></td></tr>` : `<tr><td>Open-Meteo marine</td><td colspan="3">Request failed: ${esc(sea.message)}</td></tr>`}
        ${windOk ? `<tr><td>ECMWF IFS via Open-Meteo</td><td>10 m wind and gusts, hourly</td><td>${D.fmt(peak(wind.time, wind.wind_speed_10m))} m/s</td><td><a href="${wind.url}">API</a></td></tr>` : ""}
        ${tideLoc ? `<tr><td>CWA tide forecast, ${esc(tideLoc.name)} (F-A0021-001)</td><td>High and low times; the curve between is interpolated</td><td></td><td><a href="/data/tides.json">JSON</a></td></tr>` : ""}
      </tbody>
    </table>`;
}

// ---------- buoy ----------

export async function buoy() {
  const id = q("id") ?? "46708A";
  const [{ spots }, stations, meta] = await Promise.all([D.loadSpots(), D.loadStations(), D.loadMeta()]);
  const st = stations.find((x) => x.id === id) ?? stations[0];
  document.title = `${cleanName(st.nameEn)} · Taiwan Waves`;
  const now = D.nowS();
  const served = spots.filter((s) => s.buoys.includes(st.id));
  const ref = served[0];
  const faces = ref ? D.facesDeg(ref.faces) : null;
  const waveStations = stations.filter((s) => s.observes.includes("WaveHeight") || s.latest?.values.wave_height_m != null).sort((a, b) => b.lat - a.lat);

  app().innerHTML = `${chrome("buoys", meta)}
  <main class="wrap detail buoy">
    <p class="crumb"><a href="./">Now</a> / Buoys / ${esc(st.county)}</p>
    <section class="detail-head">
      <h1><span class="en">${esc(cleanName(st.nameEn))}</span> <span class="zh" lang="zh-Hant">${esc(st.name)}</span></h1>
      <p class="facts">${esc(st.typeEn)} ${st.id}. ${st.address ? `${esc(st.address)}.` : ""} ${served.length ? `Reference buoy for ${served.map((s) => `<a href="spot.html?id=${s.id}">${esc(s.name)}</a>`).join(", ")}.` : ""}</p>
      <label class="buoy-pick">Jump to buoy <select id="pick">${waveStations.map((s) => `<option value="${s.id}"${s.id === st.id ? " selected" : ""}>${esc(cleanName(s.nameEn))} ${esc(s.name)}</option>`).join("")}</select></label>
    </section>
    <section class="detail-now">
      <div class="readout" id="readout">${readoutShell({
        primary: "measured", measuredLabel: "Measured", forecastLabel: "Model here",
        rows: [["waves", swIcon("obs"), "Waves"], ["sw1", swIcon("p1"), "Swell"], ["sw2", swIcon("p2"), "2nd swell"], ["wind", windIcon, "Wind"], ["water", "", "Water"]],
      })}</div>
      <figure class="rose-frame"><div class="rose" id="rose"></div><figcaption><ul class="glyph-key"><li>${swIcon("obs")}Measured waves</li><li>${swIcon("p1")}Swell, model</li><li>${windIcon}Wind</li></ul></figcaption></figure>
      <figure class="map-frame detail-map"><div id="map" class="map" aria-label="Map around ${esc(st.nameEn)}"></div></figure>
    </section>
    <section class="detail-timeline">
      <div class="panel-head"><h2>Last six days, measured</h2><p class="note">Dots and the dark line are the buoy. Coloured lines are the model's swell trains at the same spot, for context.</p></div>
      <div id="legend"></div>
      <div class="timeline-scroll"><div id="timeline" class="timeline"></div></div>
    </section>
    <section class="detail-sources" id="sources"></section>
  </main>${footer()}`;
  $("#pick").addEventListener("change", (e) => (location.search = `?id=${e.target.value}`));

  const R = slots($("#readout"));
  const map = createMap($("#map"), { center: [st.lon, st.lat], zoom: 9.2, minZoom: 6, cooperative: true });
  const overlay = conditionOverlay(map, [st.lon, st.lat]);
  for (const s of served) marker(map, [s.lon, s.lat], `<span>${esc(s.name.replace(/ \(.*\)$/, ""))}</span>`, "map-tag tag-spot", `spot.html?id=${s.id}`);

  const [obsFile, sea, wind, skill] = await Promise.all([
    D.loadObs(st.id),
    D.fetchSea(st.lat, st.lon, { past: 7, days: 2 }).catch((e) => e),
    D.fetchWind(st.lat, st.lon, { past: 7, days: 2 }).catch((e) => e),
    fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${st.lat}&longitude=${st.lon}&hourly=wave_height&models=meteofrance_wave,ncep_gfswave016,ecmwf_wam&past_days=7&forecast_days=1&timeformat=unixtime&timezone=GMT`).then((r) => r.json()).catch(() => null),
  ]);
  const obs = D.obsTable(obsFile);
  const seaOk = !(sea instanceof Error), windOk = !(wind instanceof Error);
  const C = (n) => obs?.col(n) ?? [];
  const hasObsWind = C("wind_speed_ms").some((v) => v != null);
  const t0 = now - 6 * 24 * H, t1 = now + 12 * H;
  const lastObs = obs ? obs.t.findLast((t, i) => C("wave_height_m")[i] != null) ?? now : now;

  const windAt = (ts) => {
    if (hasObsWind && ts <= lastObs + H) {
      const dir = D.at(obs.t, C("wind_dir_deg"), ts), speed = D.at(obs.t, C("wind_speed_ms"), ts);
      return { dir, speed, gust: D.at(obs.t, C("wind_gust_ms"), ts), ...D.windState(dir, speed, faces), src: "measured at the buoy" };
    }
    if (!windOk) return null;
    const dir = D.at(wind.time, wind.wind_direction_10m, ts), speed = D.at(wind.time, wind.wind_speed_10m, ts);
    return { dir, speed, gust: D.at(wind.time, wind.wind_gusts_10m, ts), ...D.windState(dir, speed, faces), src: "ECMWF model, no anemometer" };
  };
  const partsAt = (ts) => PARTS.map((p) => ({ ...p, h: seaOk ? D.at(sea.time, sea[`${p.key}_height`], ts) : null, dir: seaOk ? D.at(sea.time, sea[`${p.key}_direction`], ts) : null, period: seaOk ? D.at(sea.time, sea[`${p.key}_period`], ts) : null }));

  function show(tsIn) {
    const ts = tsIn ?? lastObs;
    const measured = obs && ts <= lastObs + H;
    const hs = measured ? D.at(obs.t, C("wave_height_m"), ts) : null, tp = measured ? D.at(obs.t, C("wave_period_s"), ts) : null, dir = measured ? D.at(obs.t, C("wave_dir_deg"), ts) : null;
    const parts = partsAt(ts), w = windAt(ts);
    R.text("kind", tsIn == null ? "Latest reading" : measured ? "Measured" : "Model only");
    R.text("when", D.whenLabel(ts));
    R.text("ms-hs", D.fmt(hs));
    R.text("ms-src", measured ? `${cleanName(st.nameEn)} buoy` : "After the last reading");
    R.text("fc-hs", D.fmt(seaOk ? D.at(sea.time, sea.wave_height, ts) : null));
    R.text("fc-src", seaOk ? `${sea.label}, same spot` : "Model unavailable");
    R.text("note", "");
    R.text("waves", hs != null ? `${D.fmt(tp)} s from ${D.compass(dir)}` : "No reading");
    R.text("waves-sub", hs != null ? "Mean period, measured" : "");
    parts.forEach((p, i) => {
      R.text(`sw${i + 1}`, p.h != null && p.h >= 0.1 ? `${D.fmt(p.h)} m at ${D.fmt(p.period, 0)} s from ${D.compass(p.dir)}` : "None to speak of");
      R.text(`sw${i + 1}-sub`, "Model");
    });
    R.html("wind", windChip(w));
    R.text("wind-sub", w ? `${w.gust != null ? `Gusts ${D.fmt(w.gust)}, ` : ""}${w.src}` : "");
    const temp = measured ? D.at(obs.t, C("sea_temp_c"), ts, 3 * H) : null;
    R.text("water", temp != null ? `${D.fmt(temp)} °C` : "–");
    R.text("water-sub", temp != null ? "Measured" : "");
    const swells = [{ dir, h: hs, cls: "obs", name: "Waves", period: tp }, ...parts.map((p) => ({ dir: p.dir, h: p.h, period: p.period, cls: p.cls, name: p.name }))];
    renderCompass($("#rose"), { faces: null, swells, wind: w, label: `Measured waves from ${D.compass(dir)}${w ? `, wind from ${D.compass(w.dir)}` : ""}` });
    overlay.update({ swells: swells.slice(0, 2), wind: w });
  }
  show(null);

  function tip(ts, el) {
    const measured = obs && ts <= lastObs + H;
    const hs = measured ? D.at(obs.t, C("wave_height_m"), ts) : seaOk ? D.at(sea.time, sea.wave_height, ts) : null;
    const dir = measured ? D.at(obs.t, C("wave_dir_deg"), ts) : null, tp = measured ? D.at(obs.t, C("wave_period_s"), ts) : null;
    const w = windAt(ts);
    el.innerHTML = `<div class="tip-rose"></div><div>
      <div class="tip-line">${D.whenLabel(ts)}, ${measured ? "measured" : "model"}</div>
      <div class="tip-hs">${D.fmt(hs)}<small>m</small></div>
      ${dir != null ? `<div class="tip-line">${swIcon("obs")}${D.fmt(tp)} s from ${D.compass(dir)}</div>` : ""}
      <div class="tip-line">${windIcon}${windChip(w)}</div>
    </div>`;
    renderCompass(el.firstElementChild, { faces: null, swells: [{ dir, h: hs, cls: "obs" }], wind: w, label: "" });
  }

  $("#legend").innerHTML = legendHtml([
    ["obs", "Buoy, measured"],
    ...(seaOk ? [["tl-total", `Total sea, ${sea.label} model`, "area"], ...PARTS.map((p) => [p.cls, `${p.label}, model`])] : []),
  ]) + (faces != null ? windKey(true) : "");

  const rows = [];
  if (obs) {
    rows.push({
      kind: "height", label: "Wave height", h: 168,
      total: seaOk ? { t: sea.time, v: sea.wave_height } : null,
      parts: [...(seaOk ? PARTS.map((p) => ({ t: sea.time, v: sea[`${p.key}_height`], cls: `${p.cls} faint` })) : []), { t: obs.t, v: C("wave_height_m"), cls: "obs" }],
      obs: { t: obs.t, v: C("wave_height_m") },
    });
    rows.push({ kind: "arrows", label: "Wave direction", h: seaOk ? 52 : 30, series: [{ t: obs.t, dir: C("wave_dir_deg"), h: C("wave_height_m"), cls: "obs", short: "Buoy" }, ...(seaOk ? [{ t: sea.time, dir: sea.swell_wave_direction, h: sea.swell_wave_height, cls: "p1", short: "Swell" }] : [])] });
  }
  const wsrc = hasObsWind ? { t: obs.t, speed: C("wind_speed_ms"), gust: C("wind_gust_ms"), dir: C("wind_dir_deg"), label: "Wind, measured" } : windOk ? { t: wind.time, speed: wind.wind_speed_10m, gust: wind.wind_gusts_10m, dir: wind.wind_direction_10m, label: "Wind, ECMWF model (no anemometer)" } : null;
  if (wsrc) rows.push({ kind: "wind", label: wsrc.label, h: 86, ...wsrc, tone: (i) => (faces == null ? "none" : D.windState(wsrc.dir[i], wsrc.speed[i], faces).tone) });
  if (obs && C("sea_temp_c").some((v) => v != null)) rows.push({ kind: "line", label: "Water temperature", unit: "°", h: 44, series: [{ t: obs.t, v: C("sea_temp_c"), cls: "obs" }] });
  if (obs && C("tide_height_m").some((v) => v != null)) rows.push({ kind: "tide", label: "Sea level, measured", h: 56, t: obs.t, v: C("tide_height_m"), events: [] });
  renderTimeline($("#timeline"), { t0, t1, now, sun: windOk ? wind.sun : [], rows, onScrub: show, tip });

  let skillRows = "";
  if (skill?.hourly && obs) {
    const hsObs = new Map(obs.t.map((ts, i) => [ts, C("wave_height_m")[i]]));
    for (const [k, label] of [["meteofrance_wave", "MFWAM (Météo-France)"], ["ncep_gfswave016", "GFS-Wave (NOAA)"], ["ecmwf_wam", "ECMWF WAM"]]) {
      const v = skill.hourly[`wave_height_${k}`] ?? [];
      const pairs = skill.hourly.time.map((ts, i) => [hsObs.get(ts), v[i], ts]).filter(([o, m, ts]) => o != null && m != null && ts <= now);
      if (!pairs.length) continue;
      const bias = pairs.reduce((a, [o, m]) => a + m - o, 0) / pairs.length;
      const rmse = Math.sqrt(pairs.reduce((a, [o, m]) => a + (m - o) ** 2, 0) / pairs.length);
      skillRows += `<tr><td>${label}</td><td>${pairs.length}</td><td>${bias >= 0 ? "+" : ""}${D.fmt(bias, 2)} m</td><td>${D.fmt(rmse, 2)} m</td></tr>`;
    }
  }
  $("#sources").innerHTML = `
    <h2>How the models did here</h2>
    <p class="note">Model wave height minus the buoy's, matched hour by hour over the last 7 days. Buoys close inshore usually read lower than the open-ocean models.</p>
    ${skillRows ? `<table class="data"><thead><tr><th>Model</th><th>Hours</th><th>Bias</th><th>RMSE</th></tr></thead><tbody>${skillRows}</tbody></table>` : `<p class="note">No overlapping hours to score.</p>`}
    <p class="downloads"><a class="btn" href="/data/obs/${st.id}.json">Observations, last 120 days (JSON)</a></p>`;
}
