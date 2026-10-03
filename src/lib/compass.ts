// Compass rose: the spot sits at the centre. Swell and wind arrows travel in from the
// direction they come from (meteorological convention), so an arrow reads like
// "this is what hits the beach". Coastline and swell window come from the spot's
// `faces`. Wind carries barbs (knots) at its upwind end, nautical-chart style.

export type RoseSwell = { dir: number | null; h: number | null; cls: string; blocked?: boolean };
export type RoseWind = { dir: number | null; speed: number | null } | null;
/** A text label outside the ring at a bearing, e.g. "Swell 0.9 m · 6 s" by its arrow. */
export type RoseTag = { dir: number; text: string; cls: string };

const R = 88;
const rad = (d: number) => (d * Math.PI) / 180;
const pt = (bearing: number, r: number): [number, number] => [Math.sin(rad(bearing)) * r, -Math.cos(rad(bearing)) * r];
const f = (n: number) => n.toFixed(1);

function sector(from: number, to: number, r: number) {
  const [x0, y0] = pt(from, r), [x1, y1] = pt(to, r);
  const large = ((to - from + 360) % 360) > 180 ? 1 : 0;
  return `M0 0 L${f(x0)} ${f(y0)} A${r} ${r} 0 ${large} 1 ${f(x1)} ${f(y1)} Z`;
}

/** Tapered arrow from the rim (at `bearing`) toward the centre. */
function arrow(bearing: number, len: number, width: number) {
  const r0 = R - 2, r1 = Math.max(14, r0 - len);
  const head = Math.min(16, len * 0.45);
  const [ax, ay] = pt(bearing, r0), [bx, by] = pt(bearing, r1 + head), [tx, ty] = pt(bearing, r1);
  const nx = Math.cos(rad(bearing)), ny = Math.sin(rad(bearing)); // perpendicular unit vector
  const w0 = width * 0.35, w1 = width * 0.5, wh = width * 1.25;
  const p = [
    [ax + nx * w0, ay + ny * w0], [bx + nx * w1, by + ny * w1], [bx + nx * wh, by + ny * wh], [tx, ty],
    [bx - nx * wh, by - ny * wh], [bx - nx * w1, by - ny * w1], [ax - nx * w0, ay - ny * w0],
  ];
  return `M${p.map(([x, y]) => `${f(x)} ${f(y)}`).join(" L")} Z`;
}

function barbs(bearing: number, ms: number) {
  // Standard wind barbs: pennant 50 kt, full barb 10 kt, half barb 5 kt, from the upwind end.
  let kt = Math.round((ms * 1.944) / 5) * 5;
  const out: string[] = [];
  const nx = Math.cos(rad(bearing)), ny = Math.sin(rad(bearing));
  let r = R - 4;
  while (kt >= 50) {
    const [x, y] = pt(bearing, r), [x2, y2] = pt(bearing, r - 7);
    out.push(`M${f(x)} ${f(y)} L${f(x + nx * 13)} ${f(y + ny * 13)} L${f(x2)} ${f(y2)} Z`);
    r -= 10; kt -= 50;
  }
  while (kt >= 10) {
    const [x, y] = pt(bearing, r), [x3, y3] = pt(bearing, r + 4);
    out.push(`M${f(x)} ${f(y)} L${f(x3 + nx * 13)} ${f(y3 + ny * 13)}`);
    r -= 5.5; kt -= 10;
  }
  if (kt >= 5) {
    const [x, y] = pt(bearing, r), [x3, y3] = pt(bearing, r + 2);
    out.push(`M${f(x)} ${f(y)} L${f(x3 + nx * 7)} ${f(y3 + ny * 7)}`);
  }
  return out;
}

export function renderCompass(el: Element, o: { faces?: number | null; swells?: RoseSwell[]; wind?: RoseWind; label?: string; tags?: RoseTag[] }) {
  const s: string[] = [];
  const css = getComputedStyle(document.documentElement);
  s.push(`<circle class="c-face" r="${R}"/>`);
  if (o.faces != null) {
    s.push(`<path class="c-window" d="${sector(o.faces - 90, o.faces + 90, R)}"/>`);
    s.push(`<path class="c-window-core" d="${sector(o.faces - 40, o.faces + 40, R)}"/>`);
  }
  const nt = Number(css.getPropertyValue("--rose-ticks").trim()) || 16;
  for (let i = 0; i < nt; i++) {
    const b = (i * 360) / nt, major = i % (nt / 4) === 0;
    const [x0, y0] = pt(b, R), [x1, y1] = pt(b, R - (major ? 9 : 5));
    s.push(`<line class="c-tick${major ? " major" : ""}" x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}"/>`);
  }
  s.push(`<circle class="c-ring" r="${R}"/>`);
  const cards = (css.getPropertyValue("--rose-cardinals").replace(/["']/g, "").trim() || "N E S W").split(/\s+/);
  cards.forEach((t, i) => {
    const [x, y] = pt(i * 90, R + 12);
    s.push(`<text class="c-card" x="${f(x)}" y="${f(y)}" dy="0.35em" text-anchor="middle">${t}</text>`);
  });
  if (o.faces != null) {
    // Land half-disc behind the coastline, on the side opposite the swell window.
    const [lx0, ly0] = pt(o.faces + 90, 30), [lx1, ly1] = pt(o.faces - 90, 30);
    s.push(`<path class="c-land" d="M${f(lx0)} ${f(ly0)} A30 30 0 0 1 ${f(lx1)} ${f(ly1)} Z"/>`);
    s.push(`<line class="c-coast" x1="${f(lx0)}" y1="${f(ly0)}" x2="${f(lx1)}" y2="${f(ly1)}"/>`);
  }
  // Smallest arrows last so they stay visible on top.
  const sw = (o.swells ?? []).filter((x): x is RoseSwell & { dir: number; h: number } => x.dir != null && x.h != null && x.h > 0.05).sort((a, b) => b.h - a.h);
  for (const x of sw) {
    const len = Math.max(22, Math.min(74, 18 + x.h * 32));
    s.push(`<path class="c-arrow ${x.cls}${x.blocked ? " blocked" : ""}" d="${arrow(x.dir, len, x.cls === "p1" ? 9 : 7)}"/>`);
  }
  if (o.wind?.dir != null) {
    // Same glyph as the map: thin ink line, open chevron head, knot barbs at the upwind end.
    const wd = o.wind.dir;
    const [ax, ay] = pt(wd, R - 2), [bx, by] = pt(wd, 20), [hx, hy] = pt(wd, 29);
    const nx = Math.cos(rad(wd)) * 6, ny = Math.sin(rad(wd)) * 6;
    const d = [`M${f(ax)} ${f(ay)} L${f(bx)} ${f(by)}`, `M${f(hx + nx)} ${f(hy + ny)} L${f(bx)} ${f(by)} L${f(hx - nx)} ${f(hy - ny)}`, ...barbs(wd, o.wind.speed ?? 0)].join(" ");
    s.push(`<path class="c-wind-casing" d="${d}"/><g class="c-wind"><path d="${d}"/></g>`);
  }
  s.push(`<circle class="c-hub" r="3.5"/>`);
  // Tags sit outside the ring by their arrow's tail, nudged apart if two bearings are close.
  const placed: { x0: number; x1: number; y: number }[] = [];
  for (const t of o.tags ?? []) {
    const [x] = pt(t.dir, R + 26);
    let [, y] = pt(t.dir, R + 26);
    const anchor = x > 14 ? "start" : x < -14 ? "end" : "middle";
    const w = t.text.length * 6.3;
    const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
    for (let n = 0; n < 6 && placed.some((p) => Math.abs(p.y - y) < 14 && x0 < p.x1 && x0 + w > p.x0); n++) y += y < 0 ? -14 : 14;
    placed.push({ x0, x1: x0 + w, y });
    s.push(`<text class="c-tag ${t.cls}" x="${f(x)}" y="${f(y)}" dy="0.35em" text-anchor="${anchor}">${t.text}</text>`);
  }
  el.innerHTML = `<svg viewBox="-110 -110 220 220" role="img" aria-label="${o.label ?? "Compass"}">${s.join("")}</svg>`;
}
