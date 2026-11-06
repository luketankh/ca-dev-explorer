"""Download San Joaquin County assessor parcels with YEAR_BUILT.

Only property attributes are kept. Owner, care-of and mailing-address fields are not requested.
"""
from common import RAW, arcgis_query

LAYER = "https://services2.arcgis.com/GQhSReJEO6f7tsvy/ArcGIS/rest/services/Parcels/FeatureServer/0"
FIELDS = ",".join([
    "APN", "YEAR_BUILT", "USECODE", "CATEGORY", "DESCRIPTION", "NUMBER_UNITS",
    "TOTALLIV_AREA", "STORIES", "LANDSIZE_ACRES",
])

print("Downloading parcels (~254k, paged 2,000 at a time) ...")
gdf = arcgis_query(LAYER, out_fields=FIELDS, extra={"orderByFields": "OBJECTID"})
gdf["year_built"] = gdf["YEAR_BUILT"].astype("string").str.extract(r"(\d{4})")[0].astype("Int64")
gdf.loc[(gdf["year_built"] < 1800) | (gdf["year_built"] > 2027), "year_built"] = None
gdf = gdf.drop(columns=["YEAR_BUILT"])
out = RAW / "sj_parcels.parquet"
gdf.to_parquet(out)
print(f"  wrote {out.name}: {len(gdf):,} parcels, {gdf['year_built'].notna().sum():,} with year built")
