"""Step 17: split the county into areas that cover every acre exactly once.

Cities and census-designated places (step 01) only cover the towns. To give the whole county a clear structure,
this step adds the Census Bureau's county subdivisions (CCDs, "census county divisions"): 9 areas in San Joaquin,
each named after its main town, that tile the county with no gaps or overlaps. Each area is then split into its
towns (cities and CDPs, from step 01) and the rural land left over:

    San Joaquin County
      └ Tracy area (CCD)
          ├ Tracy (city), Mountain House (city) ...       towns whose interior point is in the area
          └ Rural Tracy area                               the area minus all towns

Runs right after 01_boundaries.py; 09_stats.py, 13_recommend.py and 14_flood.py read its output.

Source   Census TIGERweb, County Subdivisions (current), public domain
Output   data/processed/areas.geojson  GEOID, name, kind ("Area" | "Rural"), area (parent CCD GEOID), towns
"""
import geopandas as gpd
import shapely
import pandas as pd

from common import COUNTY_FIPS, PROCESSED, STATE_FIPS, TIGER, arcgis_query, write_geojson

ALBERS = 3310

ccd = arcgis_query(f"{TIGER}/Places_CouSub_ConCity_SubMCD/MapServer/1",
                   where=f"STATE='{STATE_FIPS}' AND COUNTY='{COUNTY_FIPS}'", out_fields="NAME,BASENAME,GEOID")
county = gpd.read_file(PROCESSED / "aoi_county.geojson").to_crs(ALBERS).geometry.union_all()
places = gpd.read_file(PROCESSED / "places.geojson").to_crs(ALBERS)
ccd = ccd.to_crs(ALBERS)
ccd["geometry"] = ccd.geometry.make_valid().intersection(county)

# which area each town belongs to (by its interior point)
home = gpd.sjoin(gpd.GeoDataFrame(places[["GEOID", "name"]], geometry=places.representative_point(), crs=ALBERS),
                 ccd[["GEOID", "geometry"]].rename(columns={"GEOID": "area"}), predicate="within", how="left")
home = home[~home.index.duplicated()]

rows = []
towns_all = places.geometry.union_all()
for _, a in ccd.sort_values("BASENAME").iterrows():
    towns = home.loc[home["area"] == a["GEOID"], "name"].sort_values().tolist()
    nice = f"{a['BASENAME']} area"
    rural = a.geometry.difference(towns_all)
    # Census division lines don't follow city limits (Lathrop and Manteca spill into neighbouring divisions), so an
    # area is its rural land plus its towns *whole*. Towns never overlap, so the parts add up exactly to the area,
    # and the areas still tile the county.
    own = places[places["GEOID"].isin(home.loc[home["area"] == a["GEOID"], "GEOID"])].geometry
    whole = shapely.union_all([rural, *own.values]) if len(own) else rural
    rows.append({"GEOID": a["GEOID"], "name": nice, "kind": "Area", "area": a["GEOID"], "towns": ", ".join(towns),
                 "geometry": whole})
    rows.append({"GEOID": f"{a['GEOID']}R", "name": f"Rural {nice}", "kind": "Rural", "area": a["GEOID"],
                 "towns": "", "geometry": rural})
areas = gpd.GeoDataFrame(rows, crs=ALBERS)

cover = areas[areas.kind == "Area"].geometry.union_all()
areas["geometry"] = areas.geometry.intersection(county).make_valid()
print(f"{int((areas.kind == 'Area').sum())} areas cover {cover.area / county.area:.1%} of the county "
      f"(overlap {areas[areas.kind == 'Area'].area.sum() / cover.area - 1:.2%}); "
      f"towns cover {towns_all.intersection(county).area / county.area:.1%}, rural land the rest")
for _, a in areas[areas.kind == "Area"].iterrows():
    print(f"  {a['name']:<24} {a.geometry.area / 2.59e6:6.0f} sq mi  towns: {a['towns'] or '-'}")
write_geojson(areas.to_crs(4326), PROCESSED / "areas.geojson")
place_area = pd.Series(home["area"].values, index=home["GEOID"].values)
place_area.rename("area").to_frame().rename_axis("GEOID").reset_index().to_csv(PROCESSED / "place_areas.csv",
                                                                                 index=False)
