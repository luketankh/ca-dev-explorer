"""Shared config and helpers for the CA Development Explorer pipeline."""
from __future__ import annotations

import json
import time
from pathlib import Path

import geopandas as gpd
import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
WEB_DATA = ROOT / "web" / "public" / "data"
for d in (RAW, PROCESSED, WEB_DATA):
    d.mkdir(parents=True, exist_ok=True)

# MVP area of interest: San Joaquin County, CA (FIPS 06077)
STATE_FIPS = "06"
COUNTY_FIPS = "077"
AOI_NAME = "San Joaquin County"
# Rough bbox (xmin, ymin, xmax, ymax); exact clipping uses the county polygon.
AOI_BBOX = (-121.59, 37.47, -120.91, 38.31)
CA_BBOX = (-124.5, 32.5, -114.1, 42.05)

OVERTURE_RELEASE = "2026-10-21.0"
YEAR_MIN, YEAR_MAX = 1900, 2026

TIGER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb"

session = requests.Session()
session.headers["User-Agent"] = "ca-dev-explorer/0.1 (research prototype)"


def arcgis_query(layer_url: str, where: str = "1=1", out_fields: str = "*",
                 bbox: tuple | None = None, page_size: int = 2000,
                 extra: dict | None = None, max_retries: int = 4) -> gpd.GeoDataFrame:
    """Page through an ArcGIS FeatureServer/MapServer layer and return a GeoDataFrame (EPSG:4326)."""
    frames, offset = [], 0
    while True:
        params = {
            "where": where, "outFields": out_fields, "outSR": 4326, "f": "geojson",
            "resultOffset": offset, "resultRecordCount": page_size, "returnGeometry": "true",
        }
        if bbox:
            params.update({
                "geometry": ",".join(map(str, bbox)), "geometryType": "esriGeometryEnvelope",
                "inSR": 4326, "spatialRel": "esriSpatialRelIntersects",
            })
        if extra:
            params.update(extra)
        for attempt in range(max_retries):
            try:
                r = session.get(f"{layer_url}/query", params=params, timeout=180)
                r.raise_for_status()
                data = r.json()
                if "error" in data:
                    raise RuntimeError(data["error"])
                break
            except Exception as exc:  # noqa: BLE001
                if attempt == max_retries - 1:
                    raise
                print(f"  retry {attempt + 1} after error: {exc}")
                time.sleep(2 ** attempt)
        feats = data.get("features", [])
        if not feats:
            break
        frames.append(gpd.GeoDataFrame.from_features(feats, crs=4326))
        print(f"  {layer_url.split('/services/')[-1]}: {offset + len(feats):,} features")
        if len(feats) < page_size and not data.get("exceededTransferLimit", False):
            break
        offset += len(feats)
    if not frames:
        return gpd.GeoDataFrame(geometry=[], crs=4326)
    return gpd.GeoDataFrame(gpd.pd.concat(frames, ignore_index=True), crs=4326)


def write_geojson(gdf: gpd.GeoDataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(path, driver="GeoJSON")
    print(f"  wrote {path.relative_to(ROOT)} ({len(gdf):,} features)")


def write_json(obj, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1))
    print(f"  wrote {path.relative_to(ROOT)}")
