"""Download California, San Joaquin County and place (city/CDP) boundaries from Census TIGERweb."""
import geopandas as gpd

from common import (AOI_BBOX, COUNTY_FIPS, PROCESSED, STATE_FIPS, TIGER, arcgis_query,
                    write_geojson)

print("State boundary")
state = arcgis_query(f"{TIGER}/State_County/MapServer/0", where=f"STATE='{STATE_FIPS}'",
                     out_fields="NAME,STATE", extra={"maxAllowableOffset": 0.005})
write_geojson(state, PROCESSED / "california.geojson")

print("County boundary")
county = arcgis_query(f"{TIGER}/State_County/MapServer/1",
                      where=f"STATE='{STATE_FIPS}' AND COUNTY='{COUNTY_FIPS}'",
                      out_fields="NAME,GEOID")
write_geojson(county, PROCESSED / "aoi_county.geojson")

print("Places (incorporated cities + census-designated places)")
frames = []
for layer, kind in ((4, "City"), (5, "CDP")):
    g = arcgis_query(f"{TIGER}/Places_CouSub_ConCity_SubMCD/MapServer/{layer}",
                     where=f"STATE='{STATE_FIPS}'", out_fields="NAME,BASENAME,GEOID",
                     bbox=AOI_BBOX)
    g["kind"] = kind
    frames.append(g)
places = gpd.GeoDataFrame(gpd.pd.concat(frames, ignore_index=True), crs=4326)
# keep places whose interior point is inside the county
inside = places.representative_point().within(county.geometry.union_all())
places = places[inside].reset_index(drop=True)
places = places.rename(columns={"BASENAME": "name"})[["GEOID", "name", "NAME", "kind", "geometry"]]
write_geojson(places, PROCESSED / "places.geojson")
