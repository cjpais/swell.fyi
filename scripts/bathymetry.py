# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "contourpy", "shapely"]
# ///
"""Depth bands + contour lines around Taiwan, as GeoJSON for the map.

    uv run scripts/bathymetry.py

Source: NOAA NCEI ETOPO 2022 15 arc-second (~450 m) global relief, public domain,
fetched from the NOAA CoastWatch ERDDAP server. Coastal shallows are approximate at
this resolution; the map draws OSM land on top, so the coastline itself comes from OSM.
"""

import json
import urllib.request
from pathlib import Path

import contourpy
import numpy as np
from scipy.io import netcdf_file
from scipy.ndimage import gaussian_filter
from shapely.geometry import LineString, MultiPolygon, Polygon, mapping
from shapely.ops import unary_union

BBOX = (116.0, 19.0, 126.5, 28.5)  # W, S, E, N; matches scripts/tiles.sh and the map's maxBounds
URL = (
    "https://coastwatch.pfeg.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.nc"
    f"?z%5B({BBOX[1]}):1:({BBOX[3]})%5D%5B({BBOX[0]}):1:({BBOX[2]})%5D"
)
# Depths in metres (positive down). Bands run between consecutive values.
DEPTHS = [0, 50, 100, 200, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 11000]
LINE_DEPTHS = [50, 100, 200, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000]
SIMPLIFY_DEG = 0.0015  # ~150 m
SMOOTH_CELLS = 1.0  # gaussian sigma in grid cells (~450 m); removes single-cell specks
MIN_AREA_DEG2 = 2e-5  # drop polygon pieces and holes smaller than ~0.25 km²
CACHE = Path(f"/tmp/etopo_15s_{'_'.join(map(str, BBOX))}.nc")
OUT = Path(__file__).resolve().parent.parent / "public" / "map" / "bathymetry.geojson"


def load():
    if not CACHE.exists():
        print("Downloading ETOPO 2022 subset…")
        urllib.request.urlretrieve(URL, CACHE)
    with netcdf_file(CACHE, mmap=False) as f:
        lat = f.variables["latitude"][:].copy()
        lon = f.variables["longitude"][:].copy()
        z = f.variables["z"][:].astype("float64").copy()
    if lat[0] > lat[-1]:
        lat, z = lat[::-1], z[::-1]
    return lon, lat, -z  # depth, positive down; land is negative


def rnd(geom):
    """Round coordinates to 4 decimals (~11 m) to keep the file small."""
    def r(c):
        return [[round(x, 4), round(y, 4)] for x, y in c]
    m = mapping(geom)
    t = m["type"]
    if t == "Polygon":
        return {"type": t, "coordinates": [r(ring) for ring in m["coordinates"]]}
    if t == "MultiPolygon":
        return {"type": t, "coordinates": [[r(ring) for ring in poly] for poly in m["coordinates"]]}
    if t == "LineString":
        return {"type": t, "coordinates": r(m["coordinates"])}
    if t == "MultiLineString":
        return {"type": t, "coordinates": [r(line) for line in m["coordinates"]]}
    raise ValueError(t)


def main():
    lon, lat, depth = load()
    print(f"grid {depth.shape}, depth {np.nanmin(depth):.0f}…{np.nanmax(depth):.0f} m")
    depth = gaussian_filter(depth, SMOOTH_CELLS)
    gen = contourpy.contour_generator(lon, lat, depth, fill_type="OuterOffset", line_type="Separate")
    features = []

    for lo, hi in zip(DEPTHS[:-1], DEPTHS[1:]):
        points, offsets = gen.filled(lo, hi)
        polys = []
        for pts, offs in zip(points, offsets):
            rings = [pts[offs[i]:offs[i + 1]] for i in range(len(offs) - 1)]
            holes = [h for h in rings[1:] if Polygon(h).area >= MIN_AREA_DEG2]
            p = Polygon(rings[0], holes).buffer(0)
            if not p.is_empty:
                polys.append(p)
        if not polys:
            continue
        geom = unary_union(polys).simplify(SIMPLIFY_DEG, preserve_topology=True)
        geom = MultiPolygon([g for g in getattr(geom, "geoms", [geom]) if g.area >= MIN_AREA_DEG2])
        features.append({"type": "Feature", "properties": {"kind": "band", "min": lo, "max": hi}, "geometry": rnd(geom)})

    for d in LINE_DEPTHS:
        for line in gen.lines(d):
            ls = LineString(line).simplify(SIMPLIFY_DEG)
            if ls.length < 0.02:  # drop tiny rings (seamount specks)
                continue
            features.append({"type": "Feature", "properties": {"kind": "line", "depth": d}, "geometry": rnd(ls)})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    fc = {
        "type": "FeatureCollection",
        "attribution": "Bathymetry: NOAA NCEI ETOPO 2022 (15 arc-second), public domain",
        "features": features,
    }
    OUT.write_text(json.dumps(fc, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB, {len(features)} features)")


if __name__ == "__main__":
    main()
