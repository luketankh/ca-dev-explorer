"""Where should residential developers build next?  A transparent suitability model + backtest.

The county is cut into 500 m x 500 m cells. For a reference year Y each cell gets:

  momentum    0-1  Is it just ahead of where new homes went in the last 5 years?  Every cluster of
                   new homes (same clusters as the growth arrows) projects a Gaussian "next ring"
                   1.5 km ahead of itself along its growth bearing (sigma 1.2 km), weighted by
                   sqrt(homes). Infill clusters project a smaller, round kernel.
  room        0-1  Is the cell still mostly undeveloped? (building footprint < 6% of the cell -> 1,
                   6-12% -> 0.5, more -> 0)
  adjacency   0-1  Is it next to existing urban land? 1 within 1 km of a built-up cell, falling to 0
                   at 4 km (leapfrog development is rare).
  fire risk   0-1  0.5 x Fire Hazard Severity Zone at the cell (Moderate .4 / High .7 / Very High 1)
                   + 0.3 x share of the land within 5 km burned since 2000 (full at 25%)
                   + 0.2 x wildland satellite fire detections within 5 km per 100 km2 (full at 50)
  excluded         Delta Primary Zone (Delta Protection Act), cells > 40% water, outside county.

  suitability = 100 x momentum x room x adjacency x (1 - 0.8 x fire risk)

Adjacent high-scoring cells are merged into ranked "zones". A backtest re-runs the model as of
earlier years and measures how many homes built in the following 5 years landed in the cells it
ranked highest.

Outputs (web/public/data): recommend_cells.geojson, recommend_zones.geojson, recommend.json
"""
import math

import duckdb
import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from sklearn.cluster import DBSCAN
from sklearn.neighbors import NearestNeighbors

from common import AOI_BBOX, OVERTURE_RELEASE, PROCESSED, RAW, WEB_DATA, arcgis_query, write_geojson, write_json

ALBERS, CELL = 3310, 500
YEAR = 2025
BACKTEST_YEARS = [2010, 2013, 2016, 2019]
WINDOW = 5
AHEAD_M, SIGMA_M = 1500, 1200
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
DELTA_URL = "https://gis.water.ca.gov/arcgis/rest/services/Boundaries/i03_Delta_PrimarySecondary_Zones/FeatureServer/0"

county = gpd.read_file(PROCESSED / "aoi_county.geojson").to_crs(ALBERS)
cgeom = county.geometry.iloc[0]
places = gpd.read_file(PROCESSED / "places.geojson").to_crs(ALBERS)

# --- constraint layers (small downloads, cached) ---------------------------------------------
delta_path = RAW / "delta_zones.parquet"
if not delta_path.exists():
    arcgis_query(DELTA_URL, bbox=AOI_BBOX).to_parquet(delta_path)
delta = gpd.read_parquet(delta_path).to_crs(ALBERS)
zone_col = [c for c in delta.columns if c.lower() == "zone"][0]
primary = delta[delta[zone_col].str.contains("Primary", case=False)].geometry.union_all()

water_path = RAW / "overture_water.parquet"
if not water_path.exists():
    xmin, ymin, xmax, ymax = AOI_BBOX
    con = duckdb.connect()
    con.sql("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    con.sql(f"""COPY (SELECT subtype, class, geometry FROM read_parquet(
        's3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}/theme=base/type=water/*', hive_partitioning=1)
        WHERE bbox.xmin <= {xmax} AND bbox.xmax >= {xmin} AND bbox.ymin <= {ymax} AND bbox.ymax >= {ymin}
          AND ST_GeometryType(geometry) IN ('POLYGON', 'MULTIPOLYGON'))
        TO '{water_path}' (FORMAT PARQUET)""")
water = gpd.read_parquet(water_path).set_crs(4326, allow_override=True).to_crs(ALBERS)
water = water[water.geometry.notna() & water.is_valid]

# --- grid -------------------------------------------------------------------------------------
minx, miny, maxx, maxy = cgeom.bounds
xs = np.arange(math.floor(minx / CELL) * CELL, maxx, CELL)
ys = np.arange(math.floor(miny / CELL) * CELL, maxy, CELL)
cells = gpd.GeoDataFrame(geometry=[shapely.box(x, y, x + CELL, y + CELL) for x in xs for y in ys], crs=ALBERS)
cells = cells[cells.intersection(cgeom).area > 0.5 * CELL * CELL].reset_index(drop=True)
cells["cx"], cells["cy"] = cells.centroid.x, cells.centroid.y
area = CELL * CELL
print(f"{len(cells):,} cells of {CELL} m")

cells["in_primary_zone"] = cells.centroid.within(primary)
wi = gpd.overlay(cells[["geometry"]].reset_index(), water[["geometry"]], how="intersection", keep_geom_type=True)
wi["a"] = wi.geometry.area
cells["water_frac"] = (wi.groupby("index")["a"].sum() / area).reindex(cells.index).fillna(0).clip(0, 1)

# --- fire risk (static) -----------------------------------------------------------------------
fhsz = gpd.read_file(PROCESSED / "fhsz.geojson").to_crs(ALBERS)
fhsz = fhsz[fhsz["hazard"].isin(["Moderate", "High", "Very High"])]
cls = gpd.sjoin(gpd.GeoDataFrame(geometry=cells.centroid, crs=ALBERS), fhsz[["hazard", "geometry"]],
                predicate="within", how="left")
cls = cls[~cls.index.duplicated()]["hazard"].map({"Moderate": 0.4, "High": 0.7, "Very High": 1.0})
cells["fhsz"] = cls.fillna(0).values
cells["fhsz_class"] = gpd.sjoin(gpd.GeoDataFrame(geometry=cells.centroid, crs=ALBERS), fhsz[["hazard", "geometry"]],
                                predicate="within", how="left").groupby(level=0)["hazard"].first().fillna("None").values
fires = gpd.read_file(PROCESSED / "fire_perimeters.geojson").to_crs(ALBERS)
fires = fires[fires["year"] >= 2000]
burned = fires.geometry.union_all()
rings = cells.centroid.buffer(5000)
cells["burn_frac_5km"] = rings.intersection(burned).area / rings.area
firms = gpd.read_file(PROCESSED / "firms_modis.geojson").to_crs(ALBERS)
wild = firms.loc[gpd.sjoin(firms[["geometry"]], fhsz[["geometry"]], predicate="within").index.unique()]
det = gpd.sjoin(gpd.GeoDataFrame(geometry=rings, crs=ALBERS), wild[["geometry"]], predicate="contains")
cells["wild_det_5km"] = det.groupby(level=0).size().reindex(cells.index).fillna(0).values
cells["fire_risk"] = (0.5 * cells["fhsz"] + 0.3 * (cells["burn_frac_5km"] / 0.25).clip(0, 1)
                      + 0.2 * ((cells["wild_det_5km"] / (rings.area / 1e8)) / 50).clip(0, 1)).clip(0, 1)
excluded = cells["in_primary_zone"] | (cells["water_frac"] > 0.4)

# --- buildings ----------------------------------------------------------------------------------
b = gpd.read_parquet(PROCESSED / "buildings.parquet").to_crs(ALBERS)
bpt = b.representative_point()
b["bx"], b["by"] = bpt.x.values, bpt.y.values
b["cell"] = gpd.sjoin(gpd.GeoDataFrame(geometry=bpt, crs=ALBERS), cells[["geometry"]], predicate="within",
                      how="left").groupby(level=0)["index_right"].first().values
res_mask = (b["ys"] == "assessor") & (b["category"] == "Residential")


def existed_by(year):
    """Buildings standing at the end of `year` (undated pre-2020 buildings count from the start)."""
    dated = (b["ys"] == "assessor") & (b["y"] <= year)
    undated_old = b["ys"] == "unknown"
    new = (b["ys"] == "new") & (year >= 2021)
    return dated | undated_old | new


def clusters(year):
    """Clusters of homes built in the 5 years to `year`: centre, homes, bearing (None = infill)."""
    new = res_mask & b["y"].between(year - WINDOW + 1, year)
    old = res_mask & (b["y"] <= year - WINDOW) & (b["y"] > 0)
    xy_new = b.loc[new, ["bx", "by"]].values
    xy_old = b.loc[old, ["bx", "by"]].values
    if len(xy_new) < 20:
        return []
    labels = DBSCAN(eps=350, min_samples=8).fit_predict(xy_new)
    nn = NearestNeighbors(n_neighbors=150).fit(xy_old)
    out = []
    for lab in set(labels) - {-1}:
        c = xy_new[labels == lab]
        if len(c) < 20:
            continue
        nx, ny = c.mean(axis=0)
        near = nn.radius_neighbors([[nx, ny]], radius=2000, return_distance=False)[0]
        if len(near) < 30:
            near = nn.kneighbors([[nx, ny]], return_distance=False)[0]
        ox, oy = xy_old[near].mean(axis=0)
        dx, dy = nx - ox, ny - oy
        shift = math.hypot(dx, dy)
        out.append((nx, ny, len(c), None if shift < 150 else (dx / shift, dy / shift)))
    return out


def score(year):
    built = existed_by(year)
    fp = b.loc[built].groupby("cell")["area_m2"].sum().reindex(cells.index).fillna(0)
    built_frac = (fp / area).clip(0, 1)
    room = np.where(built_frac < 0.06, 1.0, np.where(built_frac < 0.12, 0.5, 0.0))
    urban = cells.loc[built_frac >= 0.10, ["cx", "cy"]].values
    if len(urban):
        d, _ = NearestNeighbors(n_neighbors=1).fit(urban).kneighbors(cells[["cx", "cy"]].values)
        adjacency = np.clip(1 - (d[:, 0] - 1000) / 3000, 0, 1)
    else:
        adjacency = np.zeros(len(cells))
    mom = np.zeros(len(cells))
    for nx, ny, n, u in clusters(year):
        vx, vy = cells["cx"].values - nx, cells["cy"].values - ny
        w = math.sqrt(n)
        if u is None:  # infill: round kernel around the cluster
            mom += 0.5 * w * np.exp(-(vx ** 2 + vy ** 2) / (2 * (SIGMA_M * 1.2) ** 2))
        else:
            along = vx * u[0] + vy * u[1]
            lat = -vx * u[1] + vy * u[0]
            mom += w * np.exp(-((along - AHEAD_M) ** 2 + lat ** 2) / (2 * SIGMA_M ** 2))
    mom = np.clip(mom / np.percentile(mom[mom > 0], 99), 0, 1) if (mom > 0).any() else mom
    s = 100 * mom * room * adjacency * (1 - 0.8 * cells["fire_risk"].values)
    s[excluded.values] = 0
    return pd.DataFrame({"score": s, "momentum": mom, "room": room, "adjacency": adjacency,
                         "built_frac": built_frac.values})


# --- backtest -----------------------------------------------------------------------------------
backtest = []
for y in BACKTEST_YEARS:
    s = score(y)["score"].values
    future = res_mask & b["y"].between(y + 1, y + WINDOW)
    homes_per_cell = b.loc[future].groupby("cell").size().reindex(cells.index).fillna(0).values
    order = np.argsort(-s)
    top = order[: int(0.05 * len(cells))]
    top = top[s[top] > 0]
    captured = homes_per_cell[top].sum() / max(homes_per_cell.sum(), 1)
    # baseline: same number of undeveloped cells closest to existing development (no direction)
    base = score(y)
    base_s = base["room"] * base["adjacency"] * (~excluded).values
    base_top = np.argsort(-(base_s.values + np.random.default_rng(0).random(len(cells)) * 1e-6))[: len(top)]
    base_cap = homes_per_cell[base_top].sum() / max(homes_per_cell.sum(), 1)
    backtest.append({"as_of": y, "predicts": f"{y + 1}–{y + WINDOW}", "homes_built": int(homes_per_cell.sum()),
                     "top_cells": int(len(top)), "top_area_pct": round(100 * len(top) / len(cells), 1),
                     "captured_pct": round(100 * captured, 1), "baseline_pct": round(100 * base_cap, 1)})
    print(f"  backtest {y}: top {len(top)} cells ({100 * len(top) / len(cells):.1f}% of county) captured "
          f"{100 * captured:.1f}% of homes built {y + 1}-{y + WINDOW} (edge-of-town baseline {100 * base_cap:.1f}%)")

# --- current recommendation ---------------------------------------------------------------------
cur = score(YEAR)
for c in cur.columns:
    cells[c] = cur[c].values
cells["score"] = cells["score"].round(1)

THRESH = 30
hot = cells[cells["score"] >= THRESH]
zones = gpd.GeoDataFrame(geometry=list(hot.geometry.union_all().buffer(1).geoms)
                         if hot.geometry.union_all().geom_type == "MultiPolygon" else [hot.geometry.union_all()],
                         crs=ALBERS)
place_pts = places.copy()
place_pts["c"] = places.representative_point()
zone_rows = []
for z in zones.geometry:
    zc = hot[hot.centroid.within(z)]
    if zc.empty:
        continue
    total = float(zc["score"].sum())
    cen = z.centroid
    # name the zone after the nearest city/CDP *boundary* (big cities make centre distances misleading)
    big = places[places["kind"] == "City"]
    d_edge = big.distance(cen)
    pl = big.loc[d_edge.idxmin()]
    edge_km = float(d_edge.min()) / 1000
    pc = pl.geometry.representative_point()
    brg = (math.degrees(math.atan2(cen.x - pc.x, cen.y - pc.y)) + 360) % 360
    side = COMPASS[int((brg + 22.5) // 45) % 8]
    if edge_km < 0.75:
        label = f"{pl['name']} – {side} side"
    else:
        label = f"{edge_km:.1f} km {side} of {pl['name']} city limits"
    zone_rows.append({
        "label": label, "place": pl["name"], "score_sum": round(total, 1),
        "score_max": round(float(zc["score"].max()), 1), "cells": int(len(zc)),
        "acres": round(float(((1 - zc["built_frac"]) * area).sum() / 4046.86)),
        "momentum": round(float(zc["momentum"].mean()), 2),
        "fire_risk": round(float(zc["fire_risk"].mean()), 2),
        "fhsz": ", ".join(sorted(set(zc["fhsz_class"]) - {"None"})) or "None",
        "burn_frac_5km": round(float(zc["burn_frac_5km"].mean()), 3),
        "geometry": z,
    })
zones = gpd.GeoDataFrame(zone_rows, crs=ALBERS).sort_values("score_sum", ascending=False).reset_index(drop=True)
zones["rank"] = zones.index + 1
zones = zones[zones["rank"] <= 10]
zw = zones.to_crs(4326)
write_geojson(zw, WEB_DATA / "recommend_zones.geojson")

out_cells = cells[cells["score"] >= 5].copy()
out_cells["fire_risk"] = out_cells["fire_risk"].round(2)
out_cells["momentum"] = out_cells["momentum"].round(2)
out_cells["adjacency"] = out_cells["adjacency"].round(2)
write_geojson(out_cells[["score", "momentum", "room", "adjacency", "fire_risk", "fhsz_class", "geometry"]].to_crs(4326),
              WEB_DATA / "recommend_cells.geojson")

pts = zw.copy()
pts["geometry"] = zones.geometry.representative_point().to_crs(4326).values
write_json({
    "as_of": YEAR, "window": f"{YEAR - WINDOW + 1}–{YEAR}", "cell_m": CELL, "threshold": THRESH,
    "zones": [{k: v for k, v in r.items() if k != "geometry"} | {"lon": round(p.x, 5), "lat": round(p.y, 5)}
              for r, p in zip(zw.to_dict("records"), pts.geometry)],
    "backtest": backtest,
    "excluded": {"delta_primary_zone_cells": int(cells["in_primary_zone"].sum()),
                 "water_cells": int((cells["water_frac"] > 0.4).sum())},
}, WEB_DATA / "recommend.json")
print(zones[["rank", "label", "score_sum", "cells", "acres", "momentum", "fire_risk", "fhsz"]].to_string(index=False))
