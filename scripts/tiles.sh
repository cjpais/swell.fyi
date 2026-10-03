#!/usr/bin/env bash
# Build the Taiwan basemap (Protomaps / OpenStreetMap) as one PMTiles file.
#
#   bun run tiles              extract to tiles/taiwan.pmtiles (~490 MB at zoom 15)
#   bun run tiles:upload       upload it to R2 (any size; see scripts/tiles-upload.sh)
#
# Needs the pmtiles CLI (`brew install pmtiles`). The map changes slowly; rerun every few months.
set -euo pipefail
cd "$(dirname "$0")/.."

BBOX="116.0,19.0,126.5,28.5"   # Taiwan + Fujian coast, Ryukyus, Luzon Strait; matches bathymetry.py and map.ts
MAXZOOM="${TILES_MAXZOOM:-15}"  # z15 ≈ 490 MB, z14 ≈ 235 MB
BUILD="${TILES_BUILD:-$(curl -fsS https://build-metadata.protomaps.dev/builds.json | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["key"])')}"

mkdir -p tiles
echo "Extracting $BUILD → tiles/taiwan.pmtiles (bbox $BBOX, maxzoom $MAXZOOM)"
pmtiles extract "https://build.protomaps.com/$BUILD" tiles/taiwan.pmtiles --bbox="$BBOX" --maxzoom="$MAXZOOM"
