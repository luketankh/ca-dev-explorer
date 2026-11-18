"""Independent check of the app's home counts against official state housing estimates.

Recomputes, from the building file and the boundaries (not from the app's own stats), the number of residential
buildings built 2016-2025 and standing in 2015 for every city and the county, and sets them next to the
California Department of Finance housing unit estimates (E-8 for Jan 2016 -> Apr 2020, E-5 for Apr 2020 ->
Jan 2026). Prints a table; changes nothing.

    .venv/bin/python scripts/verify_counts.py          # homes built 2016-2025
    .venv/bin/python scripts/verify_counts.py 2022     # 2016-2022 (assessor records for 2023+ are still filling in)

DOF counts housing *units* (an apartment block is many units); we count residential *buildings* with a year built.
So compare against DOF's single-family units (detached + attached), which are one building each.
Downloads the two DOF workbooks (~2 MB) into data/raw/dof/ on first run.
"""
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
RAW, PROC, WEB = ROOT / "data" / "raw" / "dof", ROOT / "data" / "processed", ROOT / "web" / "public" / "data"
RAW.mkdir(parents=True, exist_ok=True)
URLS = {
    "E8.xlsx": "https://dof.ca.gov/media/docs/forecasting/Demographics/estimates/estimates-e8-2010-2020/"
               "E-8_2010_2020_by_Geo_Internet.xlsx",
    "E5_2026.xlsx": "https://dof.ca.gov/media/docs/forecasting/Demographics/estimates/"
                    "e-5-population-and-housing-estimates-for-cities-counties-and-the-state-2020-2026/"
                    "E-5_2026_InternetVersion.xlsx",
}
for name, url in URLS.items():
    if not (RAW / name).exists():
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=120)
        r.raise_for_status()
        (RAW / name).write_bytes(r.content)

COLS = ["total", "detached", "attached", "two_four", "five_plus", "mobile"]

# ---- ours, recomputed from the building file
b = gpd.read_parquet(PROC / "buildings.parquet")
res = b[(b["category"] == "Residential") & (b["ys"] == "assessor")].copy()
res["geometry"] = res.geometry.representative_point()
places = gpd.read_file(WEB / "places.geojson")[["GEOID", "name", "kind", "geometry"]].to_crs(res.crs)
res = gpd.sjoin(res, places, predicate="within", how="left")
res = res[~res.index.duplicated()]


import sys  # noqa: E402

END = int(sys.argv[1]) if len(sys.argv) > 1 else 2025  # last year built to compare (DOF snapshot is Jan 1 of END+1)


def ours(mask):
    y = res.loc[mask, "y"]
    return int(y.between(2016, END).sum()), int(((y > 0) & (y <= 2015)).sum())


# ---- DOF
e8 = pd.read_excel(RAW / "E8.xlsx", "E-8 by geography", header=None, skiprows=3)
e8.columns = ["county", "city", "date", "pop", "hh", "gq", *COLS, "occ", "vac", "pph"]
e8 = e8[e8["county"] == "San Joaquin"]
e8["date"] = pd.to_datetime(e8["date"])


def e5_rows(year):
    d = pd.read_excel(RAW / "E5_2026.xlsx", f"E5CityCounty{year}", header=None, skiprows=4)
    d = d.iloc[:, :12]
    d.columns = ["name", "pop", "hh", "gq", *COLS, "occ", "vac"]
    d["name"] = d["name"].astype(str).str.strip()
    start = d.index[d["name"] == "San Joaquin County"][0]
    block = d.loc[start + 1:]
    end = block.index[block["pop"].isna()]
    return block.loc[: end[0] - 1] if len(end) else block


def dof(city):
    """Units added 1/1/2016 -> 1/1/2026 (E-8 to 4/1/2020, then E-5), and units on 1/1/2016."""
    key = "Balance Of County" if city == "Unincorporated" else city
    a = e8[(e8["city"].astype(str).str.strip().str.lower() == key.lower())]
    if a.empty:
        return None
    s16 = a[a["date"] == "2016-01-01"].iloc[0]
    s20 = a[a["date"] == "2020-04-01"].iloc[0]
    e20, e26 = e5_rows(2020), e5_rows(END + 1)
    n20 = e20[e20["name"].str.lower() == key.lower()]
    n26 = e26[e26["name"].str.lower() == key.lower()]
    if n20.empty or n26.empty:
        return None
    sf = lambda r: float(r["detached"]) + float(r["attached"])  # noqa: E731
    return {
        "added_units": float(s20["total"] - s16["total"] + n26.iloc[0]["total"] - n20.iloc[0]["total"]),
        "added_sf": sf(s20) - sf(s16) + sf(n26.iloc[0]) - sf(n20.iloc[0]),
        "units_2016": float(s16["total"]), "sf_2016": sf(s16),
    }


rows = []
cities = places[places["kind"] == "City"].sort_values("name")
for _, c in cities.iterrows():
    built, stock = ours(res["GEOID"] == c["GEOID"])
    rows.append({"place": c["name"], "ours_built": built, "ours_stock": stock, **(dof(c["name"]) or {})})
built, stock = ours(pd.Series(True, index=res.index))
e8c = e8[e8["city"].astype(str).str.contains("County Total", case=False)]
rows.append({"place": "San Joaquin County", "ours_built": built, "ours_stock": stock})
t = pd.DataFrame(rows)
# county from the county rows
s16 = e8c[e8c["date"] == "2016-01-01"].iloc[0]
s20 = e8c[e8c["date"] == "2020-04-01"].iloc[0]
cty = pd.read_excel(RAW / "E5_2026.xlsx", "E5CountyState2020", header=None, skiprows=4).iloc[:, :10]
cty26 = pd.read_excel(RAW / "E5_2026.xlsx", f"E5CountyState{END + 1}", header=None, skiprows=4).iloc[:, :10]
pick = lambda d: d[d.iloc[:, 0].astype(str).str.strip() == "San Joaquin"].iloc[0]  # noqa: E731
r20, r26 = pick(cty), pick(cty26)
i = t.index[t["place"] == "San Joaquin County"][0]
t.loc[i, "added_units"] = float(s20["total"] - s16["total"] + r26[4] - r20[4])
t.loc[i, "added_sf"] = float(s20["detached"] + s20["attached"] - s16["detached"] - s16["attached"]
                             + r26[5] + r26[6] - r20[5] - r20[6])
t.loc[i, "units_2016"], t.loc[i, "sf_2016"] = float(s16["total"]), float(s16["detached"] + s16["attached"])
t["diff_vs_sf_%"] = (100 * (t["ours_built"] - t["added_sf"]) / t["added_sf"]).round(0)
t["stock_vs_sf_%"] = (100 * (t["ours_stock"] - t["sf_2016"]) / t["sf_2016"]).round(0)
pd.set_option("display.width", 200)
print(f"Homes built 2016-{END}: ours (residential buildings with an assessor year) vs DOF units added "
      f"1/1/2016 -> 1/1/{END + 1}; stock = ours built by 2015 vs DOF units on 1/1/2016")
print(t.round(0).to_string(index=False))
