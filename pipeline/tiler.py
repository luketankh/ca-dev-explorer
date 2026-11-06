"""Minimal pure-Python vector tiler: GeoDataFrame -> PMTiles (MVT, gzip).

A stand-in for tippecanoe. Fine for county/state-sized layers in this MVP:
  - clips and simplifies per tile, drops sub-pixel polygons at low zooms
  - point layers can be aggregated to a pixel grid at low zooms (adds a `n` count property)
"""
from __future__ import annotations

import gzip
import json
import math
import multiprocessing as mp
from pathlib import Path

import geopandas as gpd
import mapbox_vector_tile
import mercantile
import numpy as np
import pandas as pd
import shapely
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

EXTENT = 4096
WORLD = 2 * math.pi * 6378137

_G = {}  # per-worker globals (populated before fork)


def _tile_bounds(z, x, y):
    b = mercantile.xy_bounds(x, y, z)
    return b.left, b.bottom, b.right, b.top


def _clean_props(row: dict) -> dict:
    out = {}
    for k, v in row.items():
        if v is None or (isinstance(v, float) and math.isnan(v)) or v is pd.NA:
            continue
        if isinstance(v, (np.integer,)):
            v = int(v)
        elif isinstance(v, (np.floating,)):
            v = float(v)
        elif isinstance(v, (np.bool_, bool)):
            v = int(bool(v))
        out[k] = v
    return out


def _encode_tile(args):
    z, x, y = args
    geoms, props, tree, layer = _G["geoms"], _G["props"], _G["tree"], _G["layer"]
    simplify_px, min_area_px, buffer_px = _G["simplify_px"], _G["min_area_px"], _G["buffer_px"]
    minx, miny, maxx, maxy = _tile_bounds(z, x, y)
    px = (maxx - minx) / EXTENT
    buf = buffer_px * px
    idx = tree.query(shapely.box(minx - buf, miny - buf, maxx + buf, maxy + buf))
    if len(idx) == 0:
        return None
    g = geoms[idx]
    if _G["is_point"]:
        clipped = g
    else:
        if min_area_px:
            keep = shapely.area(g) >= min_area_px * px * px
            idx, g = idx[keep], g[keep]
            if len(idx) == 0:
                return None
        g = shapely.simplify(g, simplify_px * px, preserve_topology=True) if simplify_px else g
        clipped = shapely.clip_by_rect(g, minx - buf, miny - buf, maxx + buf, maxy + buf)
    feats = []
    for i, geom in zip(idx, clipped):
        if geom is None or geom.is_empty:
            continue
        if geom.geom_type == "GeometryCollection":
            polys = [p for p in geom.geoms if p.geom_type in ("Polygon", "MultiPolygon")]
            lines = [p for p in geom.geoms if p.geom_type in ("LineString", "MultiLineString")]
            parts = polys or lines
            if not parts:
                continue
            geom = shapely.union_all(parts)
            if geom.is_empty or geom.geom_type == "GeometryCollection":
                continue
        feats.append({"geometry": geom, "properties": props[i]})
    if not feats:
        return None
    data = mapbox_vector_tile.encode(
        [{"name": layer, "features": feats}],
        default_options={"quantize_bounds": (minx, miny, maxx, maxy), "extents": EXTENT,
                         "y_coord_down": False},
    )
    return zxy_to_tileid(z, x, y), gzip.compress(data)


def _aggregate_points(gdf3857: gpd.GeoDataFrame, z: int, group_cols: list[str],
                      cell_px: int = 4) -> gpd.GeoDataFrame:
    """Snap points to a grid of `cell_px` tile-pixels at zoom z; count per cell+group."""
    cell = WORLD / (2 ** z) / EXTENT * cell_px
    df = pd.DataFrame({
        "cx": np.floor(gdf3857.geometry.x / cell).astype(np.int64),
        "cy": np.floor(gdf3857.geometry.y / cell).astype(np.int64),
        **{c: gdf3857[c].values for c in group_cols},
    })
    agg = df.groupby(["cx", "cy", *group_cols], as_index=False).size().rename(columns={"size": "n"})
    pts = gpd.points_from_xy((agg.cx + 0.5) * cell, (agg.cy + 0.5) * cell, crs=3857)
    return gpd.GeoDataFrame(agg[[*group_cols, "n"]], geometry=pts, crs=3857)


def make_pmtiles(gdf: gpd.GeoDataFrame, out: Path, layer: str, minzoom: int, maxzoom: int,
                 props: list[str], simplify_px: float = 1.0, min_area_px: float = 0.0,
                 min_area_px_maxzoom: float = 0.0, buffer_px: int = 16,
                 aggregate_points_below: int | None = None, aggregate_group: list[str] | None = None,
                 attribution: str = "", processes: int | None = None) -> None:
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].to_crs(3857).reset_index(drop=True)
    is_point = bool((gdf.geom_type == "Point").all())
    wgs = gdf.to_crs(4326).total_bounds
    tiles: dict[int, bytes] = {}
    for z in range(minzoom, maxzoom + 1):
        layer_gdf = gdf
        if is_point and aggregate_points_below is not None and z < aggregate_points_below:
            layer_gdf = _aggregate_points(gdf, z, aggregate_group or [])
        zprops = [c for c in [*props, "n"] if c in layer_gdf.columns]
        records = layer_gdf[zprops].to_dict("records")
        geoms = layer_gdf.geometry.values._data if hasattr(layer_gdf.geometry.values, "_data") \
            else np.asarray(layer_gdf.geometry.values)
        _G.update(
            geoms=np.asarray(geoms), props=[_clean_props(r) for r in records],
            tree=shapely.STRtree(np.asarray(geoms)), layer=layer, is_point=is_point,
            simplify_px=simplify_px, buffer_px=buffer_px,
            min_area_px=min_area_px_maxzoom if z == maxzoom else min_area_px,
        )
        # tiles touched by any feature bbox
        b4326 = layer_gdf.to_crs(4326).bounds.values
        keys = set()
        for x0, y0, x1, y1 in b4326:
            for t in mercantile.tiles(max(x0, -180), max(y0, -85), min(x1, 180), min(y1, 85), z):
                keys.add((t.z, t.x, t.y))
        ctx = mp.get_context("fork")
        with ctx.Pool(processes or max(1, mp.cpu_count() - 1)) as pool:
            for res in pool.imap_unordered(_encode_tile, sorted(keys), chunksize=16):
                if res:
                    tiles[res[0]] = res[1]
        print(f"  {layer} z{z}: {len(keys):,} tiles, {len(layer_gdf):,} features")

    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        w = Writer(f)
        for tid in sorted(tiles):
            w.write_tile(tid, tiles[tid])
        fields = {c: ("Number" if pd.api.types.is_numeric_dtype(gdf[c]) else "String")
                  for c in props if c in gdf.columns}
        if aggregate_points_below is not None:
            fields["n"] = "Number"
        w.finalize(
            {
                "tile_type": TileType.MVT, "tile_compression": Compression.GZIP,
                "min_zoom": minzoom, "max_zoom": maxzoom,
                "min_lon_e7": int(wgs[0] * 1e7), "min_lat_e7": int(wgs[1] * 1e7),
                "max_lon_e7": int(wgs[2] * 1e7), "max_lat_e7": int(wgs[3] * 1e7),
                "center_zoom": minzoom,
                "center_lon_e7": int((wgs[0] + wgs[2]) / 2 * 1e7),
                "center_lat_e7": int((wgs[1] + wgs[3]) / 2 * 1e7),
            },
            {"vector_layers": [{"id": layer, "fields": fields, "minzoom": minzoom,
                                "maxzoom": maxzoom}], "attribution": attribution},
        )
    print(f"  wrote {out.name}: {len(tiles):,} tiles, {out.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    print(json.dumps({"ok": True}))
