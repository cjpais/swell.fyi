# Taiwan Waves

A no-nonsense explorer for Taiwan's open ocean data, built for surfing. It shows:

- **Buoy truth.** Hourly observations from every CWA marine station: wave height, period, direction, wind, water temperature, tide and current. History is archived locally, so it grows beyond the 30 days CWA keeps.
- **CWA's own surf forecast.** M-B0078-001 (WW3-based, 72 h, 3-hourly) for 13 named surf spots plus beaches and harbours.
- **Three global wave models side by side**, via Open-Meteo: Météo-France MFWAM, NOAA GFS-Wave and ECMWF WAM. Swell partitions come from MFWAM and GFS.
- **Model scoring.** Each buoy page computes every model's bias, RMSE and correlation against the buoy, so you can see which source to trust where.
- **Raw downloads everywhere.** Each station's full CSV archive, and a merged CSV of every series on a spot page.

See [RESEARCH.md](RESEARCH.md) (also served at `/research/`) for the full survey: what data exists, which models are best for Taiwan, and where apps like Swelleye and Surfline get theirs.

## Run it

```sh
bun install
bun run fetch:backfill   # first time: last 30 days of obs from CWA (~45 MB download)
bun run dev              # http://localhost:4747 (map tiles come from https://tiles.swell.fyi)
```

`bun run build` produces a static site in `dist/`. Model forecasts load live in the browser from Open-Meteo. CWA data is whatever the last `fetch` wrote to `public/data/`.

## Keep the archive growing

CWA's live feed only covers 48 hours, so **run `bun run fetch` every 1–3 hours**. Every run appends to `data/archive/` and refreshes the site data. With cron:

```cron
15 */2 * * * cd /Users/cj/code/cjpais/taiwan-waves && ~/.bun/bin/bun run fetch >> data/fetch.log 2>&1
```

If you deploy the static build somewhere, run `bun run fetch && bun run build` on the schedule instead. Spot pages embed CWA's forecast at build time.

### Two years of history

```sh
bun run backfill:history          # all wave buoys, roughly 30–60 min
bun run backfill:history 46699A   # one station
```

This pulls about 2 years per buoy from the JSON behind CWA's ocean portal (ocean.cwa.gov.tw). That portal is **undocumented and unofficial**, so the backfill only fills gaps; official open-data values always win. Every archive row carries a `source` column: `O-B0075` (official open data) or `ocean.cwa.gov.tw` (portal backfill). Don't run a backfill and a fetch at the same time; both rewrite the same CSVs. If they do overlap, the next fetch re-fills anything lost from the last 48 h.

## Map

MapLibre map in 3D (terrain ×1.5, tilted 50° by default; right-drag or ctrl-drag to rotate/tilt, the compass button resets). Satellite is the default; a **Map / Satellite** toggle switches looks and is remembered per browser. Roads are pared back to faint highways and main roads so the coast and ocean stay the focus.

| Layer | Source | Served from |
|---|---|---|
| Basemap (roads, labels, land) | [Protomaps](https://protomaps.com) extract of OpenStreetMap, 116–126.5°E × 19–28.5°N, zoom 0–15 (~490 MB PMTiles) | R2 → `tiles.swell.fyi/taiwan/{z}/{x}/{y}.mvt` |
| Depth bands + contours | NOAA ETOPO 2022, public domain | `public/map/bathymetry.geojson` (site) |
| 3D terrain (+ shading in Map mode) | AWS Terrain Tiles (Mapzen), terrarium encoding; the browser flattens anything below sea level so the sea surface stays at 0 m | `tiles.swell.fyi/terrain/{z}/{x}/{y}.png` (proxied: AWS sends no CORS) |
| Satellite, wide | EOxCloudless Sentinel-2 2024 mosaic (10 m), CC BY-NC-SA 4.0 | EOX's tile server |
| Satellite, Taiwan close-up | NLSC aerial photos (內政部國土測繪中心), free to use with attribution | NLSC's WMTS, fades in from zoom 10 |

**Tile server** (`workers/tiles`, Worker `swell-tiles` on `tiles.swell.fyi`): reads the PMTiles archive from R2 through a binding and serves single tiles through Cloudflare's edge cache (1 day), so R2 is only hit on cache misses. It also serves `/taiwan.json` (TileJSON) and `/taiwan.pmtiles` (raw, with range requests), and allows CORS for `https://swell.fyi` and `http://localhost:4747`. Every tile request counts against Workers' free 100k requests/day; a map view is roughly 20–80 tiles.

```sh
brew install pmtiles
bun run tiles          # extract → tiles/taiwan.pmtiles (gitignored)
bun run tiles:upload   # upload to R2, any size (temporary upload Worker, no S3 keys needed)
bun run deploy:tiles   # deploy the tile Worker
bun run bathymetry     # regenerate public/map/bathymetry.geojson (needs uv)
```

`tiles:upload` exists because `wrangler r2 object put` stops at 315 MB. It deploys `workers/upload` with a one-time secret, uploads in 64 MB multipart chunks through the Worker's R2 binding, then deletes the Worker.

## Deployment (swell.fyi)

| What | Where |
|---|---|
| Site | **https://swell.fyi**, a static Cloudflare Worker (`wrangler.jsonc`, assets only) |
| Basemap + terrain | `https://tiles.swell.fyi`, the `swell-tiles` Worker (`workers/tiles`) over R2 bucket `taiwan-waves` |
| Archive | `taiwan-waves/archive/cwa-archive.tar.gz` in R2, plus `archive/daily/YYYY-MM-DD.tar.gz` copies (expire after 90 days) |

`.github/workflows/refresh.yml` runs hourly. It pulls the archive from R2, runs `fetch`, pushes the archive back, then builds and deploys. `scripts/archive-sync.sh push` refuses to upload an archive with fewer rows than it pulled, so a broken run can't erase history. The workflow needs these repo secrets:

- `CLOUDFLARE_API_TOKEN`: create from the **"Edit Cloudflare Workers"** template (Workers Scripts, Routes and R2 edit), limited to this account and the `swell.fyi` zone
- `CLOUDFLARE_ACCOUNT_ID`
- `CWA_API_KEY` (optional)

Manual deploy from a laptop: `scripts/archive-sync.sh pull && bun run fetch && scripts/archive-sync.sh push && bun run build && npx wrangler deploy`.

The scripts read `SWELL_R2_BUCKET`, `TILES_BUILD` and `TILES_MAXZOOM`, deliberately not a generic `R2_BUCKET`, so a variable set for another project can't redirect uploads.

## CWA API key (optional)

Without a key, `fetch` reads CWA's public S3 bucket directly. With a key it goes through the official file API, which redirects to the same files. To use one, register at <https://opendata.cwa.gov.tw> (free), then:

```sh
CWA_API_KEY=CWA-XXXX... bun run fetch
```

A key also unlocks the REST datastore, which filters by station, element and time. See RESEARCH.md.

## Where things are

| Path | What |
|---|---|
| `scripts/fetch-cwa.ts` | Downloads O-B0075-001/-002 (obs), O-B0076-001 (stations), M-B0078-001 (recreation forecast) and F-A0021-001 (tides), then archives and publishes them |
| `scripts/backfill-ocean.ts` | ~2-year history backfill from the ocean portal |
| `scripts/lib/archive.ts` | Archive CSV format and merge rules |
| `data/archive/cwa-obs/{station}.csv` | **The long-term record.** Hourly, one file per station |
| `data/archive/cwa-recreation-forecast/{point}.csv` | Every CWA forecast issue for the spot points, with lead time, for scoring CWA later |
| `public/data/` | What the site reads: generated, safe to delete and re-fetch |
| `src/data/spots.ts` | Surf spots: coordinates, CWA forecast point, reference buoys. Add spots here |
| `src/lib/openmeteo.ts` | Model list and Open-Meteo requests |
| `src/lib/map.ts` | MapLibre map: Protomaps style, depth layers, markers |
| `scripts/tiles.sh`, `scripts/tiles-upload.sh`, `scripts/bathymetry.py` | Build/upload the basemap and the depth contours |
| `workers/tiles` | Tile server Worker (basemap + terrain, edge-cached) |

Archive columns: `time` (ISO, +08:00), `wave_height_m` (Hs), `wave_dir_deg` (from), `wave_period_s` (mean period, not peak), `sea_temp_c`, `air_temp_c`, `pressure_hpa`, `wind_speed_ms`, `wind_dir_deg` (from), `wind_gust_ms`, `tide_height_m` (TWVD2001), `current_dir_deg` (toward), `current_speed_ms`, `source`.

## Caveats

- **Open-Meteo's free API is non-commercial only.** Fine for personal use; a public or commercial site needs a paid plan, or a switch to raw NOAA/ECMWF/Copernicus data.
- **Buoys are not beaches.** Several sit close inshore or in a lee, so they read lower than the open ocean the models represent. Guishan (46708A), for example, sits west of the island. Models also read high relative to most CWA buoys, as the scoring tables show.
- **Directions differ by quantity.** CWA forecast directions are 16-point compass, so they step in 22.5° increments. Current directions are "toward"; wave and wind directions are "from".
