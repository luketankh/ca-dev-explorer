"""Terrain helper: USGS 3DEP 1 arc-second (~30 m) bare-earth elevation -> slope for the AOI.

Downloads the 1x1 degree 3DEP tiles covering the AOI (cached in data/raw/dem/), mosaics them,
reprojects to California Albers (EPSG:3310) on a 25 m grid aligned to the 500 m model cells, and
computes slope in percent (rise / run x 100).

Development rules of thumb used here (common in California hillside ordinances):
  <= 15 % slope   buildable for normal subdivisions
  15 - 25 %       hillside: possible but costly (grading, retaining walls) -> counts half
  > 25 %          generally not buildable for tract housing
"""
from __future__ import annotations

import math

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform_bounds

from common import AOI_BBOX, PROCESSED, RAW, session

TNM = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current/{t}/USGS_1_{t}.tif"
RES = 25.0
ALBERS = "EPSG:3310"
SLOPE_OK, SLOPE_MAX = 15.0, 25.0


def _tiles(bbox):
    xmin, ymin, xmax, ymax = bbox
    out = []
    for lat in range(math.floor(ymin) + 1, math.ceil(ymax) + 1):        # tile named by its north edge
        for lon in range(math.ceil(-xmax), math.ceil(-xmin) + 1):         # ... and its west edge
            out.append(f"n{lat:02d}w{lon:03d}")
    return out


def _download():
    d = RAW / "dem"
    d.mkdir(parents=True, exist_ok=True)
    paths = []
    for t in _tiles(AOI_BBOX):
        p = d / f"USGS_1_{t}.tif"
        if not p.exists():
            print(f"  downloading 3DEP tile {t} ...")
            with session.get(TNM.format(t=t), stream=True, timeout=600) as r:
                r.raise_for_status()
                tmp = p.with_suffix(".part")
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
                tmp.rename(p)
        paths.append(p)
    return paths


def load_dem_slope():
    """Return (elevation_m, slope_pct, transform) on the 25 m Albers grid, cached as GeoTIFFs."""
    elev_p, slope_p = PROCESSED / "dem_25m.tif", PROCESSED / "slope_pct_25m.tif"
    if elev_p.exists() and slope_p.exists():
        with rasterio.open(elev_p) as e, rasterio.open(slope_p) as s:
            return e.read(1), s.read(1), e.transform

    paths = _download()
    pad = 0.03
    xmin, ymin, xmax, ymax = AOI_BBOX
    srcs = [rasterio.open(p) for p in paths]
    mosaic, m_tr = merge(srcs, bounds=(xmin - pad, ymin - pad, xmax + pad, ymax + pad))
    src_crs = srcs[0].crs
    nodata = srcs[0].nodata
    for s in srcs:
        s.close()

    axmin, aymin, axmax, aymax = transform_bounds("EPSG:4326", ALBERS, xmin - pad, ymin - pad, xmax + pad, ymax + pad)
    axmin, aymin = math.floor(axmin / 500) * 500, math.floor(aymin / 500) * 500   # align to model cells
    axmax, aymax = math.ceil(axmax / 500) * 500, math.ceil(aymax / 500) * 500
    w, h = int((axmax - axmin) / RES), int((aymax - aymin) / RES)
    tr = from_origin(axmin, aymax, RES, RES)
    elev = np.full((h, w), np.nan, dtype="float32")
    reproject(mosaic[0].astype("float32"), elev, src_transform=m_tr, src_crs=src_crs, src_nodata=nodata,
              dst_transform=tr, dst_crs=ALBERS, dst_nodata=np.nan, resampling=Resampling.bilinear)

    gy, gx = np.gradient(elev, RES, RES)
    slope = (100 * np.hypot(gx, gy)).astype("float32")

    prof = {"driver": "GTiff", "height": h, "width": w, "count": 1, "dtype": "float32", "crs": ALBERS,
            "transform": tr, "nodata": np.nan, "compress": "deflate"}
    for arr, p in ((elev, elev_p), (slope, slope_p)):
        with rasterio.open(p, "w", **prof) as dst:
            dst.write(arr, 1)
    print(f"  slope grid {w}x{h} at {RES:.0f} m written")
    return elev, slope, tr


def cell_terrain(cells_xy_min, elev, slope, tr, cell=500):
    """Per 500 m cell (given lower-left corners): mean elevation, mean slope, buildable share."""
    n = int(cell / RES)
    x0, y0 = tr.c, tr.f
    out = []
    for cx, cy in cells_xy_min:
        col = int(round((cx - x0) / RES))
        row = int(round((y0 - (cy + cell)) / RES))
        s = slope[row:row + n, col:col + n]
        e = elev[row:row + n, col:col + n]
        valid = np.isfinite(s)
        if not valid.any():
            out.append((np.nan, np.nan, 0.0, 0.0, 0.0))
            continue
        sv = s[valid]
        ok = float((sv <= SLOPE_OK).mean())
        mid = float(((sv > SLOPE_OK) & (sv <= SLOPE_MAX)).mean())
        out.append((float(np.nanmean(e)), float(sv.mean()), ok, mid, ok + 0.5 * mid))
    return out
