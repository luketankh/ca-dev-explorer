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
                   + 0.3 x fire history within 5 km: frequency, repeat burning and time since the
                         last fire, every fire weighted by age (half-life 10 years; fire_history.py)
                   + 0.2 x wildland satellite fire detections within 5 km, age-weighted the same way
  excluded         Delta Primary Zone (Delta Protection Act), cells > 40% water, outside county.

  suitability = 100 x momentum x room x flat share x adjacency x (1 - fire risk) ** FIRE_EXPONENT
  (FIRE_EXPONENT = 2: progressive penalty; a cell keeps 81% of its score at 10% fire risk, 56% at 25%,
   25% at 50% and 0% at maximum risk. Higher exponent = harsher.)

Adjacent high-scoring cells are merged into ranked "zones". A backtest re-runs the model as of
earlier years and measures how many homes built in the following 5 years landed in the cells it
ranked highest.

Outputs (web/public/data): recommend_cells.pmtiles (cells for every year), recommend_zones.geojson
(top-10 zones per year), recommend.json (zones by year, what happened next, backtest)
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
from fire_history import HALF_LIFE, METHOD as FIRE_METHOD, GridHistory, risk as fire_risk
from terrain import RES as DEM_RES, SLOPE_MAX, SLOPE_OK, cell_terrain, load_dem_slope

ALBERS, CELL = 3310, 500
YEAR = 2025
BACKTEST_YEARS = [2010, 2013, 2016, 2019]
WINDOW = 5
FIRE_EXPONENT = 2  # fire factor = (1 - fire risk) ** FIRE_EXPONENT; higher = harsher
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
# fire history (frequency + recency) is computed per reference year, so backtests only see the
# fires that had happened by then (see fire_history.py)
print("Fire history ...")
fh = GridHistory(cells[["cx", "cy"]].values, cgeom, radius=5000, cell=CELL)


def fire_at(year):
    h = fh.at(year)
    h["fire_risk"] = fire_risk(cells["fhsz"].values, h["fire_history"].values, h["fire_detections"].values)
    return h

# --- terrain (USGS 3DEP, 25 m slope) ------------------------------------------------------------
print("Terrain ...")
elev, slope, dem_tr = load_dem_slope()
lower_left = [(g.bounds[0], g.bounds[1]) for g in cells.geometry]
ter = pd.DataFrame(cell_terrain(lower_left, elev, slope, dem_tr, CELL),
                   columns=["elev_m", "slope_mean", "flat_share", "hillside_share", "terrain"])
for c in ter.columns:
    cells[c] = ter[c].values
cells["too_steep"] = cells["terrain"] < 0.2
print(f"  {int(cells['too_steep'].sum()):,} cells too steep (<20% of land under {SLOPE_OK:.0f}% slope)")

excluded = cells["in_primary_zone"] | (cells["water_frac"] > 0.4) | cells["too_steep"]

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
    # open land only counts where the ground is flat enough to build on
    fire = fire_at(year)
    s = 100 * mom * room * cells["terrain"].values * adjacency * (1 - fire["fire_risk"].values) ** FIRE_EXPONENT
    s[excluded.values] = 0
    out = pd.DataFrame({"score": s, "momentum": mom, "room": room, "adjacency": adjacency,
                        "built_frac": built_frac.values})
    return pd.concat([out, fire.reset_index(drop=True)], axis=1)


# --- one prediction per year ----------------------------------------------------------------------
# Every year from 2000 gets its own recommendation using only what was known then (homes built,
# growth clusters, fires). The app shows the prediction for the slider year.
PRED_YEARS = list(range(2000, YEAR + 1))
THRESH = 30
TOP_SHARE = 0.05
STATIC = ["geometry", "fhsz_class", "flat_share", "slope_mean", "elev_m", "terrain"]
big_places = places[places["kind"] == "City"]


def homes_built(y0, y1):
    """Residential homes per cell built in years y0..y1."""
    fut = res_mask & b["y"].between(y0, y1)
    return b.loc[fut].groupby("cell").size().reindex(cells.index).fillna(0).values


def name_zone(z):
    """Name a zone after the city/cities it touches, or its distance and direction from the nearest one."""
    cen = z.centroid
    d_edge = big_places.distance(cen)
    pl = big_places.loc[d_edge.idxmin()]
    edge_km = float(d_edge.min()) / 1000
    pc = pl.geometry.representative_point()
    brg = (math.degrees(math.atan2(cen.x - pc.x, cen.y - pc.y)) + 360) % 360
    side = COMPASS[int((brg + 22.5) // 45) % 8]
    touching = big_places.assign(d=big_places.distance(z)).query("d < 1500")
    if len(touching) >= 2:
        share = touching.geometry.buffer(1500).intersection(z).area.sort_values(ascending=False)
        first, second = big_places.loc[share.index[:2], "name"]
        return f"Between {first} and {second}", pl["name"]
    if edge_km < 0.75:
        return f"{pl['name']} – {side} side", pl["name"]
    return f"{edge_km:.1f} km {side} of {pl['name']} city limits", pl["name"]


def zones_for(cy):
    """Merge touching cells scoring >= THRESH into zones; return the top 10 (Albers)."""
    hot = cy[cy["score"] >= THRESH]
    if hot.empty:
        return gpd.GeoDataFrame(geometry=[], crs=ALBERS)
    u = hot.geometry.union_all().buffer(1)
    rows = []
    for z in (list(u.geoms) if u.geom_type == "MultiPolygon" else [u]):
        zc = hot[hot.centroid.within(z)]
        if zc.empty:
            continue
        label, place = name_zone(z)
        rows.append({
            "label": label, "place": place, "score_sum": round(float(zc["score"].sum()), 1),
            "score_max": round(float(zc["score"].max()), 1), "cells": int(len(zc)),
            "acres": round(float(((1 - zc["built_frac"]) * area).sum() / 4046.86)),
            "momentum": round(float(zc["momentum"].mean()), 2),
            "fire_risk": round(float(zc["fire_risk"].mean()), 2),
            "slope_mean": round(float(zc["slope_mean"].mean()), 1),
            "flat_share": round(float(zc["flat_share"].mean()), 2),
            "elev_m": round(float(zc["elev_m"].mean())),
            "fhsz": ", ".join(sorted(set(zc["fhsz_class"]) - {"None"})) or "None",
            "fire_history": round(float(zc["fire_history"].mean()), 2),
            "years_since_fire": (None if zc["years_since_fire"].isna().all() else int(zc["years_since_fire"].min())),
            "geometry": z.simplify(15),  # merged squares carry many redundant vertices
        })
    zs = gpd.GeoDataFrame(rows, crs=ALBERS).sort_values("score_sum", ascending=False).reset_index(drop=True)
    zs["rank"] = zs.index + 1
    return zs[zs["rank"] <= 10]


cell_frames, zone_frames, by_year, results = [], [], {}, {}
for y in PRED_YEARS:
    cur = score(y)
    results[y] = cur
    cy = cells[STATIC].copy()
    for c in cur.columns:
        cy[c] = cur[c].values
    cy["score"] = cy["score"].round(1)
    zs = zones_for(cy)
    zs["year"] = y

    # what actually happened next (complete 5-year window up to 2020; partial after)
    y_end = min(y + WINDOW, YEAR)
    nxt = None
    if y_end > y:
        hpc = homes_built(y + 1, y_end)
        total = hpc.sum()
        in_zone = cy["score"].values >= THRESH
        s = cy["score"].values
        top = np.argsort(-s)[: int(TOP_SHARE * len(cells))]
        top = top[s[top] > 0]
        nxt = {"period": f"{y + 1}–{y_end}", "complete": y + WINDOW <= YEAR, "homes_built": int(total),
               "in_zones_pct": round(100 * hpc[in_zone].sum() / total, 1) if total else None,
               "zone_area_pct": round(100 * in_zone.mean(), 1),
               "top5_pct": round(100 * hpc[top].sum() / total, 1) if total else None}
    zl = zs.to_crs(4326)
    lab = zs.geometry.representative_point().to_crs(4326) if len(zs) else []
    by_year[str(y)] = {
        "window": f"{y - WINDOW + 1}–{y}",
        "zones": [{k: v for k, v in r.items() if k not in ("geometry", "year")} | {"lon": round(p.x, 5), "lat": round(p.y, 5)}
                  for r, p in zip(zl.to_dict("records"), lab)],
        "next": nxt,
    }
    zone_frames.append(zl)
    keep = cy[cy["score"] >= 5].copy()
    keep["year"] = y
    cell_frames.append(keep)
    msg = f"  {y}: {len(zs)} zones" + (f" · next {nxt['period']}: {nxt['in_zones_pct']}% of {nxt['homes_built']:,} homes "
                                        f"landed in zones ({nxt['zone_area_pct']}% of county)" if nxt and nxt["homes_built"] else "")
    print(msg)

# --- backtest summary (top 5% of cells vs an edge-of-town rule) -------------------------------------
backtest = []
for y in BACKTEST_YEARS:
    r = results[y]
    s = r["score"].values
    hpc = homes_built(y + 1, y + WINDOW)
    top = np.argsort(-s)[: int(TOP_SHARE * len(cells))]
    top = top[s[top] > 0]
    captured = hpc[top].sum() / max(hpc.sum(), 1)
    base_s = r["room"] * r["adjacency"] * (~excluded).values
    base_top = np.argsort(-(base_s.values + np.random.default_rng(0).random(len(cells)) * 1e-6))[: len(top)]
    base_cap = hpc[base_top].sum() / max(hpc.sum(), 1)
    backtest.append({"as_of": y, "predicts": f"{y + 1}–{y + WINDOW}", "homes_built": int(hpc.sum()),
                     "top_cells": int(len(top)), "top_area_pct": round(100 * len(top) / len(cells), 1),
                     "captured_pct": round(100 * captured, 1), "baseline_pct": round(100 * base_cap, 1)})
    print(f"  backtest {y}: top {len(top)} cells captured {100 * captured:.1f}% of homes built "
          f"{y + 1}-{y + WINDOW} (edge-of-town baseline {100 * base_cap:.1f}%)")

# --- outputs -----------------------------------------------------------------------------------
from tiler import make_pmtiles  # noqa: E402

allz = gpd.GeoDataFrame(pd.concat(zone_frames, ignore_index=True), crs=4326)
write_geojson(allz, WEB_DATA / "recommend_zones.geojson")

allc = gpd.GeoDataFrame(pd.concat(cell_frames, ignore_index=True), crs=ALBERS)
for c in ("fire_risk", "fire_history", "fire_freq", "fire_reburn", "fire_last", "fire_detections", "momentum",
          "adjacency", "flat_share", "terrain"):
    allc[c] = allc[c].round(2)
allc["slope_mean"] = allc["slope_mean"].round(1)
allc["elev_m"] = allc["elev_m"].round(0)
CELL_PROPS = ["year", "score", "momentum", "room", "terrain", "flat_share", "slope_mean", "elev_m", "adjacency",
              "fire_risk", "fire_history", "fire_freq", "fire_reburn", "fire_last", "fire_detections",
              "years_since_fire", "fhsz_class"]
make_pmtiles(allc[CELL_PROPS + ["geometry"]], WEB_DATA / "recommend_cells.pmtiles", "rec", 8, 13, CELL_PROPS,
             simplify_px=0, buffer_px=2, attribution="CA Development Explorer model")
old = WEB_DATA / "recommend_cells.geojson"
if old.exists():
    old.unlink()

latest = by_year[str(YEAR)]
write_json({
    "as_of": YEAR, "first_year": PRED_YEARS[0], "window": latest["window"], "cell_m": CELL, "threshold": THRESH,
    "zones": latest["zones"],
    "by_year": by_year,
    "backtest": backtest,
    "excluded": {"delta_primary_zone_cells": int(cells["in_primary_zone"].sum()),
                 "water_cells": int((cells["water_frac"] > 0.4).sum()),
                 "too_steep_cells": int(cells["too_steep"].sum())},
    "fire_exponent": FIRE_EXPONENT,
    "fire_half_life": HALF_LIFE,
    "fire_method": FIRE_METHOD,
    "terrain": {"slope_ok_pct": SLOPE_OK, "slope_max_pct": SLOPE_MAX, "dem": "USGS 3DEP 1 arc-second"},
}, WEB_DATA / "recommend.json")
print(pd.DataFrame(latest["zones"])[["rank", "label", "cells", "acres", "momentum", "fire_risk"]].to_string(index=False))

# --- steep-terrain map layer: 100 m blocks classed by their dominant slope ------------------------
from rasterio import features  # noqa: E402

k = int(100 / DEM_RES)
h, w = (slope.shape[0] // k) * k, (slope.shape[1] // k) * k
blk = slope[:h, :w].reshape(h // k, k, w // k, k)
share_max = np.nanmean(blk > SLOPE_MAX, axis=(1, 3))
share_mid = np.nanmean(blk > SLOPE_OK, axis=(1, 3))
cls = np.zeros(share_max.shape, dtype="uint8")
cls[share_mid >= 0.5] = 1          # hillside, 15-25 %
cls[share_max >= 0.5] = 2          # too steep, > 25 %
tr100 = dem_tr * dem_tr.scale(k, k)
shapes = [(shapely.geometry.shape(g), int(v)) for g, v in features.shapes(cls, mask=cls > 0, transform=tr100)]
steep = gpd.GeoDataFrame({"cls": [v for _, v in shapes]}, geometry=[g for g, _ in shapes], crs=ALBERS)
steep = steep.dissolve("cls").reset_index()
steep["geometry"] = steep.geometry.intersection(cgeom.buffer(2000)).simplify(40)
steep["label"] = steep["cls"].map({1: f"Hillside ({SLOPE_OK:.0f}–{SLOPE_MAX:.0f}% slope)",
                                   2: f"Too steep (>{SLOPE_MAX:.0f}% slope)"})
steep = steep.explode(index_parts=False)
steep = steep[steep.area > 40_000]  # drop specks under 4 ha
write_geojson(steep[["cls", "label", "geometry"]].to_crs(4326), WEB_DATA / "steep_terrain.geojson")
