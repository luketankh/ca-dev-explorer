"""Build PMTiles for the web map. Usage: python 10_tiles.py [layer ...]  (default: all)."""
import sys

import geopandas as gpd

from common import PROCESSED, WEB_DATA
from tiler import make_pmtiles


def buildings():
    g = gpd.read_parquet(PROCESSED / "buildings.parquet")
    g["units"] = g["units"].astype("float")
    make_pmtiles(g, WEB_DATA / "buildings.pmtiles", "buildings", 12, 15,
                 ["id", "y", "ys", "category", "use", "units", "area_m2", "h", "src"],
                 simplify_px=0.5, buffer_px=4,
                 attribution="Overture Maps Foundation; San Joaquin County Assessor; Microsoft")


def fire_perimeters():
    g = gpd.read_file(PROCESSED / "fire_perimeters.geojson")
    make_pmtiles(g, WEB_DATA / "fire_perimeters.pmtiles", "fires", 4, 11,
                 ["name", "year", "acres", "agency"], simplify_px=1.0, min_area_px=2.0,
                 attribution="NIFC InterAgency Fire Perimeter History")


def firms():
    g = gpd.read_file(PROCESSED / "firms_modis.geojson")
    make_pmtiles(g, WEB_DATA / "firms.pmtiles", "firms", 3, 10, ["year", "frp"],
                 aggregate_points_below=10, aggregate_group=["year"],
                 attribution="NASA FIRMS (MODIS)")


def fhsz():
    g = gpd.read_file(PROCESSED / "fhsz.geojson")
    make_pmtiles(g, WEB_DATA / "fhsz.pmtiles", "fhsz", 4, 11, ["fhsz", "hazard", "area"],
                 simplify_px=1.0, min_area_px=2.0,
                 attribution="CAL FIRE Fire Hazard Severity Zones (SRA 2024, LRA 2025)")


LAYERS = {"buildings": buildings, "fire_perimeters": fire_perimeters, "firms": firms, "fhsz": fhsz}

if __name__ == "__main__":
    for name in sys.argv[1:] or LAYERS:
        print(f"[{name}]")
        LAYERS[name]()
