"""Step 14: flood hazard (FEMA flood zones + DWR 200-year floodplain), shown on the map and in the reports.

Context only: the where-to-build-next score (13_recommend.py) does NOT use flood yet. This step adds flood
exposure to the places, the county and every year's build-next zones so people can see it next to the score.

Sources
  FEMA National Flood Hazard Layer (NFHL), Flood Hazard Zones, San Joaquin County map 06077C
    https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28
  DWR Best Available Maps (SB 5), 200-year floodplain (USACE Sacramento-San Joaquin Comprehensive Study)
    https://ferix.water.ca.gov/arcgis/rest/services/other/BAM/MapServer/11

Flood classes (from FLD_ZONE / ZONE_SUBTY)
  floodway  AE zones whose subtype is FLOODWAY: the river channel area; effectively unbuildable
  100yr     A, AE, AH, AO (and V/VE): 1% annual chance, the "Special Flood Hazard Area"; lenders require insurance
  500yr     X "0.2 PCT ANNUAL CHANCE" (and "1 PCT DEPTH LESS THAN 1 FOOT")
  levee     X "AREA WITH REDUCED FLOOD RISK DUE TO LEVEE": would flood if the levee failed
  (minimal-risk X areas are not drawn)

Inputs  data/raw/fema_flood_zones.parquet, data/raw/dwr_200yr_floodplain.parquet (downloaded if missing),
        web/public/data/{places.geojson, stats.json, recommend.json, recommend_zones.geojson,
        recommend_region_zones.geojson}
        and the county outline (data/processed/aoi_county.geojson, or web/public/data/counties.geojson).
Outputs web/public/data/flood.pmtiles             FEMA flood zones, layer "flood"
        web/public/data/flood_200yr.geojson       DWR 200-year floodplain clipped to the county
        flood_* shares added to places.geojson, stats.json (county), recommend.json and recommend_zones.geojson
Re-running is safe: it overwrites the flood_* fields. Re-run it after 09_stats.py or 13_recommend.py.
"""
from __future__ import annotations

import json

import geopandas as gpd
import pandas as pd
import shapely

from common import AOI_BBOX, PROCESSED, RAW, WEB_DATA, arcgis_query, write_geojson
from tiler import make_pmtiles

ALBERS = 3310
FEMA_URL = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28"
FEMA_DFIRM = "06077C"
DWR_200_URL = "https://ferix.water.ca.gov/arcgis/rest/services/other/BAM/MapServer/11"
CLASSES = ["floodway", "100yr", "500yr", "levee"]


def polygonal(geom):
    """Repair a geometry and keep only its polygon parts (FEMA ships a few self-intersecting rings)."""
    if geom is None or geom.is_empty:
        return None
    geom = shapely.make_valid(geom)
    parts = [p for p in shapely.get_parts(geom) if p.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else None


def flood_class(zone: str | None, sub: str | None) -> str:
    zone, sub = zone or "", sub if isinstance(sub, str) else ""
    if "FLOODWAY" in sub:
        return "floodway"
    if zone in ("A", "AE", "AH", "AO", "A99", "AR", "V", "VE"):
        return "100yr"
    if "0.2 PCT" in sub or "1 PCT DEPTH" in sub:
        return "500yr"
    if "LEVEE" in sub:
        return "levee"
    return "minimal"


# ---------- download (cached) ----------
fema_path = RAW / "fema_flood_zones.parquet"
if not fema_path.exists():
    print("Downloading FEMA flood zones…")
    arcgis_query(FEMA_URL, where=f"DFIRM_ID='{FEMA_DFIRM}'",
                 out_fields="FLD_AR_ID,FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DEPTH,V_DATUM,SOURCE_CIT",
                 extra={"geometryPrecision": 6}).to_parquet(fema_path)
dwr_path = RAW / "dwr_200yr_floodplain.parquet"
if not dwr_path.exists():
    print("Downloading DWR 200-year floodplain…")
    arcgis_query(DWR_200_URL, bbox=AOI_BBOX, extra={"geometryPrecision": 6}).to_parquet(dwr_path)

aoi_path = PROCESSED / "aoi_county.geojson"
county = (gpd.read_file(aoi_path) if aoi_path.exists()
          else gpd.read_file(WEB_DATA / "counties.geojson").query("GEOID == '06077'"))
county = county.to_crs(ALBERS).geometry.union_all()

# ---------- clean ----------
fema = gpd.read_parquet(fema_path).to_crs(ALBERS)
fema["geometry"] = [polygonal(g) for g in fema.geometry]
fema = fema[fema.geometry.notna()]
fema = fema[fema.area >= 1.0].copy()  # drop zero-area slivers
fema["FLD_AR_ID"] = fema["FLD_AR_ID"].fillna("").replace("", None)
fema["cls"] = [flood_class(z, s) for z, s in zip(fema.FLD_ZONE, fema.ZONE_SUBTY)]
print(f"FEMA flood zones: {len(fema):,} polygons ·",
      ", ".join(f"{c} {int((fema.cls == c).sum())}" for c in CLASSES + ["minimal"]))

dwr = gpd.read_parquet(dwr_path).to_crs(ALBERS)
dwr200 = polygonal(shapely.union_all([polygonal(g) for g in dwr.geometry if g is not None]))
dwr200 = polygonal(dwr200.intersection(county)) if dwr200 is not None else None
print(f"DWR 200-year floodplain: {0 if dwr200 is None else dwr200.area / 4046.86:,.0f} acres in the county")

# one dissolved shape per class; each FEMA polygon has exactly one zone, so the classes don't overlap
shapes = {c: shapely.union_all(fema.loc[fema.cls == c].geometry.values) for c in CLASSES}
shapes["200yr"] = dwr200


def shares(geoms: gpd.GeoSeries) -> pd.DataFrame:
    """Share (0-1) of each polygon's area inside each flood class."""
    area = geoms.area.replace(0, float("nan"))
    out = {}
    for c, s in shapes.items():
        out[f"flood_{c}_share"] = (0.0 if s is None or s.is_empty
                                   else (geoms.intersection(s).area / area).fillna(0).clip(0, 1).round(3))
    return pd.DataFrame(out, index=geoms.index)


# ---------- map layers ----------
web = fema[fema.cls != "minimal"].to_crs(4326)
web = web.assign(zone=web.FLD_ZONE, sub=web.ZONE_SUBTY.fillna(""),
                 bfe=web.STATIC_BFE.where(web.STATIC_BFE > -9000))[["cls", "zone", "sub", "bfe", "geometry"]]
make_pmtiles(web, WEB_DATA / "flood.pmtiles", "flood", 7, 13, ["cls", "zone", "sub", "bfe"],
             simplify_px=1.0, min_area_px=1.0, attribution="FEMA National Flood Hazard Layer")
if dwr200 is not None:
    g200 = gpd.GeoDataFrame({"name": ["DWR 200-year floodplain"]}, geometry=[dwr200], crs=ALBERS).to_crs(4326)
    g200["geometry"] = g200.geometry.simplify(0.00005)  # ~5 m
    write_geojson(g200, WEB_DATA / "flood_200yr.geojson")
fema.to_crs(4326).to_parquet(PROCESSED / "flood_zones.parquet")

# ---------- places + county ----------
places = gpd.read_file(WEB_DATA / "places.geojson")
fs = shares(places.to_crs(ALBERS).geometry)
places = places.drop(columns=[c for c in places.columns if c.startswith("flood_")]).join(fs)
write_geojson(places, WEB_DATA / "places.geojson")

apath = WEB_DATA / "areas.geojson"
if apath.exists():
    areas = gpd.read_file(apath)
    fa = shares(areas.to_crs(ALBERS).geometry)
    areas = areas.drop(columns=[c for c in areas.columns if c.startswith("flood_")]).join(fa)
    write_geojson(areas, apath)

stats = json.loads((WEB_DATA / "stats.json").read_text())
cty = shares(gpd.GeoSeries([county], crs=ALBERS)).iloc[0]
stats["county"].update({k: float(v) for k, v in cty.items()})
stats.setdefault("method", {})["flood"] = (
    "Share of land in FEMA flood zones (San Joaquin County map, effective 2009–2016) and in DWR's 200-year "
    "floodplain (Best Available Maps). Shown for context; not part of the scores.")
(WEB_DATA / "stats.json").write_text(json.dumps(stats, separators=(",", ":")))

# ---------- build-next zones (every year) ----------
rz = gpd.read_file(WEB_DATA / "recommend_zones.geojson")
zs = shares(rz.to_crs(ALBERS).geometry)
rz = rz.drop(columns=[c for c in rz.columns if c.startswith("flood_")]).join(zs)
write_geojson(rz, WEB_DATA / "recommend_zones.geojson")

lookup = {(int(r.year), int(r["rank"])): {c: float(r[c]) for c in zs.columns} for _, r in rz.iterrows()}
rec = json.loads((WEB_DATA / "recommend.json").read_text())
missing = 0
for yr, v in rec["by_year"].items():
    for z in v["zones"]:
        f = lookup.get((int(yr), int(z["rank"])))
        missing += f is None
        z.update(f or {})
for z in rec.get("zones", []):
    z.update(lookup.get((int(rec["as_of"]), int(z["rank"])), {}))
# each region's own zones (13_recommend.py, recommend_region_zones.geojson)
rpath = WEB_DATA / "recommend_region_zones.geojson"
if rpath.exists():
    rr = gpd.read_file(rpath)
    rs = shares(rr.to_crs(ALBERS).geometry)
    rr = rr.drop(columns=[c for c in rr.columns if c.startswith("flood_")]).join(rs)
    write_geojson(rr, rpath)
    rlook = {(int(r.year), str(r.GEOID), int(r["rank"])): {c: float(r[c]) for c in rs.columns} for _, r in rr.iterrows()}
    for yr, v in rec["by_year"].items():
        for geoid, zl in v.get("regional", {}).items():
            for z in zl:
                z.update(rlook.get((int(yr), geoid, int(z["rank"])), {}))
rec["flood_method"] = stats["method"]["flood"]
(WEB_DATA / "recommend.json").write_text(json.dumps(rec, separators=(",", ":")))

latest = pd.DataFrame(rec["by_year"][str(rec["as_of"])]["zones"])
print(f"\nFlood exposure of the {rec['as_of']} build-next zones (share of zone area):")
print(latest[["rank", "label", "flood_100yr_share", "flood_floodway_share", "flood_levee_share", "flood_200yr_share"]]
      .head(10).to_string(index=False))
if missing:
    print(f"WARNING: {missing} zones in recommend.json had no matching polygon")
print(f"County: {cty['flood_100yr_share']:.0%} of land in the FEMA 100-year floodplain, "
      f"{cty['flood_200yr_share']:.0%} in the DWR 200-year floodplain")
