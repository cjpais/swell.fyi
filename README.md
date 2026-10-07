# Taiwan Waves

A no-nonsense explorer for Taiwan's open ocean data, built for surfing. It shows:

- **Buoy truth.** Hourly observations from every CWA marine station: wave height, period, direction, wind, water temperature, tide and current. History is archived locally, so it grows beyond the 30 days CWA keeps.
- **CWA's own surf forecast.** M-B0078-001 (WW3-based, 72 h, 3-hourly) for 13 named surf spots plus beaches and harbours.
- **Three global wave models side by side**, via Open-Meteo: Météo-France MFWAM, NOAA GFS-Wave and ECMWF WAM. Swell partitions come from MFWAM and GFS.
- **Four wind forecasts per spot:** ECMWF IFS and GFS via Open-Meteo, and CWA's own regional WRF at 3 km (M-A0064) and 15 km (M-A0061), 6-hourly to 84 h.
- **Model scoring.** Each buoy page computes every model's bias, RMSE and correlation against the buoy, so you can see which source to trust where.
- **Raw downloads everywhere.** Each station's full CSV archive, and a merged CSV of every series on a spot page.

See [RESEARCH.md](RESEARCH.md) (also served at `/research/`) for the full survey: what data exists, which models are best for Taiwan, and where apps like Swelleye and Surfline get theirs.

## Run it

```sh
bun install
bun run dev              # http://localhost:4747 (map tiles come from https://tiles.swell.fyi)
```

The site is static and holds no readings. Its live data comes from the `swell-data` Worker at `https://data.swell.fyi` (buoys, tides, CWA's forecast, the model forecasts). The home and spot pages get theirs as one small file per page, which the site Worker writes into the HTML as it serves it, so their numbers draw without another round trip (in `astro dev`, the page fetches the same file instead). Other pages fetch from `data.swell.fyi` in the browser, and spot and buoy pages call Open-Meteo directly for the model comparison charts. `bun run build` reads only the station list (names, IDs, positions), from the Worker, so a build needs no fetch first.

To work offline against local files instead:

```sh
bun run fetch            # CWA data → public/data/cwa/ (and grows data/archive/)
bun run fetch:field      # map field → public/data/field.json
bun run fetch:wrf        # CWA WRF spot winds → public/data/cwa/wrf-wind.json
bun run fetch:pages      # each page's slice of the above → public/data/pages/
PUBLIC_DATA_BASE=/data bun run dev
```

## Keep the archive growing

CWA's live feed only covers 48 hours, so something has to run `bun run fetch` at least every day or so. In production that's `.github/workflows/refresh.yml`, every 3 hours (see below). The live site doesn't depend on it; only the long-term archive does.

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
| Site | **https://swell.fyi**, static assets plus a small Worker (`wrangler.jsonc`, `workers/site`) that writes each page's data from R2 (`pages/*`) into the home and spot pages' HTML |
| Basemap + terrain | `https://tiles.swell.fyi`, the `swell-tiles` Worker (`workers/tiles`) over R2 bucket `taiwan-waves` |
| Live data | `https://data.swell.fyi`, the `swell-data` Worker (`workers/data`) over R2: `field.json` (map forecast) and `cwa/*` (buoys, tides, CWA forecast, archive CSVs). `/status` shows when each was built |
| Archive | `taiwan-waves/archive/cwa-archive.tar.gz` in R2, plus `archive/daily/YYYY-MM-DD.tar.gz` copies (expire after 90 days) |

Two workflows:

- **`deploy.yml`** builds and deploys the site on every push to `main`. That's the only reason the site redeploys; data changes never need one.
- **`refresh.yml`** grows the archive every 3 hours: it pulls the archive from R2, runs `fetch`, pushes the archive back, then runs `scripts/publish-archive.sh` to upload each station's CSV and `archive-index.json` for the Worker to serve. `scripts/archive-sync.sh push` refuses to upload an archive with fewer rows than it pulled, so a broken run can't erase history. GitHub's schedule is best-effort; a late run is fine, as long as one lands every day or so.

Both need these repo secrets:

- `CLOUDFLARE_API_TOKEN`: create from the **"Edit Cloudflare Workers"** template (Workers Scripts, Routes and R2 edit), limited to this account and the `swell.fyi` zone
- `CLOUDFLARE_ACCOUNT_ID`
- `CWA_API_KEY` (optional)

Manual site deploy from a laptop: `bun run build && npx wrangler deploy`. Manual archive run: `scripts/archive-sync.sh pull && bun run fetch && scripts/archive-sync.sh push && scripts/publish-archive.sh`.

The scripts read `SWELL_R2_BUCKET`, `TILES_BUILD` and `TILES_MAXZOOM`, deliberately not a generic `R2_BUCKET`, so a variable set for another project can't redirect uploads.

### Live data (`swell-data` Worker)

A cron runs every 20 minutes, at :13, :33 and :53: CWA's new buoy readings land at about :30 and corrections at :50. Each part checks cheaply whether its upstream changed and only rebuilds when it has; everything lands in R2 and is served through the edge cache (5 min), so visitor traffic never reaches CWA or Open-Meteo.

- **Map forecast, `field.json`:** a 0.5° wave + wind grid and per-spot MFWAM / ECMWF IFS series, about 350 Open-Meteo calls per build. It rebuilds when Open-Meteo's model metadata shows a new MFWAM or ECMWF IFS run, or the file is over 6 h old: about 6 builds and roughly 2k calls a day, under the free tier's 10k.
- **CWA, `cwa/*`:** it HEADs CWA's four S3 files (buoy obs, stations, recreation forecast, tides) and re-derives only the ones whose ETag changed. CWA rewrites the obs file every ~10 minutes, but its readings only change once an hour (at about half past) plus a few corrections at :50, so the Worker hashes them and skips the rewrite when they're the same. Each station's last 120 days (`cwa/obs/{id}.json`) are kept by merging every new 48 h file in; the station list (`stations.json`), the home page sparklines (`recent-hs.json`), and per-spot slices of the forecast and tides (`spot-forecast.json`, `spot-tides.json`) are derived from them. The parsing lives in `scripts/lib/cwa.ts`, shared with `bun run fetch`.
- **CWA WRF wind, `cwa/wrf-wind.json`:** 10 m wind at each spot's offshore `model` point from the 3 km and 15 km runs, every 6 h to 84 h. It HEADs each model's last lead file (+84 h, the last one a run writes, about 6 h after init) and rebuilds a model when its ETag changes. The GRIB2 files are 60–180 MB each, so the build reads only headers and the bytes around the spots with Range requests: about 140 small requests per model. The build lives in `scripts/lib/wrf.ts`, shared with `bun run fetch:wrf`.
- **Page data, `pages/home.json` and `pages/spots/{id}.json`:** each page's slice of all of the above (CWA's forecast, tide, the working buoy's last two days, WRF, and the spot's entry in `field.json`), cut by `scripts/lib/pages.ts` after the other parts run, whenever one of their files has changed and at least hourly. The site Worker inlines them; `/pages/...` serves them to pages that weren't.
- **Archive CSVs, `cwa/csv/*` and `cwa/archive-index.json`:** uploaded by `refresh.yml`, not the Worker. The Worker only reads the index, to show each station's archive size.

```sh
bun run deploy:data                                                  # deploy the Worker (and its cron)
npx wrangler tail swell-data                                         # watch runs
curl https://data.swell.fyi/status                                   # when each part was last built
curl -X POST -H "Authorization: Bearer $(cat ~/.config/swell/refresh-token)" "https://data.swell.fyi/refresh?force=1"   # rebuild now (&only=field|cwa|wrf|pages)
npx wrangler secret put OPEN_METEO_API_KEY -c workers/data/wrangler.jsonc   # optional, commercial plan
npx wrangler secret put CWA_API_KEY -c workers/data/wrangler.jsonc          # optional
```

After a history backfill (or to rebuild the 120-day windows from scratch), run `bun run fetch && scripts/publish-archive.sh --windows`.

A full CWA refresh takes about 750 ms of CPU and a map build about 100 ms, both over the Workers Free plan's 10 ms, so this needs Workers Paid. If data is missing or old, pages say so instead of showing blanks.

## CWA API key (optional)

Without a key, `fetch` reads CWA's public S3 bucket directly. With a key it goes through the official file API, which redirects to the same files. To use one, register at <https://opendata.cwa.gov.tw> (free), then:

```sh
CWA_API_KEY=CWA-XXXX... bun run fetch
```

A key also unlocks the REST datastore, which filters by station, element and time. See RESEARCH.md.

## Where things are

| Path | What |
|---|---|
| `scripts/fetch-cwa.ts` | Downloads O-B0075-001/-002 (obs), O-B0076-001 (stations), M-B0078-001 (recreation forecast) and F-A0021-001 (tides), grows the archive and writes a local snapshot to `public/data/cwa/` |
| `scripts/lib/cwa.ts` | CWA download, parsing and the derived JSON, shared by `fetch-cwa.ts` and the Worker |
| `scripts/publish-archive.sh` | Uploads the archive CSVs (and with `--windows`, the 120-day windows) to R2 |
| `scripts/backfill-ocean.ts` | ~2-year history backfill from the ocean portal |
| `scripts/lib/archive.ts` | Archive CSV format and merge rules |
| `data/archive/cwa-obs/{station}.csv` | **The long-term record.** Hourly, one file per station |
| `data/archive/cwa-recreation-forecast/{point}.csv` | Every CWA forecast issue for the spot points, with lead time, for scoring CWA later |
| `public/data/` | Local snapshot for offline work (`PUBLIC_DATA_BASE=/data`): generated, safe to delete and re-fetch |
| `src/lib/data.ts` | Where the browser loads live data from, and its types |
| `src/data/spots.ts` | Surf spots: coordinates, CWA forecast point, reference buoys. Add spots here |
| `src/lib/openmeteo.ts` | Model list and Open-Meteo requests |
| `src/lib/map.ts` | MapLibre map: Protomaps style, depth layers, markers |
| `scripts/tiles.sh`, `scripts/tiles-upload.sh`, `scripts/bathymetry.py` | Build/upload the basemap and the depth contours |
| `workers/tiles` | Tile server Worker (basemap + terrain, edge-cached) |
| `workers/data`, `scripts/lib/field.ts` | Live data Worker (map forecast and CWA), and the field build it shares with `fetch:field` |
| `scripts/lib/pages.ts` | Each page's data file, cut from the Worker's files; shared by the Worker and `fetch:pages` |
| `workers/site` | The site's Worker: serves `dist/` and writes each page's data into the home and spot pages |
| `scripts/lib/wrf.ts` | CWA WRF spot winds: GRIB2 header parsing, Lambert grid lookup, Range reads; shared by the Worker and `fetch:wrf` |

Archive columns: `time` (ISO, +08:00), `wave_height_m` (Hs), `wave_dir_deg` (from), `wave_period_s` (mean period, not peak), `sea_temp_c`, `air_temp_c`, `pressure_hpa`, `wind_speed_ms`, `wind_dir_deg` (from), `wind_gust_ms`, `tide_height_m` (TWVD2001), `current_dir_deg` (toward), `current_speed_ms`, `source`.

## Caveats

- **Open-Meteo's free API is non-commercial only.** Fine for personal use; a public or commercial site needs a paid plan, or a switch to raw NOAA/ECMWF/Copernicus data.
- **Buoys are not beaches.** Several sit close inshore or in a lee, so they read lower than the open ocean the models represent. Guishan (46708A), for example, sits west of the island. Models also read high relative to most CWA buoys, as the scoring tables show.
- **Directions differ by quantity.** CWA forecast directions are 16-point compass, so they step in 22.5° increments. Current directions are "toward"; wave and wind directions are "from".
