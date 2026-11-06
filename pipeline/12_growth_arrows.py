"""Growth-direction arrows: one arrow per cluster of new homes, for every slider year.

For slider year Y:
  new homes      = residential buildings with an assessor year in Y-4 .. Y  (5-year window)
  existing homes = residential buildings built in or before Y-5

1. New homes are grouped into spatial clusters (DBSCAN, 350 m neighbourhood), so several
   subdivisions growing in different directions each get their own arrow.
2. For each cluster, the "existing edge" is the centre of existing homes within 2 km. The arrow
   starts there and points at the centre of the cluster.
3. If the cluster sits inside existing development (shift < 150 m), it is drawn as a small circle
   ("infill") instead of an arrow.

Each cluster is written as a point at its centre with a compass bearing. The app draws an arrow
icon whose tip sits on the cluster, rotated to the bearing and sized by the number of new homes.
Clusters with >= 100 homes are "major" (shown at all zoom levels); smaller ones are "minor" (zoomed in).

Output: web/public/data/growth_arrows.geojson
"""
import math

import geopandas as gpd
import numpy as np
from shapely.geometry import Point
from sklearn.cluster import DBSCAN
from sklearn.neighbors import NearestNeighbors

from common import PROCESSED, WEB_DATA, write_geojson

WINDOW = 5
YEARS = range(2000, 2027)
EPS_M, MIN_SAMPLES = 350, 8      # DBSCAN neighbourhood and core size
MIN_CLUSTER = 20                 # smallest cluster that gets a symbol
NEIGHBOURHOOD_M = 2000           # existing homes within this distance define the "existing edge"
K_EXISTING = 150                 # fallback: nearest existing homes when few are within range
INFILL_M = 150
MAJOR = 100
ALBERS = 3310
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

b = gpd.read_parquet(PROCESSED / "buildings.parquet").to_crs(ALBERS)
b = b[(b["ys"] == "assessor") & (b["category"] == "Residential")]
pts = b.representative_point()
xy_all = np.column_stack([pts.x.values, pts.y.values])
yr_all = b["y"].values

places = gpd.read_file(PROCESSED / "places.geojson").to_crs(ALBERS)


def place_of(x, y):
    hit = places[places.contains(Point(x, y))]
    if len(hit):
        return hit.iloc[0]["GEOID"], hit.iloc[0]["name"]
    return None, "Unincorporated area"


feats = []
for year in YEARS:
    new_m = (yr_all > year - WINDOW) & (yr_all <= year)
    old_m = (yr_all <= year - WINDOW) & (yr_all > 0)
    if new_m.sum() < MIN_CLUSTER or old_m.sum() < K_EXISTING:
        continue
    xy_new, xy_old = xy_all[new_m], xy_all[old_m]
    labels = DBSCAN(eps=EPS_M, min_samples=MIN_SAMPLES).fit_predict(xy_new)
    nn = NearestNeighbors(n_neighbors=K_EXISTING).fit(xy_old)
    for lab in set(labels) - {-1}:
        c = xy_new[labels == lab]
        n = len(c)
        if n < MIN_CLUSTER:
            continue
        nx, ny = c.mean(axis=0)
        # existing edge: all existing homes within NEIGHBOURHOOD_M of the cluster centre
        # (falls back to the K nearest when the cluster is out on its own)
        near = nn.radius_neighbors([[nx, ny]], radius=NEIGHBOURHOOD_M, return_distance=False)[0]
        if len(near) < 30:
            near = nn.kneighbors([[nx, ny]], return_distance=False)[0]
        ox, oy = xy_old[near].mean(axis=0)
        dx, dy = nx - ox, ny - oy
        shift = math.hypot(dx, dy)
        gid, name = place_of(nx, ny)
        props = {"year": year, "window": f"{year - WINDOW + 1}–{year}", "new_homes": int(n),
                 "level": "major" if n >= MAJOR else "minor", "GEOID": gid, "name": name,
                 "shift_km": round(shift / 1000, 2)}
        # A point at the cluster centre. The app draws a screen-sized arrow icon whose tip sits on
        # the cluster, rotated to `bearing`, so arrows stay readable at every zoom level.
        if shift < INFILL_M:
            feats.append({**props, "kind": "infill", "bearing": None, "direction": None,
                          "geometry": Point(nx, ny)})
            continue
        bearing = (math.degrees(math.atan2(dx, dy)) + 360) % 360
        feats.append({**props, "kind": "arrow", "bearing": round(bearing),
                      "direction": COMPASS[int((bearing + 22.5) // 45) % 8],
                      "geometry": Point(nx, ny)})

out = gpd.GeoDataFrame(feats, crs=ALBERS).to_crs(4326)
out = out.sort_values(["year", "new_homes"], ascending=[True, False])
write_geojson(out, WEB_DATA / "growth_arrows.geojson")
print(out.groupby("year").size().tail(6).to_string())
latest = out[out["year"] == 2025]
print(latest[["name", "kind", "level", "new_homes", "shift_km", "direction"]].to_string(index=False))
