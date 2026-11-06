#!/usr/bin/env bash
# Rebuild all map data: downloads sources, assigns building years, computes stats, builds PMTiles.
set -euo pipefail
cd "$(dirname "$0")/pipeline"
PY="../.venv/bin/python"
for step in 01_boundaries 02_overture_buildings 03_ms_baseline 04_parcels \
            05_fire_perimeters 06_firms 07_fhsz 08_buildings_year 09_stats 10_tiles \
            11_insurance_crime 12_growth_arrows 13_recommend; do
  echo "== $step"
  "$PY" -u "$step.py"
done
