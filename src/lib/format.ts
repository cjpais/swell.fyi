export const TZ = "Asia/Taipei";

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (deg: number | null | undefined) =>
  deg == null ? "–" : COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

export const fmt = (v: number | null | undefined, digits = 1, unit = "") =>
  v == null || Number.isNaN(v) ? "–" : `${v.toFixed(digits)}${unit}`;

export function relTime(iso: string | number) {
  const ms = Date.now() - (typeof iso === "number" ? iso : Date.parse(iso));
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const dtf = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
export const taipeiTime = (t: string | number | Date) => dtf.format(new Date(t));
