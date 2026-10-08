// Home page in the browser: CWA's forecast strips, the buoy readings, the overview map, and the
// wind at every spot (ECMWF IFS) colouring the strips, chips and callouts. The structure is built
// at build time; the numbers come in the page's data (scripts/lib/pages.ts), usually already in
// the HTML (workers/site).
import { loadMap } from "./lazy-map";
import { arrowSvg } from "./glyphs";
import { esc, strip, sparkline } from "./ui";
import { fmt, compass } from "./format";
import { HOUR as H, at, facesDeg, windState, nowS, type Tone } from "./surf";
import { isFresh, loadPage, type HomePageData } from "./data";

type Payload = {
  spots: { id: string; name: string; lat: number; lon: number; faces: number; cwaPoint: string }[];
  stations: { id: string; name: string; lat: number; lon: number }[];
  east: string[];
};

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);

export async function initHome(p: Payload) {
  const now = nowS();
  const d = await loadPage<HomePageData>("home");
  const rec = d?.forecast ?? null, sparks = d?.sparks ?? null, latest = d?.latest ?? {};

  // ---------- CWA's forecast per spot: [unix s, Hs] every 3 h, from 3 h ago on ----------
  const rows = Object.fromEntries(p.spots.map((s) => [s.id, (rec?.points[s.cwaPoint]?.rows ?? []).map((r) => [Date.parse(r[0]) / 1000, r[1]] as [number, number | null]).filter(([t]) => t >= now - 3 * H)]));
  const yMax = Math.max(1.5, ...Object.values(rows).flat().map((r) => r[1] ?? 0));
  const peak = (id: string) => {
    const next = rows[id].filter(([t]) => t <= now + 24 * H).map((r) => r[1]).filter((v): v is number => v != null);
    return next.length ? Math.max(...next) : null;
  };
  $("#issued")!.textContent = rec ? `issued ${rec.issued.slice(0, 16).replace("T", " ")}` : "unavailable right now";
  const paintStrips = (toneFor: (id: string) => (ts: number) => Tone) => {
    for (const s of p.spots) {
      const row = $(`[data-spot="${s.id}"]`);
      if (row) $("[data-strip]", row)!.innerHTML = strip(rows[s.id], toneFor(s.id), yMax);
    }
  };
  for (const s of p.spots) {
    const pk = peak(s.id), el = $(`[data-spot="${s.id}"] [data-peak]`);
    if (el) el.innerHTML = pk != null ? `${fmt(pk)}<small>m</small>` : "–";
  }
  paintStrips(() => () => "none");

  // ---------- east coast buoys ----------
  const sparkMax = Math.max(1, ...p.east.flatMap((id) => (sparks?.[id] ?? []).map((x) => x[1] ?? 0)));
  for (const id of p.east) {
    const row = $(`[data-buoy="${id}"]`);
    if (!row) continue;
    const l = latest[id], v = l?.values ?? {}, ok = isFresh(l?.time, now);
    const set = (k: string, html: string) => ($(`[data-v="${k}"]`, row)!.innerHTML = html);
    row.classList.toggle("stale", !ok);
    set("hs", ok ? fmt(v.wave_height_m) : "–");
    set("tp", ok ? fmt(v.wave_period_s) : "–");
    set("dir", ok ? `${arrowSvg(v.wave_dir_deg)}<span>${compass(v.wave_dir_deg)}</span>` : "");
    set("spark", sparkline(sparks?.[id] ?? [], sparkMax));
    set("meta", !l ? "No data" : ok ? (v.sea_temp_c != null ? `${fmt(v.sea_temp_c)} °C water` : "") : `${Math.round((now - Date.parse(l.time) / 1000) / H)} h old`);
  }

  // ---------- wind: colours the strips and chips, and the map's callouts below ----------
  const winds = d?.wind;
  const windNow = new Map<string, { label: string; tone: Tone }>();
  if (!winds || !Object.keys(winds).length) {
    document.querySelectorAll("[data-chip]").forEach((c) => (c.textContent = "Wind unavailable"));
  } else {
    const stateAt = (i: number) => {
      const w = winds[p.spots[i].id], faces = facesDeg(p.spots[i].faces);
      return (ts: number) => windState(at(w?.time, w?.wind_direction_10m, ts), at(w?.time, w?.wind_speed_10m, ts), faces);
    };
    paintStrips((id) => { const f = stateAt(p.spots.findIndex((s) => s.id === id)); return (ts) => f(ts).tone; });
    p.spots.forEach((s, i) => {
      if (!winds[s.id]) return;
      const ws = stateAt(i)(now);
      windNow.set(s.id, ws);
      const chip = $(`[data-spot="${s.id}"] [data-chip]`);
      if (chip) { chip.className = `wind-chip t-${ws.tone}`; chip.textContent = ws.label; }
    });
  }

  // ---------- map ----------
  // Loaded on its own (src/lib/lazy-map.ts): everything above draws without waiting for MapLibre.
  loadMap().then(({ createMap, marker, spotCallouts }) => {
    // Narrow maps zoom out so the callouts pushed out to sea still fit.
    const narrow = $("#map")!.clientWidth < 600;
    const map = createMap($("#map")!, { center: narrow ? [120.95, 23.65] : [120.95, 23.6], zoom: narrow ? 5.8 : 6.55 });

    // Buoys as small measured tags; stale ones shrink to a grey dot.
    map.on("load", () => {
      for (const st of p.stations) {
        const v = latest[st.id], hs = v?.values.wave_height_m ?? null;
        const ok = isFresh(v?.time, now) && hs != null;
        const el = marker(map, [st.lon, st.lat], `<span>${ok ? fmt(hs) : ""}</span>${ok ? arrowSvg(v!.values.wave_dir_deg, 11) : ""}`, `buoy-dot${ok ? "" : " stale"}`, `/buoys/${st.id}/`);
        el.title = `${st.name}: ${ok ? `${fmt(hs)} m, ${fmt(v!.values.wave_period_s)} s from ${compass(v!.values.wave_dir_deg)}` : "no current reading"}`;
      }
    });

    // Spots as callouts pushed out to sea, east or west of the island.
    const callouts = spotCallouts(map, p.spots.map((s) => {
      const ws = windNow.get(s.id);
      return {
        id: s.id, lat: s.lat, lon: s.lon,
        side: s.lon < 120.8 ? "west" : "east",
        href: `/spots/${s.id}/`,
        html: `<span class="co-name">${esc(s.name.replace(/ \(.*\)$/, "").replace(/ \/ .*/, ""))}</span><span class="co-val">${fmt(peak(s.id))}</span><i class="co-tone t-${ws?.tone ?? "none"}"${ws ? ` title="Wind now: ${esc(ws.label)}"` : ""}></i>`,
      };
    }));
    callouts.layout();
  }).catch((e) => console.error("Map failed to load:", e));
}
