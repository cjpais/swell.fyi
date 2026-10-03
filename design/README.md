# Design explorations

Retro visual directions for Taiwan Waves, built on live data. Nothing here touches the app (`src/`, `public/`, `astro.config.mjs`).

```sh
bun design/serve.mjs     # http://localhost:4848
```

The server serves this folder, plus the app's `public/data` and `public/map` (read-only), and `tiles/taiwan.pmtiles` with byte ranges. Model forecasts load live from Open-Meteo, as in the app.

| Path | What |
|---|---|
| `index.html` | Overview: the directions side by side, with links |
| `palettes/` | Riso palettes: the Riso almanac treatment in Blue + pink and Overprint (yellow header bar, three-tone headlines) |
| `riso/` | Riso iterations: Seal system, Sunset drums, Solid blocks, Blue and orange, Crossed seas, next to the two originals |
| `styles/` | Style specimen: one live spot page with a switcher across nine style ideas (`[` and `]` to flip) |
| `riso-almanac/` | **Lead direction.** 1980s risograph 農民曆, two-ink blue and pink, Chinese-led |
| `tide-calendar/` | 1970s surf-shop tide calendar on kraft card |
| `archive/night-session/` | Dark 80s surf-tee direction, parked |
| `shared/` | Everything the directions share: data access and surf geometry (`data.js`), compass rose, scrub timeline, MapLibre style and overlays, page builders, structural CSS |

Each direction is three thin HTML shells (`index`, `spot.html?id=…`, `buoy.html?id=…`) and one `theme.css` of tokens and overrides. Layout and data are identical across directions, so they compare on style alone. A switcher pinned to the bottom right jumps to the same page in another direction.

## Conventions worth keeping if any of this moves into the app

- **Wind relative to the beach.** `facesDeg("E/SE")` gives 112.5°. Wind "from" within 30° of that is onshore, 135° or more off is offshore, and under 2 m/s is "Light". Tones are good, fair or poor, always shown with a label.
- **Arrows show travel.** Swell and wind arrows point the way the water or air moves. On the compass they run in from the rim toward the spot at the center.
- **Swell and wind differ in form.** Swell is coloured and wide (block arrow, crest arcs or crest lines; toggle on the map). Wind is always a thin ink line with an open head and knot barbs, on the map and the compass alike. The map carries a key with the current values, plus a direct label on every arrow.
- **No layout shift.** The readout is built once with fixed rows, and scrubbing only swaps text. Check it with `PerformanceObserver` layout-shift entries while scrolling and scrubbing.
- **Wind waves are folded into total sea**, not shown separately.
- **Data colors** for each direction (the swell colors, plus the wind pair) passed the dataviz validator: lightness band, chroma floor, OKLab ΔE under protan/deutan simulation, and the normal-vision floor. Retune them with the same check, not by eye.
