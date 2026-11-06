"""Historical wildfire perimeters for California.

Primary source: CAL FIRE FRAP "California Fire Perimeters (all)", the state's authoritative perimeter
database (1878 -> last full season, updated each spring), via its public ArcGIS Online service.
Current season: NIFC WFIGS interagency perimeters for years after the last FRAP year.

(Earlier versions used NIFC's InterAgency Fire Perimeter History, which is complete only to ~2019 and
missed the 2020-2023 fires, including the 2020 SCU Lightning Complex in the hills SW of Tracy.)
"""
import geopandas as gpd
import pandas as pd
from shapely.geometry import MultiPolygon, Polygon
from shapely.validation import make_valid

from common import PROCESSED, RAW, arcgis_query, write_geojson

FRAP = ("https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/"
        "California_Historic_Fire_Perimeters/FeatureServer/0")
WFIGS = ("https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
         "WFIGS_Interagency_Perimeters/FeatureServer/0")


def safe_polygon(geom):
    """Repair a geometry and keep only its polygon parts (None if nothing usable)."""
    if geom is None or geom.is_empty:
        return None
    try:
        geom = geom if geom.is_valid else make_valid(geom)
    except Exception:  # noqa: BLE001
        try:
            geom = geom.buffer(0)
        except Exception:  # noqa: BLE001
            return None
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    parts = [p for p in getattr(geom, "geoms", []) if isinstance(p, (Polygon, MultiPolygon))]
    polys = [q for p in parts for q in (p.geoms if isinstance(p, MultiPolygon) else [p])]
    return MultiPolygon(polys) if polys else None


# --- CAL FIRE FRAP (all years) -----------------------------------------------------------------
cache = RAW / "calfire_frap_perimeters.parquet"
if cache.exists():
    f = gpd.read_parquet(cache)
else:
    print("Downloading CAL FIRE FRAP perimeters (all years) ...")
    f = arcgis_query(FRAP, out_fields="YEAR_,FIRE_NAME,GIS_ACRES,AGENCY,ALARM_DATE,CAUSE", page_size=1000,
                     extra={"maxAllowableOffset": 0.0005, "geometryPrecision": 5, "orderByFields": "OBJECTID"})
    f.to_parquet(cache)
f = f.rename(columns={"FIRE_NAME": "name", "YEAR_": "year", "GIS_ACRES": "acres", "AGENCY": "agency"})
f["year"] = pd.to_numeric(f["year"], errors="coerce")
f = f[f["year"].between(1878, 2100)]
f["source"] = "CAL FIRE FRAP"
last_frap = int(f["year"].max())

# --- current season from WFIGS --------------------------------------------------------------------
wcache = RAW / "nifc_wfigs_ca.parquet"
if wcache.exists():
    w = gpd.read_parquet(wcache)
else:
    print("Downloading recent California perimeters (WFIGS) ...")
    w = arcgis_query(WFIGS, where="attr_POOState='US-CA' AND attr_IncidentTypeCategory='WF'",
                     out_fields="poly_IncidentName,attr_IncidentName,attr_FireDiscoveryDateTime,poly_GISAcres",
                     page_size=500, extra={"maxAllowableOffset": 0.0005, "geometryPrecision": 5})
    w.to_parquet(wcache)
w = w.assign(
    name=w["poly_IncidentName"].fillna(w["attr_IncidentName"]),
    year=pd.to_datetime(w["attr_FireDiscoveryDateTime"], unit="ms", errors="coerce").dt.year,
    acres=w["poly_GISAcres"], agency="NIFC WFIGS", source="NIFC WFIGS",
)
w = w[w["year"] > last_frap]
print(f"  FRAP: {len(f):,} perimeters to {last_frap}; WFIGS adds {len(w):,} for {sorted(w['year'].dropna().unique().astype(int))}")

cols = ["name", "year", "acres", "agency", "source", "geometry"]
g = gpd.GeoDataFrame(pd.concat([f[cols], w[cols]], ignore_index=True), crs=4326)
g["geometry"] = g.geometry.apply(safe_polygon)
g = g[g.geometry.notna()].copy()
g["name"] = g["name"].fillna("").astype(str).str.strip().str.title()
g["acres"] = pd.to_numeric(g["acres"], errors="coerce").fillna(0).round(0)
g["year"] = g["year"].astype(int)
write_geojson(g[["name", "year", "acres", "agency", "source", "geometry"]], PROCESSED / "fire_perimeters.geojson")
print(g.groupby("year").size().loc[2016:].to_string())
