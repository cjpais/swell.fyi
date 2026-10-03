// Riso iterations: variations on the two favourites (Riso almanac, Overprint), shown on the
// same live spot page as the style specimen. Reference styles come from /styles/.
import * as D from "/shared/data.js";
import { specimen, STYLES, zhDir, grade } from "/styles/specimen.js";

const ref = (id) => STYLES.find((s) => s.id === id);
const styles = [
  { ...ref("riso"), name: "Riso almanac", blurb: "Reference: the current lead." },
  { ...ref("overprint"), name: "Overprint", blurb: "Reference: three drums with yellow. Its green overlap read as 'good', which it isn't." },
  { id: "seal", name: "Seal system", zh: "印章", brand: "台灣浪況", blurb: "Riso almanac plus a family of seals: every reading gets a stamped character (湧 swell, 風 wind, 潮 tide, 溫 water), and wind quality is stamped 佳 good, 可 fair or 差 poor." },
  { id: "sunset", name: "Sunset drums", zh: "粉橘", brand: "台灣浪況", blurb: "The pink and orange from Overprint as the main inks, aubergine for text, no yellow. Pink-lilac sea. Warmer and louder." },
  { id: "blocks", name: "Solid blocks", zh: "色塊", brand: "台灣浪況", blurb: "Big flat fields of blue, pink and orange. Marks never mix: where they cross, a paper-coloured gap keeps them apart (a knockout), so no colour means 'overlap'." },
  { id: "blueorange", name: "Blue and orange", zh: "藍橘", brand: "台灣浪況", blurb: "Two drums, federal blue and orange. Orange takes the seal and the accents. The signature card is an almanac 宜/忌: what the day is good for, and what to avoid." },
  { id: "crossed", name: "Crossed seas", zh: "交叉浪", brand: "台灣浪況", blurb: "Overprint with a meaning that holds up: only the two swells multiply. Purple means both are arriving from the same side. Separate bands mean a crossed, lumpier sea. Wind stays plain ink." },
];

const seal = (ch, cls = "") => `<span class="rs-seal ${cls}" lang="zh-Hant">${ch}</span>`;
const toneZh = { good: "佳", fair: "可", poor: "差", none: "無" };

function yiJi(c) {
  // Almanac-style "good for / avoid" lists, from the same rules the page already uses.
  const yi = [], ji = [];
  const hs = c.hs ?? 0, p1 = c.parts[0], tone = c.w?.tone;
  if (p1?.blocked) { yi.push(["看海", "watching the sea"]); ji.push(["白跑一趟", "a wasted drive"]); }
  else if (hs < 0.5) { yi.push(["長板", "longboarding"], ["游泳", "a swim"]); ji.push(["短板", "shortboards"]); }
  else if (hs <= 1.4) { yi.push(["衝浪", "surfing"], [tone === "good" ? "早起" : "等風停", tone === "good" ? "an early start" : "waiting out the wind"]); }
  else { yi.push(["衝浪", "surfing, if experienced"]); ji.push(["新手下水", "beginners going out"]); }
  if (tone === "poor") ji.push(["向岸風", "onshore wind"]);
  if (!ji.length) ji.push(["遲到", "showing up late"]);
  return { yi, ji };
}

function overlapMark(c) {
  const rad = (d) => (d * Math.PI) / 180, P = (b, L) => [Math.sin(rad(b)) * L, -Math.cos(rad(b)) * L];
  const band = (p, w, cls) => { if (p?.dir == null || !(p.h >= 0.1)) return ""; const [ax, ay] = P(p.dir, 95), [nx, ny] = P(p.dir + 90, w / 2); return `<path class="${cls}" d="M${ax + nx} ${ay + ny}L${nx * 0.35} ${ny * 0.35}L${-nx * 0.35} ${-ny * 0.35}L${ax - nx} ${ay - ny}Z"/>`; };
  return `<svg viewBox="-100 -100 200 200" class="op-mark" aria-hidden="true"><circle r="96" class="op-ring"/>${band(c.parts[0], 52, "cx-p1")}${band(c.parts[1], 40, "cx-p2")}<circle r="5" class="op-hub"/></svg>`;
}

const cards = {
  seal: (c) => `<div class="sig-seal">
    ${[["浪", `${D.fmt(c.hs)} m`, "Waves", "s-ink"], ["湧", `${D.fmt(c.parts[0]?.period, 0)} s ${D.compass(c.parts[0]?.dir)}`, "Swell", "s-p1"], ["風", c.w?.label ?? "–", "Wind", `t-${c.w?.tone ?? "none"} s-tone`], ["潮", c.tideMain.split(",")[1]?.trim() ?? "–", "Tide", "s-accent"]]
      .map(([ch, v, en, cls]) => `<div class="ss-cell">${seal(ch, cls)}<p class="ss-v">${v}</p><p class="ss-en">${en}</p></div>`).join("")}
  </div>`,
  sunset: (c) => `<div class="sig-sunset"><span class="sn-sun"></span><span class="sn-stripes"></span><div class="sn-text"><p class="sn-zh" lang="zh-Hant">${c.spot.nameZh}</p><p class="sn-big">${D.fmt(c.hs)}<small>m</small></p><p>Swell ${D.fmt(c.parts[0]?.period, 0)} s from ${D.compass(c.parts[0]?.dir)}. Wind ${(c.w?.label ?? "").toLowerCase()}.</p></div></div>`,
  blocks: (c) => `<div class="sig-blocks"><div class="bk-a"><span lang="zh-Hant">${c.spot.nameZh}</span> ${c.spot.name}</div><div class="bk-b">${D.fmt(c.hs)}<small>m</small></div><div class="bk-c">Swell ${D.fmt(c.parts[0]?.h)} m, ${D.fmt(c.parts[0]?.period, 0)} s, ${D.compass(c.parts[0]?.dir)}<br>Wind ${(c.w?.label ?? "").toLowerCase()}, ${D.fmt(c.w?.speed)} m/s</div></div>`,
  blueorange: (c) => {
    const { yi, ji } = yiJi(c);
    const d = new Date(c.ts * 1000 + 8 * 3600 * 1000);
    const wk = "日一二三四五六"[d.getUTCDay()];
    const li = (xs) => xs.map(([zh, en]) => `<li><span lang="zh-Hant">${zh}</span> <em>${en}</em></li>`).join("");
    return `<div class="sig-yiji"><p class="yj-date" lang="zh-Hant">民國${d.getUTCFullYear() - 1911}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 星期${wk} ${D.hhmm(c.ts)}</p><div class="yj-cols"><div>${seal("宜", "s-p1 big")}<ul>${li(yi)}</ul></div><div>${seal("忌", "s-accent big")}<ul>${li(ji)}</ul></div></div><p class="sig-en">Good for, and avoid, at ${c.spot.name}: from wave height, wind and how directly the swell reaches the beach.</p></div>`;
  },
  crossed: (c) => {
    const a = c.parts[0], b = c.parts[1];
    const diff = a?.dir != null && b?.dir != null ? Math.abs(((a.dir - b.dir + 540) % 360) - 180) : null;
    const msg = !(b?.h >= 0.1) ? "Only one swell running." : diff < 35 ? "The two swells overlap: both come from the same side, so they stack." : "Two separate bands: the swells cross, so expect a lumpier sea.";
    return `<div class="sig-op">${overlapMark(c)}<div><p class="sig-k">${msg}</p><p>Swell prints blue, the second swell pink. Where they overlap, purple.</p><p class="sig-en">Swell ${D.compass(a?.dir)} ${D.fmt(a?.h)} m, 2nd swell ${D.compass(b?.dir)} ${D.fmt(b?.h)} m</p></div></div>`;
  },
};

specimen({ styles, cards });
