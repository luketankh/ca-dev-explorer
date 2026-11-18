#!/usr/bin/env bash
# Rebuild all map data: downloads sources, assigns building years, computes stats, builds PMTiles.
set -euo pipefail
cd "$(dirname "$0")/pipeline"
PY="../.venv/bin/python"
# out-of-order steps: 17_areas right after 01 (09, 13, 14 read it); 16_utilities and 14_flood before 13 (scored)
for step in 01_boundaries 17_areas 02_overture_buildings 03_ms_baseline 04_parcels \
            05_fire_perimeters 06_firms 07_fhsz 08_buildings_year 09_stats 10_tiles \
            11_insurance_crime 12_growth_arrows 16_utilities 14_flood 13_recommend 15_general_plans 18_check; do
  echo "== $step"
  "$PY" -u "$step.py"
done
