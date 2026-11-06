# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo. Read `README.md` for the full
methodology and data sources. `docs/CHAT_HISTORY.md` is the original build conversation; use it to
understand *why* a decision was made, but trust the code where they disagree.

## What this is

A map explorer that helps residential developers decide where to build next in **San Joaquin
County, CA** (the MVP area; fire, insurance and crime layers already cover all of California).
It shows how areas developed over time (buildings dated by year built, NAIP imagery 2012–2022), which
way growth is heading (arrows per cluster of new homes), wildfire exposure, insurance and crime
context, and a ranked "where to build next" recommendation with a backtest.

## Layout

- `pipeline/`: Python data pipeline, numbered steps run in order by `./run_pipeline.sh`.
  Shared config (AOI, paths, Overture release, ArcGIS paging helper) is in `pipeline/common.py`.
  - 01 boundaries · 02 Overture buildings · 03 Microsoft 2020 footprints · 04 assessor parcels
  - 05–07 fire perimeters / FIRMS / hazard zones · 08 assigns a year to each building
  - 09 per-place stats + scores · 10 PMTiles (`tiler.py`) · 11 insurance + crime
  - 12 growth arrows · 13 where-to-build-next model + backtest (terrain from `terrain.py`)
- `web/`: Vite + React + TypeScript + MapLibre GL + PMTiles. `src/App.tsx` (map, sidebar, popups),
  `src/layers.ts` (all map layers, filters, colours), `src/components/Report.tsx` (right panel),
  `src/config.ts` (years, data URLs, colour ramps), `src/types.ts` (data shapes).
- `data/` (git-ignored): raw downloads and intermediate files.
- `web/public/data/` (git-ignored): what the app loads. Get it with `./fetch_data.sh`
  (GitHub release `data-v3`) or rebuild with `./run_pipeline.sh`.

## Commands

```bash
./fetch_data.sh                       # download pre-built map data from the GitHub release
./dev.sh                              # dev server at http://localhost:5173
cd web && npx tsc --noEmit            # type-check (run after every frontend change)
cd web && npm run build               # production build (also checks the MapLibre worker bundles)
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./run_pipeline.sh                     # full rebuild, ~15 min, ~1 GB download
cd pipeline && ../.venv/bin/python 13_recommend.py   # re-run a single step
```

There is no test suite yet. Verify changes by type-checking, building, and opening the app.

## Key decisions (don't undo without a reason)

- **Year built** comes from the San Joaquin assessor `YEAR_BUILT` (90% of buildings). Buildings
  without one are "new" (absent from Microsoft's Apr 2020 footprints → shown from 2021) or "unknown"
  (pre-2020, grey, `y = 0`). Microsoft's footprints are a single 2019–20 snapshot and the Global ML
  release has no dates, so they **cannot** give yearly build dates. Statewide yearly dating needs
  county parcel data (free per county, or paid: Regrid/ReportAll).
- **Privacy:** parcel downloads request property fields only, never owner/mailing fields. Keep it so.
- **Residential vs non-residential** uses the parcel's assessor `category`. Growth scores, arrows and
  the recommendation are residential-only. Commercial & industrial growth is measured in footprint
  sq ft, and only ~47% of C&I buildings have a year, so it is undercounted.
- **Wildfire risk is on a fixed 0–100 scale**, not percentiles. Percentiles made quiet valley towns
  look risky (the "Linden" bug). FIRMS detections only count inside FHSZ hazard zones, because
  outside them they are mostly agricultural burning.
- **Growth arrows** = DBSCAN clusters (350 m) of homes built in the last 5 years, pointing away from
  existing homes within 2 km. Infill (< 150 m shift) is drawn as a circle. Arrows are screen-sized icons.
- **Terrain** (`terrain.py`): USGS 3DEP 1 arc-second tiles, cached in `data/raw/dem/`, slope at 25 m on a grid
  aligned to the 500 m cells. ≤ 15% buildable, 15–25% counts half, > 25% not buildable; cells with < 20% flat
  land are excluded. In San Joaquin this mostly removes the SW (Corral Hollow / Altamont) and eastern foothills.
- **Recommendation** (`13_recommend.py`): 500 m cells, score = 100 × momentum × open land × flat share × next to
  town × (1 − fire risk)^`FIRE_EXPONENT` (= 2, progressive; history: 1 − 0.8·risk, then 1 − 0.4·risk). The Delta Primary Zone and water are excluded. Backtest: the top 5%
  of cells captured 42–56% of the next 5 years' homes (vs 25–35% for an edge-of-town rule). If you change
  the model, re-run the backtest and update the README table.
- **Insurance** (HearthMap/NBER, CC BY 4.0, attribution required) is county-level only. **Crime**
  (CA DOJ) is per police agency; Sheriff-patrolled places (incl. Mountain House) share the Sheriff's rate.
  Railroad police are excluded. Neither is in the opportunity score yet.

## Gotchas

- **DuckDB 2.0:** `con.sql(...).fetchone()` no longer exists; use `con.execute(...).fetchall()`.
- **MapLibre 6 + Vite:** the worker must be bundled via
  `import url from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"` + `setWorkerUrl(url)`, with
  `optimizeDeps.exclude: ["maplibre-gl"]` and `worker.format: "es"`. Otherwise you get a blank map
  in dev or a missing worker in production.
- **Map layer changes need a full page reload**; hot reload does not re-run `addDataLayers`.
- The FHSZ data contains `NonWildland` polygons. Always filter to Moderate/High/Very High.
- **Tiles** are built by the pure-Python `pipeline/tiler.py` (tippecanoe wasn't available). It
  handles county-sized data; for statewide data, switch to tippecanoe.
- **ArcGIS sources** page at 1,000–2,000 records; use `arcgis_query()` in `common.py`. CAL FIRE's own
  FRAP service needs a token, so fire perimeters come from NIFC instead.
- **Census API now requires a key**, so populations come from CA DOF E-1 (`11_insurance_crime.py`).
  DOF county rows are detected by matching the county total, because San Francisco has no
  "Unincorporated" row.
- **Overture only keeps ~3 releases online.** `OVERTURE_RELEASE` in `common.py` will go stale; update
  it to a current release before re-running step 02.
- **Assessor years lag:** the latest 1–2 years are incomplete, and there are a few 2026 records. The
  slider runs to 2026 but opens on 2025.

## Working conventions

- Keep the UI copy plain and specific, and state data caveats in the app where users see the number.
- Colours: blue ramp = building age / growth, orange = fire history, magenta = hazard zones,
  purple = county comparison, aqua/green = recommendation, orange `#eb6834` = "built this year".
- New data sources: add a numbered pipeline step, cache raw downloads in `data/raw/`, list the
  source and licence in the README table, and add the step to `run_pipeline.sh`.
- After rebuilding data, publish it as a new GitHub release (`map-data.zip` with the contents of
  `web/public/data/`), then bump the default tag in `fetch_data.sh`.
