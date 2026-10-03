// Style specimen: one real spot page, re-skinned live across every direction idea.
// Everything except the "signature card" is the same markup; styles are CSS blocks keyed on
// <html data-style="…">. The map style is rebuilt from CSS tokens on every switch.
import * as D from "/shared/data.js";
import { renderCompass } from "/shared/compass.js";
import { renderTimeline } from "/shared/timeline.js";
import { createMap, buildStyle, conditionOverlay, marker, esc } from "/shared/map.js";
import { PARTS, readoutShell, slots, swIcon, windIcon, windChip, windKey, glyphKey, legendHtml, tideAt, strip } from "/shared/pages.js";

const H = D.HOUR;
const $ = (s, r = document) => r.querySelector(s);

export const STYLES = [
  { id: "riso", name: "Riso almanac", zh: "農民曆", brand: "台灣浪況", blurb: "The current lead: two-drum risograph almanac, federal blue and pink, Chinese-led headlines." },
  { id: "overprint", name: "Overprint", zh: "三色套印", brand: "台灣浪況", blurb: "Riso with a third, yellow drum. Swell prints blue, wind prints yellow, and where they cross the inks overprint green." },
  { id: "mimeo", name: "Mimeograph", zh: "油印", brand: "浪況通訊", blurb: "One violet spirit-duplicator ink on cheap paper: a 70s surf-club newsletter, typed and slightly fuzzy." },
  { id: "silkscreen", name: "Silkscreen", zh: "網版", brand: "TAIWAN WAVES", blurb: "A hand-pulled Dulan gig poster: three flat spot colours, chunky shapes, a bit of misregistration." },
  { id: "chart", name: "Chart room", zh: "海圖", brand: "台灣浪況", blurb: "An old nautical chart: buff paper, black and chart magenta, depth labels, a degree-ring compass." },
  { id: "newspaper", name: "Weather page", zh: "氣象版", brand: "台灣浪報", blurb: "The weather page of an 80s daily: newsprint, black and red, each reading drawn as a station plot." },
  { id: "ticket", name: "Train ticket", zh: "硬式車票", brand: "台灣浪況", blurb: "Old TRA cardboard tickets: pale green card stock, a purple date stamp in ROC years, punched holes." },
  { id: "fortune", name: "Fortune slip", zh: "籤詩", brand: "台灣浪況", blurb: "Temple fortune slips: red paper, black brush ink, vertical text. Each hour gets its surf fortune." },
  { id: "indigo", name: "Hakka indigo", zh: "藍染", brand: "台灣浪況", blurb: "Indigo on undyed cotton, resist-dyed wave patterns, stitched edges. Quiet and textural." },
];

const ZH16 = ["北", "北北東", "東北", "東北東", "東", "東南東", "東南", "南南東", "南", "南南西", "西南", "西南西", "西", "西北西", "西北", "北北西"];
export const zhDir = (d) => (d == null ? "–" : ZH16[Math.round((((d % 360) + 360) % 360) / 22.5) % 16]);
const deg3 = (d) => (d == null ? "–" : `${String(Math.round(d) % 360).padStart(3, "0")}°`);
const rocDate = (ts) => { const d = new Date(ts * 1000 + 8 * H * 1000); return `${d.getUTCFullYear() - 1911}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`; };

// ---------- signature cards: the one place each style gets its own form ----------

export function grade(c) {
  let s = 0;
  if (c.hs != null && c.hs >= 0.6 && c.hs <= 2.5) s += 2; else if (c.hs >= 0.3) s += 1;
  s += c.w?.tone === "good" ? 2 : c.w?.tone === "fair" ? 1 : 0;
  const p1 = c.parts[0];
  if (p1?.blocked) s -= 2; else if (p1?.exposure === "straight in" || p1?.exposure === "angled in") s += 1;
  return s >= 5 ? ["上上", "Excellent"] : s >= 3 ? ["上", "Good"] : s >= 1 ? ["中", "Fair"] : ["下", "Poor"];
}

function stationPlot(c) {
  // Classic station model: circle at the spot, wind shaft toward where wind comes from with barbs,
  // swell arrow coming in, numbers around the circle.
  const r = 16, rad = (d) => (d * Math.PI) / 180, P = (b, L) => [Math.sin(rad(b)) * L, -Math.cos(rad(b)) * L];
  const out = [`<circle r="${r}" class="sp-ring"/>`];
  if (c.w?.dir != null) {
    const [x0, y0] = P(c.w.dir, r), [x1, y1] = P(c.w.dir, 70);
    out.push(`<line class="sp-shaft" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`);
    let kt = Math.round(((c.w.speed ?? 0) * 1.944) / 5) * 5, L = 70;
    const [px, py] = P(c.w.dir + 90, 1);
    while (kt >= 10) { const [bx, by] = P(c.w.dir, L), [tx, ty] = P(c.w.dir, L + 6); out.push(`<line class="sp-shaft" x1="${bx}" y1="${by}" x2="${tx + px * 16}" y2="${ty + py * 16}"/>`); L -= 8; kt -= 10; }
    if (kt >= 5) { const [bx, by] = P(c.w.dir, L), [tx, ty] = P(c.w.dir, L + 3); out.push(`<line class="sp-shaft" x1="${bx}" y1="${by}" x2="${tx + px * 9}" y2="${ty + py * 9}"/>`); }
  }
  const p1 = c.parts[0];
  if (p1?.dir != null) {
    const [ax, ay] = P(p1.dir, 82), [bx, by] = P(p1.dir, r + 4), [hx, hy] = P(p1.dir, r + 14), [nx, ny] = P(p1.dir + 90, 6);
    out.push(`<line class="sp-swell" x1="${ax}" y1="${ay}" x2="${hx}" y2="${hy}"/><path class="sp-swellhead" d="M${bx} ${by}L${hx + nx} ${hy + ny}L${hx - nx} ${hy - ny}Z"/>`);
  }
  // Numbers sit in the quadrants the wind shaft and swell arrow don't use.
  const quad = (d) => (d == null ? -1 : Math.floor((((d % 360) + 360) % 360) / 90)); // 0 NE, 1 SE, 2 SW, 3 NW
  const used = new Set([quad(c.w?.dir), quad(p1?.dir)]);
  const slots = [3, 2, 0, 1].filter((q) => !used.has(q));
  const pos = { 0: [26, -24, "start"], 1: [26, 36, "start"], 2: [-26, 36, "end"], 3: [-26, -24, "end"] };
  const nums = [[D.fmt(c.hs), "big"], [`${D.fmt(p1?.period, 0)}s`, ""], [`${c.water != null ? D.fmt(c.water) : "–"}°`, ""], [c.tideShort, ""]];
  // Fewer free quadrants than numbers: drop the least important (tide, then water).
  nums.slice(0, slots.length).forEach(([t, cls], i) => { const [x, y, a] = pos[slots[i]]; out.push(`<text class="sp-num ${cls}" x="${x}" y="${y}" text-anchor="${a}">${t}</text>`); });
  return `<svg viewBox="-92 -88 184 176" class="sp-plot" aria-hidden="true">${out.join("")}</svg>`;
}

function overprintMark(c) {
  const rad = (d) => (d * Math.PI) / 180, P = (b, L) => [Math.sin(rad(b)) * L, -Math.cos(rad(b)) * L];
  const band = (dir, w, cls) => { if (dir == null) return ""; const [ax, ay] = P(dir, 95), [nx, ny] = P(dir + 90, w / 2); return `<path class="${cls}" d="M${ax + nx} ${ay + ny}L${nx * 0.4} ${ny * 0.4}L${-nx * 0.4} ${-ny * 0.4}L${ax - nx} ${ay - ny}Z"/>`; };
  return `<svg viewBox="-100 -100 200 200" class="op-mark" aria-hidden="true"><circle r="96" class="op-ring"/>${band(c.parts[0]?.dir, 46, "op-swell")}${band(c.w?.dir, 30, "op-wind")}<circle r="5" class="op-hub"/></svg>`;
}

export const CARDS = {
  riso: (c) => `<div class="sig-riso"><span class="seal">浪</span><p class="sig-k">今日海況</p><p class="sig-big">${D.fmt(c.hs)}<small>m</small></p><p>湧 ${zhDir(c.parts[0]?.dir)} ${D.fmt(c.parts[0]?.period, 0)} 秒, 風 ${c.w?.label ?? "–"}</p><p class="sig-en">${c.when}</p></div>`,
  overprint: (c) => `<div class="sig-op">${overprintMark(c)}<div><p class="sig-k">Overprint</p><p>Swell prints blue, wind prints yellow. Where they line up, the page turns green.</p><p class="sig-en">Swell from ${D.compass(c.parts[0]?.dir)}, wind from ${D.compass(c.w?.dir)}</p></div></div>`,
  mimeo: (c) => `<pre class="sig-mimeo">TAIWAN WAVES SURF CLUB          No. ${D.dayNum(c.ts)}
SURF REPORT: ${c.spot.name.toUpperCase()} ${c.spot.nameZh}
${c.when}
----------------------------------------
WAVES (model) ............. ${D.fmt(c.hs)} m
SWELL ............ ${D.fmt(c.parts[0]?.h)} m ${D.fmt(c.parts[0]?.period, 0)} s ${D.compass(c.parts[0]?.dir)}
WIND ....... ${D.fmt(c.w?.speed)} m/s ${D.compass(c.w?.dir)} ${(c.w?.label ?? "").toLowerCase()}
TIDE ............ ${c.tideMain}
WATER ..................... ${c.water != null ? D.fmt(c.water) : "–"} C
----------------------------------------
Paddle out early. Bring wax.</pre>`,
  silkscreen: (c) => `<div class="sig-poster"><span class="ps-sun"></span><svg class="ps-waves" viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden="true"><path class="w1" d="M0 70 Q 37 40 75 70 T 150 70 T 225 70 T 300 70 V120 H0Z"/><path class="w2" d="M0 90 Q 37 62 75 90 T 150 90 T 225 90 T 300 90 V120 H0Z"/></svg><p class="ps-name">${esc(c.spot.name.split(" ")[0])}</p><p class="ps-data">${D.fmt(c.hs)} m, ${D.fmt(c.parts[0]?.period, 0)} s, ${D.compass(c.parts[0]?.dir)}<br>Wind ${(c.w?.label ?? "").toLowerCase()}</p></div>`,
  chart: (c) => `<div class="sig-chart"><p class="ch-top">Taiwan, east coast</p><p class="ch-title"><span lang="zh-Hant">${c.spot.nameZh}</span> <em>${esc(c.spot.name)}</em></p><p class="ch-sub">Soundings in metres. Bearings true. ${c.when}</p><table><tr><td>Swell</td><td>${D.fmt(c.parts[0]?.h)} m</td><td>${D.fmt(c.parts[0]?.period, 0)} s</td><td>${deg3(c.parts[0]?.dir)}</td></tr><tr><td>2nd swell</td><td>${D.fmt(c.parts[1]?.h)} m</td><td>${D.fmt(c.parts[1]?.period, 0)} s</td><td>${deg3(c.parts[1]?.dir)}</td></tr><tr><td>Wind</td><td>${D.fmt(c.w?.speed)} m/s</td><td>${c.w?.label ?? ""}</td><td>${deg3(c.w?.dir)}</td></tr></table></div>`,
  newspaper: (c) => `<div class="sig-news"><p class="nw-head" lang="zh-Hant">今日海況</p><div class="nw-body">${stationPlot(c)}<div class="nw-key"><p><b>${esc(c.spot.nameZh)}</b> ${esc(c.spot.name)}</p><p>Around the circle: wave height in metres (largest), swell period, water °C, tide. Red arrow: swell coming in. Black shaft: wind, pointing to where it blows from, 10 kt per barb.</p></div></div></div>`,
  ticket: (c) => `<div class="sig-ticket"><span class="tk-hole"></span><p class="tk-route"><span lang="zh-Hant">台灣浪況</span> → <span lang="zh-Hant">${c.spot.nameZh}</span></p><p class="tk-en">Taiwan Waves to ${esc(c.spot.name)}</p><dl><div><dt>浪 Waves</dt><dd>${D.fmt(c.hs)} m</dd></div><div><dt>湧 Swell</dt><dd>${D.compass(c.parts[0]?.dir)} ${D.fmt(c.parts[0]?.period, 0)} s</dd></div><div><dt>風 Wind</dt><dd>${c.w?.label ?? "–"}</dd></div><div><dt>潮 Tide</dt><dd>${c.tideMain}</dd></div></dl><span class="tk-stamp">${rocDate(c.ts)}<br>${D.hhmm(c.ts)}</span><p class="tk-no">No. ${String(Math.round(c.ts / 3600) % 100000).padStart(5, "0")}</p></div>`,
  fortune: (c) => {
    const [g, ge] = grade(c), p1 = c.parts[0];
    const windLine = c.w?.label === "Light" ? "風平浪靜" : c.w?.tone === "good" ? "離岸風起" : c.w?.tone === "fair" ? "側風吹拂" : "向岸風亂";
    const tideLine = /rising/.test(c.tideMain) ? "潮水漸漲" : "潮水漸退";
    return `<div class="sig-fortune"><div class="ft-slip" lang="zh-Hant"><p class="ft-no">第<span class="tcy">${(Math.floor(c.ts / 86400) % 60) + 1}</span>籤</p><p class="ft-grade">${g}</p><p class="ft-lines"><span>浪高<span class="tcy">${D.fmt(c.hs)}</span>米</span><span>湧自${zhDir(p1?.dir)}來</span><span>${windLine}</span><span>${tideLine}</span></p></div><div class="ft-gloss"><p class="sig-k">${ge} fortune</p><p>Waves ${D.fmt(c.hs)} m. Swell from the ${D.compassWord(p1?.dir)}. ${c.w?.label ?? ""} wind. Tide ${/rising/.test(c.tideMain) ? "rising" : "falling"}.</p><p class="sig-en">Graded from height, wind and how directly the swell reaches the beach.</p></div></div>`;
  },
  indigo: (c) => `<div class="sig-indigo"><div class="ig-band"></div><div class="ig-body"><p class="ig-title" lang="zh-Hant">${c.spot.nameZh}</p><p class="ig-big">${D.fmt(c.hs)}<small>m</small></p><p>Swell ${D.fmt(c.parts[0]?.period, 0)} s from ${D.compass(c.parts[0]?.dir)}. Wind ${(c.w?.label ?? "").toLowerCase()}.</p></div></div>`,
};

// ---------- page ----------

export async function specimen({ styles = STYLES, cards = {}, extras = true } = {}) {
  const id = new URLSearchParams(location.search).get("spot") ?? "jinzun";
  const [{ spots }, stations, rec, tides] = await Promise.all([D.loadSpots(), D.loadStations(), D.loadRecreation(), D.loadTides()]);
  const s = spots.find((x) => x.id === id) ?? spots[0];
  const now = D.nowS();
  const faces = D.facesDeg(s.faces);
  const buoy = s.buoys.map((b) => stations.find((x) => x.id === b)).find((x) => x?.latest?.values.wave_height_m != null && now - Date.parse(x.latest.time) / 1000 < 12 * H);
  const buoyName = buoy ? buoy.nameEn.replace(/ (Data )?Buoy$/i, "") : null;
  const tideLoc = D.nearestTide(tides, s.lat, s.lon);
  const tide = tideLoc ? D.tideCurve(tideLoc.events) : null;
  const LIST = ["honeymoon-bay", "wushi", "jinzun", "jialeshui", "baisha"].map((k) => spots.find((x) => x.id === k)).filter(Boolean);

  let styleId = location.hash.slice(1) || styles[0].id;
  if (!styles.some((x) => x.id === styleId)) styleId = styles[0].id;
  document.documentElement.dataset.style = styleId;

  const app = $("#app");
  app.innerHTML = `
  <nav class="sp-switch" aria-label="Style">
    <div class="sp-tabs">${styles.map((x) => `<button type="button" data-id="${x.id}" aria-pressed="${x.id === styleId}"><span lang="zh-Hant">${x.zh}</span> ${x.name}</button>`).join("")}</div>
    <p class="sp-blurb" id="blurb"></p>
  </nav>
  <header class="site"><div class="wrap bar"><a class="brand" href="#"><span class="brand-mark" aria-hidden="true"></span><span class="brand-zh" id="brand-zh" lang="zh-Hant"></span><span class="brand-en">Taiwan Waves</span></a><nav aria-label="Main"><a aria-current="page">Now</a><a>Buoys</a><a>Data sources</a></nav></div></header>
  <main class="wrap detail">
    <section class="detail-head">
      <h1><span class="en">${esc(s.name)}</span> <span class="zh" lang="zh-Hant">${esc(s.nameZh)}</span></h1>
      <p class="facts">The beach faces ${D.compassWord(faces)}.${buoy ? ` Nearest working buoy: ${esc(buoyName)}, ${D.km(s.lat, s.lon, buoy.lat, buoy.lon).toFixed(0)} km away.` : ""}</p>
    </section>
    <section class="detail-now">
      <div class="readout" id="readout">${readoutShell({ rows: [["sw1", swIcon("p1"), "Swell"], ["sw2", swIcon("p2"), "2nd swell"], ["wind", windIcon, "Wind"], ["tide", "", "Tide"], ["water", "", "Water"]] })}</div>
      <figure class="rose-frame"><div class="rose" id="rose"></div><figcaption>${glyphKey}</figcaption></figure>
      <figure class="map-frame detail-map"><div id="map" class="map"></div></figure>
    </section>
    ${extras ? `
    <section class="sp-row2">
      <div class="sig" id="sig"></div>
      <div class="sp-list"><div class="panel-head"><h2>Nearby spots</h2>${windKey()}</div><ul id="list"></ul></div>
    </section>
    ` : ""}
    <section class="detail-timeline">
      <div class="panel-head"><h2>Next three days</h2><p class="note">Hover to scrub; everything above follows.</p></div>
      <div id="legend"></div>
      <div class="timeline-scroll"><div id="timeline" class="timeline"></div></div>
    </section>
  </main>`;

  const R = slots($("#readout"));
  const map = createMap($("#map"), { center: [s.lon, s.lat], zoom: 10.4, minZoom: 7, cooperative: true });
  const overlay = conditionOverlay(map, [s.lon, s.lat]);
  marker(map, [s.lon, s.lat], `<span>${esc(s.name)}</span>`, "map-tag tag-spot");

  const [sea, wind, obsFile, sst, many] = await Promise.all([
    D.fetchSea(s.model[0], s.model[1], { past: 1, days: 4 }).catch(() => null),
    D.fetchWind(s.lat, s.lon, { past: 1, days: 4 }).catch(() => null),
    buoy ? D.loadObs(buoy.id) : null,
    D.fetchSST(s.model[0], s.model[1]).catch(() => null),
    extras ? D.fetchMany(LIST.map((x) => [x.lat, x.lon])).catch(() => null) : null,
  ]);
  const obs = D.obsTable(obsFile);
  const lastObs = obs ? obs.t.findLast((t, i) => obs.col("wave_height_m")[i] != null) : null;

  const cond = (ts) => {
    const parts = PARTS.map((p) => {
      const dir = sea ? D.at(sea.time, sea[`${p.key}_direction`], ts) : null, exposure = D.swellExposure(dir, faces);
      return { ...p, dir, exposure, blocked: exposure === "blocked", h: sea ? D.at(sea.time, sea[`${p.key}_height`], ts) : null, period: sea ? D.at(sea.time, sea[`${p.key}_period`], ts) : null };
    });
    let w = null;
    if (wind) { const dir = D.at(wind.time, wind.wind_direction_10m, ts), speed = D.at(wind.time, wind.wind_speed_10m, ts); w = { dir, speed, gust: D.at(wind.time, wind.wind_gusts_10m, ts), ...D.windState(dir, speed, faces) }; }
    const wt = obs && ts <= lastObs + H ? D.at(obs.t, obs.col("sea_temp_c"), ts, 3 * H) : null;
    const water = wt ?? (sst ? D.at(sst.time, sst.sea_surface_temperature, ts) : null);
    const [tideMain, tideSub] = tideAt(tide, ts);
    const th = tide ? D.lerp(tide.t, tide.v, ts) : null, th1 = tide ? D.lerp(tide.t, tide.v, ts + 1800) : null;
    return { ts, spot: s, parts, w, hs: sea ? D.at(sea.time, sea.wave_height, ts) : null, water, waterSrc: wt != null ? "buoy" : "model", tideMain, tideSub, tideShort: th == null ? "–" : `${th >= 0 ? "+" : ""}${D.fmt(th)}${th1 > th ? "↑" : "↓"}`, when: D.whenLabel(ts) };
  };

  let cur = null;
  function show(tsIn) {
    const ts = tsIn ?? Math.round(now / H) * H;
    const c = (cur = cond(ts));
    R.text("kind", tsIn == null ? "Right now" : ts < now ? "Earlier" : "Forecast for");
    R.text("when", c.when);
    R.text("fc-hs", D.fmt(c.hs)); R.text("fc-src", sea ? `${sea.label} model, offshore` : "Model unavailable");
    if (obs) { const past = ts <= lastObs + H, bt = past ? ts : lastObs; R.text("ms-hs", D.fmt(D.at(obs.t, obs.col("wave_height_m"), bt, 2 * H))); R.text("ms-src", past ? `${buoyName} buoy, ${D.hhmm(bt)}` : `${buoyName}, latest ${D.hhmm(bt)}`); }
    else { R.text("ms-hs", "–"); R.text("ms-src", "No working buoy nearby"); }
    const big = c.parts.filter((p) => p.h >= 0.2);
    R.text("note", big.length && big.every((p) => p.blocked) ? "Swell is blocked here. Expect much smaller surf." : "");
    c.parts.forEach((p, i) => { R.text(`sw${i + 1}`, p.h >= 0.1 ? `${D.fmt(p.h)} m at ${D.fmt(p.period, 0)} s from ${D.compass(p.dir)}` : "None to speak of"); R.text(`sw${i + 1}-sub`, p.h >= 0.1 ? (p.blocked ? "Blocked by the coast" : p.exposure[0].toUpperCase() + p.exposure.slice(1)) : ""); });
    R.html("wind", windChip(c.w)); R.text("wind-sub", c.w?.gust != null ? `Gusts ${D.fmt(c.w.gust)} m/s` : "");
    R.text("tide", c.tideMain); R.text("tide-sub", c.tideSub);
    R.text("water", c.water != null ? `${D.fmt(c.water)} °C` : "–"); R.text("water-sub", c.water != null ? (c.waterSrc === "buoy" ? `Measured at ${buoyName}` : "Sea surface, model") : "");
    const sw = c.parts.map((p) => ({ dir: p.dir, h: p.h, period: p.period, cls: p.cls, name: p.name, blocked: p.blocked }));
    renderCompass($("#rose"), { faces, swells: sw, wind: c.w, label: "Compass" });
    overlay.update({ faces, swells: sw, wind: c.w });
    if (extras) $("#sig").innerHTML = (cards[styleId] ?? CARDS[styleId])(c);
  }

  function list() {
    const yMax = 2.5;
    $("#list").innerHTML = LIST.map((x, i) => {
      const rows = (rec?.points[x.cwaPoint]?.rows ?? []).map((r) => [Date.parse(r[0]) / 1000, r[1]]).filter(([t]) => t >= now - 3 * H);
      const w = many?.[i]?.wind, f = D.facesDeg(x.faces);
      const toneAt = (ts) => (w ? D.windState(D.at(w.time, w.wind_direction_10m, ts), D.at(w.time, w.wind_speed_10m, ts), f).tone : "none");
      const ws = w ? D.windState(D.at(w.time, w.wind_direction_10m, now), D.at(w.time, w.wind_speed_10m, now), f) : { label: "–", tone: "none" };
      const peak = Math.max(...rows.filter(([t]) => t <= now + 24 * H).map((r) => r[1] ?? 0));
      return `<li><a class="spot-row"><span class="nm"><span class="en">${esc(x.name)}</span> <span class="zh" lang="zh-Hant">${esc(x.nameZh)}</span></span><span class="hs">${D.fmt(peak)}<small>m</small></span><span class="wind-chip t-${ws.tone}">${ws.label}</span><span class="strip-wrap">${strip(rows, toneAt, yMax, now)}</span></a></li>`;
    }).join("");
  }

  let tl = null;
  function timeline() {
    tl?.destroy();
    const rows = [];
    if (sea) {
      rows.push({ kind: "height", label: "Wave height", h: 140, total: { t: sea.time, v: sea.wave_height }, parts: PARTS.map((p) => ({ t: sea.time, v: sea[`${p.key}_height`], cls: p.cls })), obs: obs ? { t: obs.t, v: obs.col("wave_height_m") } : null });
      rows.push({ kind: "arrows", label: "Swell direction", h: 46, series: PARTS.map((p) => ({ t: sea.time, dir: sea[`${p.key}_direction`], h: sea[`${p.key}_height`], cls: p.cls, short: p.short })) });
    }
    if (wind) rows.push({ kind: "wind", label: "Wind at the beach", h: 80, t: wind.time, speed: wind.wind_speed_10m, gust: wind.wind_gusts_10m, dir: wind.wind_direction_10m, tone: (i) => D.windState(wind.wind_direction_10m[i], wind.wind_speed_10m[i], faces).tone });
    if (tide) rows.push({ kind: "tide", label: "Tide", h: 50, t: tide.t, v: tide.v, events: tide.events });
    tl = renderTimeline($("#timeline"), { t0: now - 12 * H, t1: now + 3 * 24 * H, now, sun: wind?.sun ?? [], rows, onScrub: show, tip: null });
    $("#legend").innerHTML = legendHtml([["tl-total", "Total sea, includes local chop", "area"], ...PARTS.map((p) => [p.cls, p.label]), ...(obs ? [["tl-obs", "Buoy, measured", "dot"]] : [])]) + windKey(true);
  }

  function apply(id) {
    styleId = id;
    document.documentElement.dataset.style = id;
    history.replaceState(null, "", `#${id}`);
    const st = styles.find((x) => x.id === id);
    $("#blurb").innerHTML = `<b lang="zh-Hant">${st.zh}</b> <b>${st.name}.</b> ${st.blurb}`;
    $("#brand-zh").textContent = st.brand;
    document.querySelectorAll(".sp-tabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === id)));
    // Fonts and tokens change with the style, so redraw everything that reads them.
    requestAnimationFrame(() => {
      map.setStyle(buildStyle());
      show(null);
      timeline();
    });
  }

  $(".sp-tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) apply(b.dataset.id); });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, .tl")) return;
    const i = styles.findIndex((x) => x.id === styleId);
    if (e.key === "]") { apply(styles[(i + 1) % styles.length].id); e.preventDefault(); }
    if (e.key === "[") { apply(styles[(i - 1 + styles.length) % styles.length].id); e.preventDefault(); }
  });
  if (extras) list();
  apply(styleId);
}
