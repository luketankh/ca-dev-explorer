"""Home insurance premiums and crime rates, statewide by county plus city level for the AOI.

Sources
  - HearthMap county homeowners-insurance premiums (2024), CC BY 4.0, based on
    Keys & Mulder, NBER Working Paper 32579 (median escrowed premium, mortgaged owner-occupied homes)
  - CA DOJ OpenJustice "Crimes & Clearances (with arson)" 1985-2025, by reporting agency
  - CA Department of Finance E-1 population estimates (Jan 1, 2025) for per-capita rates

Crime notes
  - Railroad police agencies are excluded (e.g. Union Pacific reports large cargo-theft counts that
    do not reflect residential safety).
  - City rates are only possible where the city has its own police department. Places patrolled by
    the County Sheriff (unincorporated areas, plus contract cities such as Mountain House) get the
    Sheriff's rate. Its population is the county total minus the cities with their own department.
"""
import geopandas as gpd
import numpy as np
import pandas as pd

from common import (AOI_NAME, PROCESSED, RAW, STATE_FIPS, TIGER, WEB_DATA, arcgis_query, session,
                    write_geojson, write_json)

INS_URL = "https://hearthmap.app/home-insurance-by-county/california/csv"
CRIME_URL = ("https://data-openjustice.doj.ca.gov/sites/default/files/dataset/2026-07/"
             "Crimes_and_Clearances_with_Arson-1985-2025.csv")
DOF_URL = ("https://dof.ca.gov/media/docs/forecasting/Demographics/estimates-e1/"
           "E-1_2026_InternetVersion.xlsx")
CRIME_YEAR = 2025
RAIL = r"railroad|\bRR\b|union pacific|bnsf|amtrak"


def fetch(url, path):
    if not path.exists():
        r = session.get(url, timeout=300)
        r.raise_for_status()
        path.write_bytes(r.content)
    return path


ins = pd.read_csv(fetch(INS_URL, RAW / "hearthmap_ca_insurance.csv"), dtype={"county_geoid": str})
crime = pd.read_csv(fetch(CRIME_URL, RAW / "doj_crimes_clearances_1985_2025.csv"), low_memory=False)
dof_path = fetch(DOF_URL, RAW / "dof_e1_2026.xlsx")

# --- population (DOF E-1, Jan 1 2025) -------------------------------------------------------
county_pop = pd.read_excel(dof_path, "E-1 CountyState2026", header=None, skiprows=5,
                           usecols=[0, 1], names=["county", "pop"])
county_pop["county"] = county_pop["county"].astype(str).str.strip()
county_pop["pop"] = pd.to_numeric(county_pop["pop"], errors="coerce")
county_pop = county_pop.dropna()
county_pop = county_pop[county_pop["county"] != "California"]
county_names = set(county_pop["county"])
assert len(county_names) == 58, f"expected 58 counties, got {len(county_names)}"

# City sheet: each county row (same population as on the county sheet) is followed by its cities.
# Matching on population avoids confusing cities named like a county (e.g. San Joaquin city, Fresno Co.).
county_total = county_pop.set_index("county")["pop"].to_dict()
city_sheet = pd.read_excel(dof_path, "E-1 CityCounty2026", header=None, skiprows=5, usecols=[0, 1])
rows, current = [], None
for name, pop in city_sheet.itertuples(index=False):
    name, pop = str(name).strip(), pd.to_numeric(pop, errors="coerce")
    if pd.isna(pop):
        continue
    if name in county_total and pop == county_total[name] and name != current:
        current = name
        continue
    if current:
        rows.append((current, name, pop))
city_pop = pd.DataFrame(rows, columns=["county", "city", "pop"])

# --- crime by agency ---------------------------------------------------------------------------
crime = crime[~crime["NCICCode"].astype(str).str.contains(RAIL, case=False, regex=True)]
crime["county"] = crime["County"].str.replace(r" County$", "", regex=True).str.strip()
cy = crime[crime["Year"] == CRIME_YEAR]
by_county = cy.groupby("county")[["Violent_sum", "Property_sum"]].sum().reset_index()
by_county = by_county.merge(county_pop, on="county", how="left")
by_county["violent_per_1k"] = (1000 * by_county["Violent_sum"] / by_county["pop"]).round(2)
by_county["property_per_1k"] = (1000 * by_county["Property_sum"] / by_county["pop"]).round(2)

# 10-year trend in total crime counts (population changes little over this period statewide)
trend = crime[crime["Year"].isin([CRIME_YEAR - 10, CRIME_YEAR])].groupby(["county", "Year"])[
    ["Violent_sum", "Property_sum"]].sum().sum(axis=1).unstack()
trend["crime_change_10yr_pct"] = (100 * (trend[CRIME_YEAR] / trend[CRIME_YEAR - 10] - 1)).round(1)
by_county = by_county.merge(trend[["crime_change_10yr_pct"]].reset_index(), on="county", how="left")

# --- county polygons ---------------------------------------------------------------------------
print("County boundaries")
counties = arcgis_query(f"{TIGER}/State_County/MapServer/1", where=f"STATE='{STATE_FIPS}'",
                        out_fields="NAME,BASENAME,GEOID", extra={"maxAllowableOffset": 0.003})
counties = counties.rename(columns={"BASENAME": "county"})[["GEOID", "county", "geometry"]]
counties = counties.merge(ins[["county_geoid", "avg_annual_premium_2024", "median_home_value",
                               "premium_pct_of_home_value"]],
                          left_on="GEOID", right_on="county_geoid", how="left").drop(columns="county_geoid")
counties = counties.merge(by_county.drop(columns=["Violent_sum", "Property_sum"]), on="county", how="left")
counties = counties.rename(columns={"avg_annual_premium_2024": "premium", "pop": "pop_2025"})
counties["premium_rank"] = counties["premium"].rank(ascending=False, method="min").astype("Int64")
counties["violent_rank"] = counties["violent_per_1k"].rank(ascending=False, method="min").astype("Int64")
counties["property_rank"] = counties["property_per_1k"].rank(ascending=False, method="min").astype("Int64")
write_geojson(counties, WEB_DATA / "counties.geojson")

state = {
    "premium_median": float(ins["avg_annual_premium_2024"].median()),
    "premium_mean": round(float(ins["avg_annual_premium_2024"].mean())),
    "premium_counties": int(ins["avg_annual_premium_2024"].notna().sum()),
    "violent_per_1k": round(1000 * float(cy["Violent_sum"].sum()) / float(county_pop["pop"].sum()), 2),
    "property_per_1k": round(1000 * float(cy["Property_sum"].sum()) / float(county_pop["pop"].sum()), 2),
    "counties": int(len(counties)),
}

# --- city level for the AOI --------------------------------------------------------------------
aoi = AOI_NAME.replace(" County", "")
places = gpd.read_file(PROCESSED / "places.geojson")
agencies = cy[cy["county"] == aoi].set_index("NCICCode")
cpop = city_pop[city_pop["county"] == aoi].set_index("city")["pop"]
own = [p for p in places.loc[places["kind"] == "City", "name"] if p in agencies.index]
sheriff_row = agencies[agencies.index.str.contains("Sheriff", case=False)].sum(numeric_only=True)
sheriff_pop = float(county_pop.set_index("county").loc[aoi, "pop"]) - float(cpop.reindex(own).sum())

place_ctx = {}
for _, p in places.iterrows():
    if p["name"] in own:
        a, pop, cover = agencies.loc[p["name"]], float(cpop[p["name"]]), "own"
        agency = f"{p['name']} Police Department"
    else:
        a, pop, cover = sheriff_row, sheriff_pop, "sheriff"
        agency = f"{aoi} County Sheriff (unincorporated + contract cities)"
    place_ctx[p["GEOID"]] = {
        "crime_agency": agency, "crime_coverage": cover,
        "crime_pop": round(pop),
        "violent_per_1k": round(1000 * float(a["Violent_sum"]) / pop, 2),
        "property_per_1k": round(1000 * float(a["Property_sum"]) / pop, 2),
        "pop_2025": int(cpop[p["name"]]) if p["name"] in cpop.index else None,
    }

c = counties[counties["county"] == aoi].iloc[0]
county_ctx = {k: (None if pd.isna(c[k]) else (float(c[k]) if isinstance(c[k], (float, np.floating)) else
                                               int(c[k]) if isinstance(c[k], (int, np.integer)) else c[k]))
              for k in ["county", "premium", "median_home_value", "premium_pct_of_home_value",
                        "premium_rank", "violent_per_1k", "property_per_1k", "violent_rank",
                        "property_rank", "crime_change_10yr_pct", "pop_2025"]}
write_json({"crime_year": CRIME_YEAR, "insurance_year": 2024, "state": state, "county": county_ctx,
            "places": place_ctx}, WEB_DATA / "context.json")

print(f"{aoi}: premium ${county_ctx['premium']:,.0f} (rank {county_ctx['premium_rank']}/"
      f"{state['premium_counties']}), violent {county_ctx['violent_per_1k']}/1k "
      f"(state {state['violent_per_1k']}), property {county_ctx['property_per_1k']}/1k "
      f"(state {state['property_per_1k']})")
for g, v in place_ctx.items():
    name = places.set_index("GEOID").loc[g, "name"]
    if v["crime_coverage"] == "own" or name == "Mountain House":
        print(f"  {name:<15} violent {v['violent_per_1k']:>5}/1k  property {v['property_per_1k']:>6}/1k  ({v['crime_agency']})")
