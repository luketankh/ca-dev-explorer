"""Step 16: utility infrastructure for the map and the where-to-build-next score.

Runs BEFORE 13_recommend.py (see run_pipeline.sh), which reads its processed outputs.

Two kinds of utility data, used in opposite directions:

  Constraints (land you can't build homes on)
    Electric transmission lines   California Energy Commission, "California Electric Transmission Lines"
                                  (60 kV and up; CEC conditions of use: free to use with attribution)
    Major natural gas pipelines   U.S. EIA, "Natural Gas Interstate and Intrastate Pipelines" (public domain)
    Each line gets an easement / safety buffer (half-width, metres) that grows with voltage; see BUFFER_M.

  Services (land that's cheap to hook up)
    Drinking water service areas  State Water Resources Control Board, Division of Drinking Water, "California
                                  Drinking Water System Area Boundaries" (SABL). Community water systems only
                                  (systems serving residents year-round), not schools, parks or businesses.
    Sewer service areas           Incorporated cities (city sewer) + San Joaquin County Public Works sewer districts
                                  (county service areas, maintenance and sanitary districts).

Neighbourhood-level electric and gas distribution lines aren't public (PG&E's maps need a login and limit reuse),
so they are not included. Only boundary, name, type and size fields are requested: no contact details.

Caveat: service areas are TODAY's boundaries. They grow with new subdivisions, so backtests that use them for
past years see a little of the future. 13_recommend.py reports the backtest with and without utilities.

Inputs   data/raw/{cec_transmission,eia_gas_pipelines,swrcb_water_systems,sj_sewer_districts}.parquet
         (downloaded if missing), data/processed/places.geojson (city limits)
Outputs  data/processed/utility_easements.parquet   buffered power/gas lines (Albers), used by 13_recommend.py
         data/processed/water_service.parquet       community water system areas (Albers)
         data/processed/sewer_service.parquet       city limits + county sewer districts (Albers)
         web/public/data/utility_lines.geojson      power lines (kV) + gas pipelines, clipped to the county
         web/public/data/service_areas.geojson      water and sewer service areas, clipped to the county
"""
from __future__ import annotations

import geopandas as gpd
import pandas as pd
import shapely

from common import AOI_BBOX, PROCESSED, RAW, WEB_DATA, arcgis_query, write_geojson

ALBERS = 3310
CEC_TX_URL = "https://services3.arcgis.com/bWPjFyq029ChCGur/arcgis/rest/services/Transmission_Line/FeatureServer/2"
EIA_GAS_URL = ("https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/"
               "Natural_Gas_Interstate_and_Intrastate_Pipelines_1/FeatureServer/0")
SABL_URL = ("https://gispublic.waterboards.ca.gov/portalserver/rest/services/Drinking_Water/"
            "California_Drinking_Water_System_Area_Boundaries/FeatureServer/0")
SJ_SEWER_URL = "https://services2.arcgis.com/GQhSReJEO6f7tsvy/arcgis/rest/services/SewerDistricts/FeatureServer/0"


def buffer_m(kind: str, kv: float | None) -> float:
    """Half-width (m) of land lost to an easement / safety setback either side of a line.

    Typical right-of-way widths: 60-70 kV ~30 m, 115 kV ~45 m, 230 kV ~75 m, 500 kV ~150 m (CPUC / utility
    standards); gas transmission ~15 m easement, kept at 25 m each side as a safety setback for homes.
    """
    if kind == "gas":
        return 25.0
    kv = kv or 60
    if kv >= 300:
        return 75.0
    if kv >= 200:
        return 40.0
    if kv >= 100:
        return 25.0
    return 15.0


# ---------- download (cached) ----------
def cached(name: str, url: str, **kw) -> gpd.GeoDataFrame:
    path = RAW / f"{name}.parquet"
    if not path.exists():
        print(f"Downloading {name} ...")
        arcgis_query(url, bbox=AOI_BBOX, **kw).to_parquet(path)
    return gpd.read_parquet(path)


tx = cached("cec_transmission", CEC_TX_URL, out_fields="kV,Status,Owner,Type,Name")
gas = cached("eia_gas_pipelines", EIA_GAS_URL, out_fields="TYPEPIPE,Operator,Status")
# contact fields (phone, email, address) are deliberately not requested
sabl = cached("swrcb_water_systems", SABL_URL,
              out_fields="SABL_PWSID,WATER_SYSTEM_NAME,FEDERAL_CLASSIFICATION,BOUNDARY_TYPE,POPULATION,SERVICE_CONNECTIONS")
sewer_d = cached("sj_sewer_districts", SJ_SEWER_URL, out_fields="DISTRICT")

county = gpd.read_file(PROCESSED / "aoi_county.geojson").to_crs(ALBERS).geometry.union_all()
near_county = county.buffer(2000)

# ---------- power + gas lines ----------
tx = tx.to_crs(ALBERS)
tx = tx[tx.geometry.notna() & ~tx["Status"].fillna("").str.contains("Proposed|Abandoned|Retired", case=False)]
tx["kv"] = pd.to_numeric(tx["kV"], errors="coerce")
tx = tx.assign(kind="power", name=tx["Name"].fillna(""), owner=tx["Owner"].fillna(""),
               underground=tx["Type"].fillna("").eq("UG"))
gas = gas.to_crs(ALBERS)
gas = gas[gas.geometry.notna() & gas["Status"].fillna("Operating").str.contains("Operat", case=False)]
gas = gas.assign(kind="gas", kv=None, name="Natural gas transmission pipeline", owner=gas["Operator"].fillna(""),
                 underground=True)
lines = gpd.GeoDataFrame(pd.concat([tx[["kind", "kv", "name", "owner", "underground", "geometry"]],
                                    gas[["kind", "kv", "name", "owner", "underground", "geometry"]]], ignore_index=True),
                         crs=ALBERS)
lines = lines[lines.intersects(near_county)].copy()
lines["buffer_m"] = [buffer_m(k, v) for k, v in zip(lines["kind"], lines["kv"])]
km_in = lines.geometry.intersection(county).length / 1000
print(f"Inside the county: {km_in[lines.kind == 'power'].sum():,.0f} km of power lines, "
      f"{km_in[lines.kind == 'gas'].sum():,.0f} km of gas transmission pipelines")

ease = gpd.GeoDataFrame({"kind": lines["kind"].values},
                        geometry=lines.geometry.buffer(lines["buffer_m"], cap_style="flat"), crs=ALBERS)
ease = ease.dissolve("kind").reset_index()
ease.to_parquet(PROCESSED / "utility_easements.parquet")
print(f"  easement land in the county: "
      f"{ease.geometry.union_all().intersection(county).area / 4046.86:,.0f} acres")

web_lines = lines.copy()
web_lines["geometry"] = web_lines.geometry.intersection(near_county).simplify(5)
web_lines = web_lines[~web_lines.geometry.is_empty]
web_lines["kv"] = web_lines["kv"].astype("Float64")
write_geojson(web_lines[["kind", "kv", "name", "owner", "underground", "buffer_m", "geometry"]].to_crs(4326),
              WEB_DATA / "utility_lines.geojson")

# ---------- water + sewer service areas ----------
water = sabl.to_crs(ALBERS)
water = water[water["FEDERAL_CLASSIFICATION"].eq("COMMUNITY") & water.geometry.notna()].copy()
water["geometry"] = water.geometry.make_valid()
water = water[water.intersects(county)]
water = water.assign(kind="water", name=water["WATER_SYSTEM_NAME"].str.title(),
                     population=pd.to_numeric(water["POPULATION"], errors="coerce"))
print(f"Community water systems in the county: {len(water)}")

places = gpd.read_file(PROCESSED / "places.geojson").to_crs(ALBERS)
cities = places[places["kind"] == "City"]
sewer = pd.concat([
    gpd.GeoDataFrame({"name": cities["name"] + " (city sewer)", "source": "City limits"}, geometry=cities.geometry,
                     crs=ALBERS),
    gpd.GeoDataFrame({"name": sewer_d["DISTRICT"].str.strip(), "source": "San Joaquin County Public Works"},
                     geometry=sewer_d.to_crs(ALBERS).geometry.make_valid(), crs=ALBERS),
], ignore_index=True)
sewer = gpd.GeoDataFrame(sewer, crs=ALBERS).assign(kind="sewer", population=None)
print(f"Sewer service areas: {len(cities)} cities + {len(sewer_d)} county sewer districts")

water[["kind", "name", "population", "geometry"]].to_parquet(PROCESSED / "water_service.parquet")
sewer[["kind", "name", "source", "geometry"]].to_parquet(PROCESSED / "sewer_service.parquet")

svc = gpd.GeoDataFrame(pd.concat([water[["kind", "name", "population", "geometry"]],
                                  sewer[["kind", "name", "population", "geometry"]]], ignore_index=True), crs=ALBERS)
svc["geometry"] = svc.geometry.intersection(county).simplify(10)
svc = svc[~svc.geometry.is_empty & svc.geometry.notna()]
svc["population"] = svc["population"].astype("Float64")
write_geojson(svc.to_crs(4326), WEB_DATA / "service_areas.geojson")

w_all = shapely.union_all(water.geometry.values).intersection(county)
s_all = shapely.union_all(sewer.geometry.values).intersection(county)
print(f"County land with community water service: {w_all.area / county.area:.1%}, "
      f"with sewer: {s_all.area / county.area:.1%}, both: {w_all.intersection(s_all).area / county.area:.1%}")
