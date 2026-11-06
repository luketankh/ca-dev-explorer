"""Fire history that accounts for frequency AND recency.

Every past fire near a location gets an age weight that halves every HALF_LIFE years:
    w(fire) = 0.5 ** ((as_of - fire_year) / HALF_LIFE)        (fires after `as_of` are ignored)
so a fire last year counts ~1, a fire 10 years ago 0.5, 20 years ago 0.25, 40 years ago 0.06.

Three history parts, each scaled to 0-1, then averaged into `history`:
  frequency  recency-weighted number of separate fires per 100 km2 of the surrounding ring
             (full marks at FREQ_FULL)
  reburn     recency-weighted share of the ring burned, where land burned twice counts twice
             (full marks at BURN_FULL)
  last fire  the most recent *significant* fire: max over fires of age weight x size factor, where the
             size factor is the share of the ring it burned / 1% (capped at 1). A big fire last year
             scores ~1; a 10-acre grass fire last year scores low.
Satellite detections (NASA FIRMS, wildland only) get the same age weighting -> `detections`
(per 100 km2, full marks at DET_FULL).

fire risk = 0.5 x hazard zone + 0.3 x history + 0.2 x detections
"""
from __future__ import annotations

import math

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from scipy import sparse
from sklearn.neighbors import NearestNeighbors

from common import PROCESSED

HALF_LIFE = 10.0     # years for a fire's weight to halve
FREQ_FULL = 4.0      # recency-weighted fires per 100 km2 for full "frequency" marks
BURN_FULL = 0.25     # recency-weighted burned share of the ring for full "reburn" marks
DET_FULL = 25.0      # recency-weighted wildland detections per 100 km2 for full marks
W_HAZARD, W_HISTORY, W_DETECT = 0.5, 0.3, 0.2
MIN_ACRES = 10       # fires smaller than this are ignored (CAL FIRE's own recording threshold)
LAST_SIZE_FULL = 0.01  # a fire must burn >= 1% of the ring to count fully in 'time since last fire'
ALBERS = 3310

METHOD = (f"Fire risk = {W_HAZARD:g} x hazard zone + {W_HISTORY:g} x fire history + {W_DETECT:g} x satellite "
          f"detections. Every past fire is weighted by age (weight halves every {HALF_LIFE:g} years). Fire history "
          "averages three parts: frequency (weighted number of separate fires nearby), reburn (weighted share of "
          "land burned, counting repeat burns) and time since the last significant fire (one that burned at least "
          "1% of the surrounding area; smaller fires count proportionally less).")


def weights(years: np.ndarray, as_of: int) -> np.ndarray:
    age = as_of - years
    return np.where(age >= 0, 0.5 ** (np.clip(age, 0, None) / HALF_LIFE), 0.0)


def load_fires(area: shapely.Geometry, pad_m: float) -> gpd.GeoDataFrame:
    """Fire perimeters (Albers) within `pad_m` of `area`."""
    f = gpd.read_file(PROCESSED / "fire_perimeters.geojson").to_crs(ALBERS)
    # CAL FIRE's database records fires of 10+ acres; apply the same floor to the newer WFIGS years so
    # tiny roadside fires don't reset "time since last fire"
    f = f[f["acres"] >= MIN_ACRES]
    f = f[f.intersects(area.buffer(pad_m))].reset_index(drop=True)
    f["geometry"] = f.geometry.make_valid()
    return f


def load_wild_detections(area: shapely.Geometry, pad_m: float) -> gpd.GeoDataFrame:
    """FIRMS detections inside Moderate+ hazard zones (wildland), within `pad_m` of `area`."""
    det = gpd.read_file(PROCESSED / "firms_modis.geojson").to_crs(ALBERS)
    det = det[det.intersects(area.buffer(pad_m))]
    fhsz = gpd.read_file(PROCESSED / "fhsz.geojson").to_crs(ALBERS)
    fhsz = fhsz[fhsz["hazard"].isin(["Moderate", "High", "Very High"])]
    idx = gpd.sjoin(det[["geometry"]], fhsz[["geometry"]], predicate="within").index.unique()
    return det.loc[idx].reset_index(drop=True)


def _scale(freq_density, burn, last_raw, det_density):
    c_freq = np.clip(freq_density / FREQ_FULL, 0, 1)
    c_burn = np.clip(burn / BURN_FULL, 0, 1)
    c_last = np.clip(last_raw, 0, 1)
    c_det = np.clip(det_density / DET_FULL, 0, 1)
    history = (c_freq + c_burn + c_last) / 3
    return c_freq, c_burn, c_last, c_det, history


def risk(hazard: np.ndarray, history: np.ndarray, detections: np.ndarray) -> np.ndarray:
    return np.clip(W_HAZARD * hazard + W_HISTORY * history + W_DETECT * detections, 0, 1)


class GridHistory:
    """Fire history for many points (cell centres) at once, for any `as_of` year.

    Fires and detections are first summarised on a fine grid that extends `radius` beyond the
    points (so fires just outside the county still count); each point's ring is the set of grid
    cells within `radius`.
    """

    def __init__(self, centres_xy: np.ndarray, area: shapely.Geometry, radius: float = 5000, cell: float = 500):
        self.radius = radius
        fires = load_fires(area, radius + cell)
        dets = load_wild_detections(area, radius + cell)
        xmin, ymin = centres_xy.min(axis=0) - radius - cell
        xmax, ymax = centres_xy.max(axis=0) + radius + cell
        gx = np.arange(math.floor(xmin / cell) * cell, xmax, cell)
        gy = np.arange(math.floor(ymin / cell) * cell, ymax, cell)
        grid = gpd.GeoDataFrame(geometry=[shapely.box(x, y, x + cell, y + cell) for x in gx for y in gy], crs=ALBERS)
        gc = np.column_stack([grid.centroid.x, grid.centroid.y])

        # point -> grid cells in its ring
        nbr = NearestNeighbors().fit(gc).radius_neighbors(centres_xy, radius=radius, return_distance=False)
        rows = np.repeat(np.arange(len(centres_xy)), [len(n) for n in nbr])
        self.M = sparse.csr_matrix((np.ones(len(rows)), (rows, np.concatenate(nbr))), shape=(len(centres_xy), len(grid)))
        self.ring_area = np.asarray(self.M.sum(axis=1)).ravel() * cell * cell

        # grid cell x fire: burned area (m2)
        if len(fires):
            ov = gpd.overlay(grid.reset_index(), fires[["geometry"]].reset_index().rename(columns={"index": "fire"}),
                             how="intersection", keep_geom_type=True)
            P = sparse.csr_matrix((ov.area.values, (ov["index"].values, ov["fire"].values)), shape=(len(grid), len(fires)))
        else:
            P = sparse.csr_matrix((len(grid), 0))
        S = (self.M @ P).tocsr()                          # point x fire: burned m2 inside ring
        self.burn_share = S.multiply(1 / self.ring_area[:, None]).tocsr()
        self.present = (S > 0).astype(float).tocsr()
        self.fire_years = fires["year"].values.astype(float)

        # grid cell x year: wildland detections
        self.det_years = np.arange(2000, 2031)
        if len(dets):
            dj = gpd.sjoin(dets[["year", "geometry"]], grid[["geometry"]], predicate="within")
            D = sparse.csr_matrix((np.ones(len(dj)), (dj["index_right"].values, dj["year"].values - 2000)),
                                  shape=(len(grid), len(self.det_years)))
        else:
            D = sparse.csr_matrix((len(grid), len(self.det_years)))
        self.ring_det = (self.M @ D).toarray()            # point x year
        print(f"  fire history grid: {len(grid):,} cells, {len(fires)} fires, {len(dets):,} wildland detections")

    def at(self, as_of: int) -> pd.DataFrame:
        wf = weights(self.fire_years, as_of)
        freq = self.present @ wf
        burn = self.burn_share @ wf
        # years since most recent fire present in the ring (fires up to as_of only)
        known = self.fire_years <= as_of
        last = np.full(self.present.shape[0], np.nan)
        pres = self.present[:, known].tocoo()
        if pres.nnz:
            yrs = self.fire_years[known][pres.col]
            latest = pd.Series(yrs).groupby(pres.row).max()
            last[latest.index.values] = as_of - latest.values
        # size-aware recency of the last significant fire: max_f w(age_f) * min(1, share_f / 1%)
        sz = self.burn_share.tocoo()
        last_raw = np.zeros(self.present.shape[0])
        if sz.nnz:
            v = wf[sz.col] * np.minimum(1.0, sz.data / LAST_SIZE_FULL)
            mx = pd.Series(v).groupby(sz.row).max()
            last_raw[mx.index.values] = mx.values
        wd = weights(self.det_years.astype(float), as_of)
        det = self.ring_det @ wd
        per100 = self.ring_area / 1e8
        c_freq, c_burn, c_last, c_det, history = _scale(freq / per100, burn, last_raw, det / per100)
        return pd.DataFrame({"fire_freq": c_freq, "fire_reburn": c_burn, "fire_last": c_last, "fire_history": history,
                             "fire_detections": c_det, "years_since_fire": last,
                             "fires_weighted": freq})


def area_history(ring: shapely.Geometry, fires: gpd.GeoDataFrame, dets: gpd.GeoDataFrame, as_of: int) -> dict:
    """Same measures for one ring polygon (used for per-city stats)."""
    near = fires[fires.intersects(ring)]
    near = near[near["year"] <= as_of]
    wf = weights(near["year"].values.astype(float), as_of)
    burned = near.intersection(ring).area.values / ring.area if len(near) else np.array([])
    years_since = float(as_of - near["year"].max()) if len(near) else np.nan
    d = dets[dets.within(ring) & (dets["year"] <= as_of)]
    det_w = float(weights(d["year"].values.astype(float), as_of).sum())
    per100 = ring.area / 1e8
    last_raw = float((wf * np.minimum(1.0, burned / LAST_SIZE_FULL)).max()) if len(near) else 0.0
    c_freq, c_burn, c_last, c_det, history = _scale(np.array([wf.sum() / per100]), np.array([(burned * wf).sum()]),
                                                    np.array([last_raw]), np.array([det_w / per100]))
    return {"fire_freq": float(c_freq[0]), "fire_reburn": float(c_burn[0]), "fire_last": float(c_last[0]),
            "fire_history": float(history[0]), "fire_detections": float(c_det[0]),
            "years_since_fire": None if np.isnan(years_since) else int(years_since),
            "fires_on_record": int(len(near)), "fires_weighted": round(float(wf.sum()), 2),
            "last_fire_name": (near.sort_values("year").iloc[-1]["name"] if len(near) else None),
            "last_fire_year": (int(near["year"].max()) if len(near) else None)}
