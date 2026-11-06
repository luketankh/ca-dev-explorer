"""Assign a construction year to every Overture building in the AOI.

Priority:
  1. assessor  - YEAR_BUILT of the San Joaquin County parcel containing the building
  2. new       - no year from the assessor and no overlapping footprint in the Microsoft v2
                 snapshot (imagery 2019-2020), so it was probably built after that snapshot
  3. unknown   - no year from the assessor, but present in the Microsoft snapshot,
                 so it was built before about 2020 (exact year unknown)

Output column `y` drives the time slider. A building is shown when y <= the slider year
(y = 0 means "existed before the earliest year we can show").
"""
import geopandas as gpd
import numpy as np
import pandas as pd

from common import PROCESSED, RAW

NEW_SINCE_BASELINE_YEAR = 2021  # buildings missing from the 2019-20 snapshot appear from this year

county = gpd.read_file(PROCESSED / "aoi_county.geojson").to_crs(4326)

print("Loading Overture buildings ...")
b = gpd.read_parquet(RAW / "overture_buildings.parquet").set_crs(4326, allow_override=True)
pts = b.representative_point()
b = b[pts.within(county.geometry.union_all())].reset_index(drop=True)
print(f"  {len(b):,} buildings inside {county.iloc[0]['NAME']}")
b["area_m2"] = b.to_crs(3310).area.round(0)
pts = gpd.GeoDataFrame(geometry=b.representative_point(), crs=4326)

print("Joining assessor parcels ...")
parcels = gpd.read_parquet(RAW / "sj_parcels.parquet").to_crs(4326)
parcels = parcels[parcels.geometry.notna()]
j = gpd.sjoin(pts, parcels[["year_built", "CATEGORY", "DESCRIPTION", "NUMBER_UNITS", "geometry"]],
              predicate="within", how="left")
j = j[~j.index.duplicated(keep="first")]  # overlapping parcels: keep first match
b["year_assessor"] = j["year_built"].astype("Int64").values
b["category"] = j["CATEGORY"].fillna("").str.title().values
b["use"] = j["DESCRIPTION"].fillna("").str.title().values
b["units"] = pd.to_numeric(j["NUMBER_UNITS"], errors="coerce").values

baseline_path = RAW / "ms_v2_buildings.parquet"
if baseline_path.exists():
    print("Comparing against the Microsoft v2 snapshot ...")
    ms = gpd.read_parquet(baseline_path).set_crs(4326, allow_override=True)
    hit = gpd.sjoin(b[["geometry"]], ms[["geometry"]], predicate="intersects", how="inner")
    b["in_baseline"] = b.index.isin(hit.index.unique())
else:
    print("  (no Microsoft snapshot found; skipping)")
    b["in_baseline"] = True

has_year = b["year_assessor"].notna()
b["ys"] = np.where(has_year, "assessor", np.where(~b["in_baseline"], "new", "unknown"))
b["y"] = np.where(has_year, b["year_assessor"].fillna(0),
                  np.where(~b["in_baseline"], NEW_SINCE_BASELINE_YEAR, 0)).astype(int)

out = b.rename(columns={"source_dataset": "src", "height": "h"})[
    ["id", "y", "ys", "category", "use", "units", "area_m2", "h", "class", "src", "in_baseline", "geometry"]]
out.to_parquet(PROCESSED / "buildings.parquet")
print(f"  wrote buildings.parquet ({len(out):,})")
print(out["ys"].value_counts().to_string())
print("Buildings with an assessor year, by decade:")
print((out.loc[out.ys == "assessor", "y"] // 10 * 10).value_counts().sort_index().tail(8).to_string())
