"""Per-place development and wildfire statistics for the area report and ranking.

Output:
  web/public/data/places.geojson  - place polygons with headline metrics (for the map)
  web/public/data/stats.json      - per-place yearly series + county totals (for charts)
"""
import geopandas as gpd
import numpy as np
import pandas as pd

from common import PROCESSED, WEB_DATA, write_geojson, write_json

SERIES_START, SERIES_END = 1980, 2026  # assessor already records some 2026 completions
# Fixed-scale wildfire risk (not relative to other places, so it stays meaningful statewide):
BURNED_FRACTION_MAX = 0.25  # 25% of the 10 km ring burned since 2000 -> full burn component
WILD_DETECTIONS_MAX = 50    # wildland fire detections per 100 km2 of ring, 2001-2025 -> full component
FIRE_SINCE = 2000
BUFFER_M = 10_000  # fire exposure ring around each place
ALBERS = 3310

places = gpd.read_file(PROCESSED / "places.geojson").to_crs(ALBERS)
county = gpd.read_file(PROCESSED / "aoi_county.geojson").to_crs(ALBERS)
b = gpd.read_parquet(PROCESSED / "buildings.parquet").to_crs(ALBERS)
b["pt"] = b.representative_point()
bp = gpd.GeoDataFrame(b.drop(columns="geometry"), geometry="pt", crs=ALBERS)
res = bp["category"].eq("Residential") & bp["ys"].eq("assessor")
# Commercial & industrial: measured in footprint square feet (one warehouse = one building otherwise)
is_ci = bp["category"].isin(["Commercial", "Industrial"])
ci = is_ci & bp["ys"].eq("assessor")
bp["sqft"] = bp["area_m2"].fillna(0) * 10.764

print("Assigning buildings to places ...")
j = gpd.sjoin(bp[["pt"]], places[["GEOID", "geometry"]], predicate="within", how="left")
j = j[~j.index.duplicated()]
bp["GEOID"] = j["GEOID"].values

fires = gpd.read_file(PROCESSED / "fire_perimeters.geojson").to_crs(ALBERS)
fires = fires[fires["year"] >= FIRE_SINCE]
firms = gpd.read_file(PROCESSED / "firms_modis.geojson").to_crs(ALBERS)
fhsz = gpd.read_file(PROCESSED / "fhsz.geojson").to_crs(ALBERS)
fhsz_hv = fhsz[fhsz["hazard"].isin(["High", "Very High"])]
fhsz_any = fhsz[fhsz["hazard"].isin(["Moderate", "High", "Very High"])]
# Satellite detections outside any hazard zone are mostly agricultural burning on the valley floor;
# only detections inside Moderate/High/Very High zones count as wildland fire.
wild = gpd.sjoin(firms[["geometry"]], fhsz_any[["geometry"]], predicate="within", how="inner")
firms_wild = firms.loc[wild.index.unique()]
print(f"  FIRMS detections: {len(firms):,} total, {len(firms_wild):,} in wildland hazard zones")
fires_sidx, firms_sidx, wild_sidx = fires.sindex, firms.sindex, firms_wild.sindex
years = list(range(SERIES_START, SERIES_END + 1))


def series(mask):
    yrs = bp.loc[mask & res, "y"]
    counts = yrs.value_counts().reindex(years, fill_value=0)
    return [int(v) for v in counts.values], int((yrs < SERIES_START).sum())


def ci_series(mask):
    sub = bp.loc[mask & ci]
    sqft = sub.groupby("y")["sqft"].sum().reindex(years, fill_value=0)
    return [int(round(v)) for v in sqft.values]


def area_stats(geom, mask):
    """Development + wildfire metrics for one polygon (Albers metres)."""
    yearly, before = series(mask)
    yearly_ci = ci_series(mask)
    ci_all = int((mask & is_ci).sum())
    stock_2015 = before + sum(yearly[: years.index(2015) + 1])
    built_16_25 = sum(yearly[years.index(2016): years.index(2025) + 1])
    built_21_25 = sum(yearly[years.index(2021): years.index(2025) + 1])
    ring = geom.buffer(BUFFER_M)
    near = fires.iloc[fires_sidx.query(ring, predicate="intersects")]
    burned_m2 = float(near.intersection(ring).union_all().area) if len(near) else 0.0
    burned_acres = burned_m2 / 4046.86
    nearest_km = float(fires.distance(geom).min() / 1000) if len(fires) else None
    det = int(len(firms_sidx.query(ring, predicate="intersects")))
    det_wild = int(len(wild_sidx.query(ring, predicate="intersects")))
    ring_100km2 = ring.area / 1e8
    hv = fhsz_hv.iloc[fhsz_hv.sindex.query(geom, predicate="intersects")]
    hv_share = float(hv.intersection(geom).area.sum() / geom.area) if len(hv) else 0.0
    anyz = fhsz_any.iloc[fhsz_any.sindex.query(geom, predicate="intersects")]
    bpts = bp.loc[mask, "pt"]
    bldg_in_zone = (float(bpts.within(anyz.geometry.union_all()).mean())
                    if len(anyz) and len(bpts) else 0.0)
    return {
        "buildings": int(mask.sum()),
        "res_dated": int((mask & res).sum()),
        "new_since_2020_snapshot": int((mask & bp["ys"].eq("new")).sum()),
        "res_stock_2015": int(stock_2015),
        "res_built_2016_2025": int(built_16_25),
        "res_built_2021_2025": int(built_21_25),
        "growth_10yr_pct": round(100 * built_16_25 / stock_2015, 1) if stock_2015 else None,
        "fires_10km_since_2000": int(len(near)),
        "burned_acres_10km_since_2000": round(burned_acres),
        "nearest_fire_km": round(nearest_km, 1) if nearest_km is not None else None,
        "firms_10km_since_2001": det,
        "firms_wildland_10km_since_2001": det_wild,
        "burned_fraction_10km": round(burned_m2 / ring.area, 4),
        "wildland_detections_per_100km2": round(det_wild / ring_100km2, 1),
        "fhsz_high_vhigh_share": round(hv_share, 3),
        "buildings_in_fhsz_share": round(bldg_in_zone, 3),
        "ci_buildings": ci_all,
        "ci_dated_share": round(int((mask & ci).sum()) / ci_all, 2) if ci_all else None,
        "ci_sqft_2016_2025": int(sum(yearly_ci[years.index(2016): years.index(2025) + 1])),
        "_yearly": yearly,
        "_yearly_ci": yearly_ci,
        "_before": before,
    }


rows, out_series = [], {}
for _, p in places.iterrows():
    s = area_stats(p.geometry, bp["GEOID"].eq(p["GEOID"]))
    out_series[p["GEOID"]] = {"name": p["name"], "kind": p["kind"],
                              "yearly": s.pop("_yearly"), "yearly_ci_sqft": s.pop("_yearly_ci"),
                              "before": s.pop("_before")}
    rows.append({"GEOID": p["GEOID"], "name": p["name"], "kind": p["kind"], **s})
    print(f"  {p['name']:<16} bldgs={s['buildings']:>7,} 10yr growth={s['growth_10yr_pct']}%")

df = pd.DataFrame(rows)
# Transparent scoring. Growth: percentile of 10-yr residential growth among places with >= 300
# dated homes. Wildfire risk: blend of hazard-zone share, burned area nearby and fire detections.
eligible = df["res_dated"] >= 300
df["growth_score"] = np.nan
df.loc[eligible, "growth_score"] = (df.loc[eligible, "growth_10yr_pct"].rank(pct=True) * 100).round(0)


def risk(d):
    return (100 * (0.5 * d["fhsz_high_vhigh_share"].clip(0, 1)
                   + 0.3 * (d["burned_fraction_10km"] / BURNED_FRACTION_MAX).clip(0, 1)
                   + 0.2 * (d["wildland_detections_per_100km2"] / WILD_DETECTIONS_MAX).clip(0, 1))).round(0)


df["risk_score"] = risk(df)
df["opportunity_score"] = (df["growth_score"] - 0.5 * df["risk_score"]).round(0)
df["rank"] = df["opportunity_score"].rank(ascending=False, method="min").astype("Int64")

print("County totals ...")
cstats = area_stats(county.geometry.iloc[0], pd.Series(True, index=bp.index))
county_series = {"yearly": cstats.pop("_yearly"), "yearly_ci_sqft": cstats.pop("_yearly_ci"),
                 "before": cstats.pop("_before")}

gp = places.to_crs(4326)[["GEOID", "geometry"]].merge(df, on="GEOID")
gp["geometry"] = gp.geometry.simplify(0.0001)
write_geojson(gp, WEB_DATA / "places.geojson")
write_json({
    "years": years,
    "county": {"name": "San Joaquin County", **cstats, **county_series},
    "places": out_series,
    "method": {
        "fire_buffer_km": BUFFER_M / 1000, "fire_since": FIRE_SINCE,
        "growth": "Residential buildings with an assessor year built in 2016-2025, divided by "
                  "residential buildings built up to 2015.",
        "risk": "Fixed 0-100 scale: 50 pts x share of the place in High/Very High Fire Hazard "
                "Severity Zones + 30 pts x share of the surrounding 10 km burned since 2000 (full "
                f"points at {int(BURNED_FRACTION_MAX * 100)}%) + 20 pts x wildland satellite fire "
                f"detections per 100 km2 since 2001 (full points at {WILD_DETECTIONS_MAX}; detections "
                "outside hazard zones, mostly farm burning, are ignored).",
        "opportunity": "growth score - 0.5 x wildfire risk score",
    },
}, WEB_DATA / "stats.json")
cols = ["name", "res_dated", "growth_10yr_pct", "growth_score", "risk_score", "opportunity_score", "rank"]
print(df.sort_values("opportunity_score", ascending=False)[cols].head(12).to_string(index=False))
