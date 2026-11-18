"""Step 18: consistency checks on the data the app shows. Exits with an error (failing run_pipeline.sh) on any mismatch.

Every count must add up wherever the app shows it:
  - the 9 areas add up to the county, and each area = its towns + its rural land (every building counted once)
  - each region's yearly series matches its headline counts (homes 2016-25, stock in 2015, 2021-25)
  - growth % = homes built 2016-25 / homes standing in 2015, for every region and the county
  - build-next zones: score = the shown factors multiplied, ranks run 1..n, acres fit inside their cells, a region's "County #" points at a real county zone,
    and the county / regional zones in recommend.json match the map polygons
Run it after the other steps (it only reads web/public/data).
"""
import json
import math
import sys

from common import WEB_DATA

errors: list[str] = []
CELL_ACRES = 500 * 500 / 4046.86


def check(ok: bool, msg: str) -> None:
    if not ok:
        errors.append(msg)


def feats(name: str) -> list[dict]:
    return [f["properties"] for f in json.loads((WEB_DATA / name).read_text())["features"]]


stats = json.loads((WEB_DATA / "stats.json").read_text())
years = stats["years"]
places = feats("places.geojson")
areas = feats("areas.geojson")
COUNTS = ["buildings", "res_dated", "new_since_2020_snapshot", "res_stock_2015", "res_built_2016_2025",
          "res_built_2021_2025", "ci_buildings", "ci_sqft_2016_2025"]
county = {"name": "County", **stats["county"]}
by_id = {r["GEOID"]: r for r in places + areas}

# ---- every region's own numbers are internally consistent
for r in [county, *places, *areas]:
    s = stats["county"] if r is county else stats["places"][r["GEOID"]]
    yr = dict(zip(years, s["yearly"]))
    check(sum(yr[y] for y in range(2016, 2026)) == r["res_built_2016_2025"],
          f"{r['name']}: yearly 2016-25 sums to {sum(yr[y] for y in range(2016, 2026))}, headline {r['res_built_2016_2025']}")
    check(sum(yr[y] for y in range(2021, 2026)) == r["res_built_2021_2025"], f"{r['name']}: 2021-25 series mismatch")
    stock = s["before"] + sum(yr[y] for y in years if y <= 2015)
    check(stock == r["res_stock_2015"], f"{r['name']}: stock 2015 {r['res_stock_2015']} vs series {stock}")
    if r["res_stock_2015"]:
        g = round(100 * r["res_built_2016_2025"] / r["res_stock_2015"], 1)
        check(r["growth_10yr_pct"] == g, f"{r['name']}: growth {r['growth_10yr_pct']}% vs {g}%")

# ---- areas add up to the county; towns + rural add up to each area
area_rows = [a for a in areas if a["kind"] == "Area"]
for k in COUNTS:
    tot = sum(a[k] for a in area_rows)
    check(tot == county[k], f"areas sum to {tot:,} {k}, county has {county[k]:,}")
for i, y in enumerate(years):
    tot = sum(stats["places"][a["GEOID"]]["yearly"][i] for a in area_rows)
    check(tot == stats["county"]["yearly"][i], f"{y}: areas sum to {tot} homes, county {stats['county']['yearly'][i]}")
for a in area_rows:
    parts = [p for p in places if p.get("area") == a["GEOID"]] + [by_id[a["GEOID"] + "R"]]
    for k in COUNTS:
        tot = sum(p[k] for p in parts)
        check(tot == a[k], f"{a['name']}: towns + rural = {tot:,} {k}, area has {a[k]:,}")
    names = sorted(p["name"] for p in places if p.get("area") == a["GEOID"])
    check(", ".join(names) == (a.get("towns") or ""), f"{a['name']}: town list '{a.get('towns')}' vs {names}")
check(all(p.get("area") for p in places), "some towns have no area")

# ---- build-next zones
rec = json.loads((WEB_DATA / "recommend.json").read_text())
county_poly = {(z["year"], z["rank"]) for z in feats("recommend_zones.geojson")}
region_poly = {(z["year"], z["GEOID"], z["rank"]) for z in feats("recommend_region_zones.geojson")}
for y, v in rec["by_year"].items():
    y = int(y)
    ranks = [z["rank"] for z in v["zones"]]
    check(ranks == list(range(1, len(ranks) + 1)), f"{y}: county zone ranks {ranks}")
    for z in v["zones"]:
        check((y, z["rank"]) in county_poly, f"{y}: county zone #{z['rank']} has no map polygon")
        check(z["acres"] <= z["cells"] * CELL_ACRES + 1, f"{y}: zone #{z['rank']} {z['acres']} acres > its cells")
        if "factors" in z:
            prod = round(100 * math.prod(f / 100 for f in z["factors"].values()))
            check(z["score"] == prod, f"{y}: zone #{z['rank']} score {z['score']} != factors multiplied {prod}")
    for geoid, zl in v.get("regional", {}).items():
        check(geoid in by_id, f"{y}: regional zones for unknown region {geoid}")
        ranks = [z["rank"] for z in zl]
        check(ranks == list(range(1, len(ranks) + 1)), f"{y} {geoid}: regional ranks {ranks}")
        for z in zl:
            check((y, geoid, z["rank"]) in region_poly, f"{y} {geoid}: zone #{z['rank']} has no map polygon")
            check(z["acres"] <= z["cells"] * CELL_ACRES + 1, f"{y} {geoid}: zone #{z['rank']} acres > its cells")
            cr = z.get("county_rank")
            check(cr is None or (y, int(cr)) in county_poly, f"{y} {geoid}: County #{cr} doesn't exist")
            check(all(0 <= f <= 100 for f in z.get("factors", {}).values()), f"{y} {geoid}: factor out of 0-100")
            if "factors" in z:
                prod = round(100 * math.prod(f / 100 for f in z["factors"].values()))
                check(z["score"] == prod, f"{y} {geoid}: zone #{z['rank']} score {z['score']} != factors multiplied {prod}")

if errors:
    print(f"FAILED: {len(errors)} consistency problems")
    for e in errors[:50]:
        print("  -", e)
    sys.exit(1)
print(f"OK: county, {len(area_rows)} areas, {len(places)} towns and {len(rec['by_year'])} years of zones all add up")
