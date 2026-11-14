"""General plan land use for San Joaquin County -> map layer.

Reads the reference file added in reference/general_plans/ (California Resources Agency / UC Davis ICE, via
Data Basin; general plans of roughly 2004-2014, "rural residential" variant, 13 standard classes) and writes a
lightly simplified copy for the app. No download: the source file is in the repo.

Shown for context only; the build-next score does not use it yet.
"""
import geopandas as gpd

from common import ROOT, WEB_DATA, write_geojson

SRC = ROOT / "reference" / "general_plans" / "general_plans_san_joaquin.geojson"

g = gpd.read_file(SRC)
print(f"  {len(g):,} general plan polygons, {g['acres'].sum():,.0f} acres")
g = g[["luc", "luc_name", "acres", "geometry"]].copy()
g["luc"] = g["luc"].astype(int)
g["acres"] = g["acres"].round().astype(int)
# ~5 m tolerance: invisible at the zooms the layer is used at, and roughly halves the file
g["geometry"] = g.geometry.simplify(0.00005, preserve_topology=True).make_valid()
g = g[~g.geometry.is_empty]
write_geojson(g, WEB_DATA / "general_plans.geojson")
print(g.groupby("luc_name")["acres"].sum().sort_values(ascending=False).to_string())
