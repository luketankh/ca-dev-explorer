"""Historical wildfire perimeters for California (NIFC InterAgency Fire Perimeter History, all years).

CAL FIRE's own FRAP FeatureServer needs a token, so the MVP uses NIFC's public interagency history.
It includes CAL FIRE/FRAP perimeters as one of its sources.
"""
import geopandas as gpd

from shapely.geometry import MultiPolygon, Polygon
from shapely.validation import make_valid

from common import CA_BBOX, PROCESSED, RAW, arcgis_query, write_geojson


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

LAYER = ("https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
         "InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0")

cache = RAW / "nifc_perimeters_ca_bbox.parquet"
if cache.exists():
    g = gpd.read_parquet(cache)
else:
    print("Downloading fire perimeters intersecting California ...")
    g = arcgis_query(LAYER, out_fields="INCIDENT,FIRE_YEAR_INT,GIS_ACRES,AGENCY,SOURCE",
                     bbox=CA_BBOX, page_size=1000,
                     extra={"maxAllowableOffset": 0.0005, "geometryPrecision": 5})
    g.to_parquet(cache)
g["geometry"] = g.geometry.apply(safe_polygon)
ca = gpd.read_file(PROCESSED / "california.geojson").geometry.union_all()
g = g[g.geometry.notna() & g.intersects(ca)].copy()
g = g.rename(columns={"INCIDENT": "name", "FIRE_YEAR_INT": "year", "GIS_ACRES": "acres",
                      "AGENCY": "agency", "SOURCE": "source"})
g = g[g["year"].between(1900, 2030)]
g["name"] = g["name"].fillna("").str.strip().str.title()
g["acres"] = g["acres"].fillna(0).round(0)
# the interagency history contains the same fire from several agencies; keep the largest record
g["_key"] = g["name"].str.upper() + "|" + g["year"].astype(int).astype(str)
g = g.sort_values("acres", ascending=False)
named = g[g["name"] != ""].drop_duplicates("_key")
g = gpd.GeoDataFrame(gpd.pd.concat([named, g[g["name"] == ""]]), crs=4326).drop(columns="_key")
g["year"] = g["year"].astype(int)
write_geojson(g[["name", "year", "acres", "agency", "geometry"]], PROCESSED / "fire_perimeters.geojson")
