// Conditions at a spot at one moment, shared by the spot page and the explore map, so both
// read the same numbers from the same series.
import { PARTS } from "./ui";
import { HOUR as H, at, swellExposure, windState, type ObsTable, type SwellWindow, type Tide } from "./surf";
import type { Row } from "./timeline";

/** Hourly sea state with swell partitions (MFWAM, or GFS-Wave as fallback). */
export type SeaSeries = { label: string; time: number[]; get: (variable: string) => (number | null)[] };
/** Hourly 10 m wind at the beach. */
export type WindSeries = { time: number[]; wind_speed_10m: (number | null)[]; wind_direction_10m: (number | null)[]; wind_gusts_10m: (number | null)[] };

/** `window`: the spot's own swell directions; without it, exposure is judged from `faces` alone. */
export function makeConditions(sea: SeaSeries | null, wind: WindSeries | null, faces: number | null, window?: SwellWindow | null) {
  return (ts: number) => {
    const parts = PARTS.map((pt) => {
      const h = sea ? at(sea.time, sea.get(`${pt.key}_height`), ts) : null, dir = sea ? at(sea.time, sea.get(`${pt.key}_direction`), ts) : null;
      const exposure = swellExposure(dir, faces, window);
      return { ...pt, h, dir, period: sea ? at(sea.time, sea.get(`${pt.key}_period`), ts) : null, exposure, blocked: exposure === "blocked" };
    });
    let w = null;
    if (wind) {
      const dir = at(wind.time, wind.wind_direction_10m, ts), speed = at(wind.time, wind.wind_speed_10m, ts);
      w = { dir, speed, gust: at(wind.time, wind.wind_gusts_10m, ts), ...windState(dir, speed, faces) };
    }
    return { parts, w, hs: sea ? at(sea.time, sea.get("wave_height"), ts) : null };
  };
}
export type Conditions = ReturnType<ReturnType<typeof makeConditions>>;
export type Parts = Conditions["parts"];

/** The model's number is open-ocean sea state. When the swell can't reach the beach, say so. */
export function swellNote(parts: Parts) {
  const big = parts.filter((x) => x.h != null && x.h >= 0.2);
  if (!big.length) return "";
  if (big.every((x) => x.blocked)) return "Swell is blocked here. Expect much smaller surf.";
  if (big.every((x) => x.blocked || x.exposure === "wrapping")) return "Swell only wraps in. Expect smaller surf.";
  return "";
}

export const roseSwells = (parts: Parts) => parts.map((x) => ({ dir: x.dir, h: x.h, period: x.period, cls: x.cls, name: x.name, blocked: x.blocked }));

/** The stacked rows under a spot: height (+ buoy), swell arrows, wind, tide. */
export function timelineRows(o: { sea: SeaSeries | null; wind: WindSeries | null; obs: ObsTable | null; tide: Tide | null; tideName?: string; faces: number | null }): Row[] {
  const { sea, wind, obs, tide, faces } = o;
  const rows: Row[] = [];
  if (sea) {
    rows.push({ kind: "height", label: "Wave height", h: 168, total: { t: sea.time, v: sea.get("wave_height") }, parts: PARTS.map((x) => ({ t: sea.time, v: sea.get(`${x.key}_height`), cls: x.cls })), obs: obs ? { t: obs.t, v: obs.col("wave_height_m") } : null });
    rows.push({ kind: "arrows", label: "Swell direction", h: 52, series: PARTS.map((x) => ({ t: sea.time, dir: sea.get(`${x.key}_direction`), h: sea.get(`${x.key}_height`), cls: x.cls, short: x.short })) });
  }
  if (wind) rows.push({ kind: "wind", label: "Wind at the beach", h: 92, t: wind.time, speed: wind.wind_speed_10m, gust: wind.wind_gusts_10m, dir: wind.wind_direction_10m, tone: (i) => windState(wind.wind_direction_10m[i], wind.wind_speed_10m[i], faces).tone });
  if (tide && o.tideName) rows.push({ kind: "tide", label: `Tide, ${o.tideName}`, h: 58, t: tide.t, v: tide.v, events: tide.events });
  return rows;
}

/** Latest buoy reading with a wave height, and the buoy value at ts (or its latest, if ts is later). */
export function buoyAt(obs: ObsTable | null, ts: number) {
  if (!obs) return null;
  const hs = obs.col("wave_height_m");
  const last = obs.t.findLast((_, i) => hs[i] != null) ?? null;
  if (last == null) return null;
  const past = ts <= last + H;
  const bt = past ? ts : last;
  return { past, t: bt, hs: at(obs.t, hs, bt, 2 * H), water: past ? at(obs.t, obs.col("sea_temp_c"), ts, 3 * H) : null };
}
