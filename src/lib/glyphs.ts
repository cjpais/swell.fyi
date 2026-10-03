// SVG path builders shared by the map overlay, the compass and the readouts.
// Swell is always a wide coloured arrow; wind is always a thin ink line with an open
// head and knot barbs, so the two differ in form, not just colour.
type Pt = [number, number];
const F = (n: number) => n.toFixed(1);

/** Wide block arrow from a to b (screen coords). */
export function blockArrow([ax, ay]: Pt, [bx, by]: Pt, w: number) {
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  const head = Math.min(L * 0.45, w * 1.5), hw = w * 1.05, sw = w * 0.45;
  const hx = bx - ux * head, hy = by - uy * head;
  const p: Pt[] = [[ax + nx * sw, ay + ny * sw], [hx + nx * sw, hy + ny * sw], [hx + nx * hw, hy + ny * hw], [bx, by], [hx - nx * hw, hy - ny * hw], [hx - nx * sw, hy - ny * sw], [ax - nx * sw, ay - ny * sw]];
  return `M${p.map(([x, y]) => `${F(x)} ${F(y)}`).join("L")}Z`;
}

/** Thin wind arrow from a to b with an open chevron head and knot barbs at the tail. */
export function windGlyph([ax, ay]: Pt, [bx, by]: Pt, ms: number | null | undefined, scale = 1) {
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  const h = 9 * scale;
  const parts = [`M${F(ax)} ${F(ay)}L${F(bx)} ${F(by)}`, `M${F(bx - ux * h + nx * h * 0.7)} ${F(by - uy * h + ny * h * 0.7)}L${F(bx)} ${F(by)}L${F(bx - ux * h - nx * h * 0.7)} ${F(by - uy * h - ny * h * 0.7)}`];
  let kt = Math.round(((ms ?? 0) * 1.944) / 5) * 5, d = 0;
  const barb = (len: number, back: number) => { const x = ax + ux * d, y = ay + uy * d; parts.push(`M${F(x)} ${F(y)}L${F(x - ux * back + nx * len)} ${F(y - uy * back + ny * len)}`); };
  while (kt >= 10) { barb(11 * scale, 4 * scale); d += 5 * scale; kt -= 10; }
  if (kt >= 5) barb(6 * scale, 2 * scale);
  return parts.join("");
}

/** Small filled arrow pointing the way waves travel (away from `from`). */
export const arrowSvg = (from: number | null | undefined, size = 14) =>
  from == null ? "" : `<svg class="dir-arrow" viewBox="-8 -8 16 16" width="${size}" height="${size}" style="transform:rotate(${(from + 180) % 360}deg)" aria-hidden="true"><path d="M0 -7 L5 4 L0 1.5 L-5 4 Z"/></svg>`;
