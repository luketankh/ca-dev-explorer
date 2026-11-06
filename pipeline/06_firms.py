"""NASA FIRMS MODIS active-fire detections for California, 2001 to latest full year.

Uses the public yearly per-country CSVs. Keeps type 0 (presumed vegetation fire) only, which
drops volcanoes, static industrial heat sources and offshore detections.
"""
import io
from datetime import date

import geopandas as gpd
import pandas as pd

from common import CA_BBOX, PROCESSED, RAW, session, write_geojson

URL = "https://firms.modaps.eosdis.nasa.gov/data/country/modis/{y}/modis_{y}_United_States.csv"
xmin, ymin, xmax, ymax = CA_BBOX
frames = []
for y in range(2001, date.today().year):
    cache = RAW / f"firms_modis_{y}_ca.csv"
    if not cache.exists():
        r = session.get(URL.format(y=y), timeout=300)
        if r.status_code != 200:
            print(f"  {y}: not available ({r.status_code})")
            continue
        df = pd.read_csv(io.StringIO(r.text))
        df = df[df.longitude.between(xmin, xmax) & df.latitude.between(ymin, ymax)]
        df.to_csv(cache, index=False)
    df = pd.read_csv(cache)
    df["year"] = y
    frames.append(df)
    print(f"  {y}: {len(df):,} detections in CA bbox")

df = pd.concat(frames, ignore_index=True)
df = df[(df["type"] == 0) & (df["confidence"] >= 30)]
pts = gpd.GeoDataFrame(df[["year", "acq_date", "frp", "confidence", "daynight"]],
                       geometry=gpd.points_from_xy(df.longitude, df.latitude), crs=4326)
ca = gpd.read_file(PROCESSED / "california.geojson")
pts = gpd.sjoin(pts, ca[["geometry"]], predicate="within").drop(columns="index_right")
pts["frp"] = pts["frp"].round(1)
write_geojson(pts, PROCESSED / "firms_modis.geojson")
