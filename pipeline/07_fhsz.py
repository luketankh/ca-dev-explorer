"""CAL FIRE Fire Hazard Severity Zones, statewide.

- SRA (State Responsibility Area), effective 2024-04-01
- LRA (Local Responsibility Area), map dated 2025-02-24

Both come from a public mirror of CAL FIRE's data hosted by Sonoma County. Confirm current zones
with CAL FIRE OSFM before relying on them for decisions.
"""
import geopandas as gpd

from common import PROCESSED, arcgis_query, write_geojson

BASE = "https://socogis.sonomacounty.ca.gov/map/rest/services/CALFIREPublic"
frames = []
for area in ("State", "Local"):
    print(f"{area} Responsibility Area FHSZ ...")
    g = arcgis_query(f"{BASE}/{area}_Responsibility_Area_Fire_Hazard_Severity_Zones/FeatureServer/0",
                     out_fields="FHSZ,FHSZ_Description", page_size=500,
                     extra={"maxAllowableOffset": 0.0003, "geometryPrecision": 5})
    g["area"] = "SRA" if area == "State" else "LRA"
    frames.append(g)
g = gpd.GeoDataFrame(gpd.pd.concat(frames, ignore_index=True), crs=4326)
g = g.rename(columns={"FHSZ": "fhsz", "FHSZ_Description": "hazard"})
g["geometry"] = g.geometry.make_valid()
write_geojson(g[["fhsz", "hazard", "area", "geometry"]], PROCESSED / "fhsz.geojson")
