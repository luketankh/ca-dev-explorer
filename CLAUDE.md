# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo. Read `README.md` for the full
methodology and data sources. `docs/CHAT_HISTORY.md` is the original build conversation; use it to
understand *why* a decision was made, but trust the code where they disagree.

**Open review items.** The final review (turn 27 of `docs/CHAT_HISTORY.md`) lists ranked recommendations.
Done since: Williamson Act farmland, growth on a fixed scale (plus a multiplicative opportunity score), and no
backtest look-ahead from undated buildings, utilities in the score (16_utilities.py). Flood zones are now shown
(14_flood.py) but not scored. Still open, highest first: scoring flood risk
(FEMA / 200-year floodplain), then medium items 5–9 and low items 10–15.

## What this is

A map explorer that helps residential developers decide where to build next in **San Joaquin
County, CA** (the MVP area; the fire layers already cover all of California).
It shows how areas developed over time (buildings dated by year built), which way growth is heading
(arrows per cluster of new homes), wildfire and flood exposure, general plan land use, and a ranked
"where to build next" recommendation with a backtest.

**Keep the UI uncluttered** (the team's explicit request): the map opens with only buildings, arrows and the
build-next layer on; legend entries and layer-specific controls (building colours, fire-history window) show only
while their layer is on; the right-hand report is closed until the user clicks **Where to build next** (bottom
right). The statewide insurance/crime county layer and report section, the steep-ground overlay, the terrain
toggle (shading is always on) and the fire-detection heatmap were removed on purpose. Aerial imagery is back as a
static "Aerial" toggle (latest USGS/NAIP only; the old per-year NAIP via Planetary Computer is gone).

## Layout

- `pipeline/`: Python data pipeline, numbered steps run in order by `./run_pipeline.sh`.
  Shared config (AOI, paths, Overture release, ArcGIS paging helper) is in `pipeline/common.py`.
  - 01 boundaries · 02 Overture buildings · 03 Microsoft 2020 footprints · 04 assessor parcels
  - 05–07 fire perimeters / FIRMS / hazard zones · 08 assigns a year to each building
  - 09 per-place stats + scores · 10 PMTiles (`tiler.py`) · 11 insurance + crime (data only; not shown in the app)
  - 12 growth arrows · 13 where-to-build-next model + backtest (terrain from `terrain.py`)
  - 14 flood zones (FEMA NFHL + DWR 200-year floodplain): map layer and flood_* shares on places, county and
    zones. Context only; the score does not use flood yet. Re-run after 09 or 13.
  - 15 general plan land use: copies `reference/general_plans/general_plans_san_joaquin.geojson` (lightly
    simplified) to `general_plans.geojson` for the map layer. No download. Context only; not scored.
  - 16 utilities (power lines, gas pipelines, water + sewer service areas); runs before 13, which scores with it
  - 17 areas (Census county subdivisions + rural remainders); runs right after 01. Order is in `run_pipeline.sh`
- `web/`: Vite + React + TypeScript + MapLibre GL + PMTiles. `src/App.tsx` (map, sidebar, popups),
  `src/layers.ts` (all map layers, filters, colours), `src/components/Report.tsx` (right panel analysis), `src/components/Regions.tsx` (county › area › town list),
  `src/config.ts` (years, data URLs, colour ramps), `src/types.ts` (data shapes).
- `data/` (git-ignored): raw downloads and intermediate files.
- `web/public/data/` (git-ignored): what the app loads. Get it with `./fetch_data.sh`
  (GitHub release `data-v8`) or rebuild with `./run_pipeline.sh`.

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
- **Fire history accounts for frequency and recency** (`fire_history.py`): all fires on record (10+ acres), each
  weighted 0.5^(age/10). Parts: frequency, repeat burning, recent *big* fire (size-aware), plus age-weighted
  FIRMS detections. Backtests compute it as of the test year (no future fires).
- **City scores are on fixed scales, not percentiles.** Growth: average yearly rate of the 10-yr growth, 5%/yr
  = 100 (`GROWTH_FULL_RATE`). Opportunity = growth × (1 − risk/100); subtracting 0.5 × risk let fire swamp
  the fixed-scale growth score.
- **Wildfire risk is on a fixed 0–100 scale**, not percentiles. Percentiles made quiet valley towns
  look risky (the "Linden" bug). FIRMS detections only count inside FHSZ hazard zones, because
  outside them they are mostly agricultural burning.
- **Growth arrows** = DBSCAN clusters (350 m) of homes built in the last 5 years, pointing away from
  existing homes within 2 km. Infill (< 150 m shift) is drawn as a circle. Arrows are screen-sized icons.
- **Terrain** (`terrain.py`): USGS 3DEP 1 arc-second tiles, cached in `data/raw/dem/`, slope at 25 m on a grid
  aligned to the 500 m cells. ≤ 15% buildable, 15–25% counts half, > 25% not buildable; cells with < 20% flat
  land are excluded. In San Joaquin this mostly removes the SW (Corral Hollow / Altamont) and eastern foothills.
- **Recommendation** (`13_recommend.py`) runs **once per year 2000–2025**, each with only that year's data
  (`score(year)`, fire history `as_of` that year). The app filters cells, zones and labels by `year` and shows
  "what happened next" from `recommend.json` → `by_year`. 500 m cells, score = 100 × momentum × open land × flat share × next to
  town × (1 − `CONTRACT_PENALTY` × farmland contract) × water & sewer × usable land × land use
  × (1 − fire risk)^`FIRE_EXPONENT` (= 2, progressive;
  history: 1 − 0.8·risk, then 1 − 0.4·risk). The Delta Primary Zone and water are excluded. Backtest: the top 5%
  of cells captured 48–62% of the next 5 years' homes (26–40% for an edge-of-town rule). Each zone carries
  `factors` (0–100 per factor), shown as a strip in the Analysis table.
- **Land use / usable land:** general plan *Industrial* loses `PLAN_PENALTY["industrial"] = 0.8` (commercial, open
  space and ag aren't penalised: that cost 2–8 backtest points). Usable land = 1 − share in power/gas easements,
  water, or a 30 m canal/Aqueduct right-of-way. C&I footprints count 3× (`CI_COVERAGE`) toward "built". Env vars
  (`IND_PENALTY`, `OPEN_PENALTY`, `COMM_PENALTY`, `AG_PENALTY`, `CI_COVERAGE`, `CANAL_SETBACK_M`) override them
  for backtest experiments.
  If you change the model, re-run the backtest and update the README table. Besides the county top 10, every
  region (town + 1.5 km, area, rural remainder) gets its own top 5 (`by_year[y].regional`,
  `recommend_region_zones.geojson`), each with its `county_rank` if it overlaps a county zone.
- **Utilities** (`16_utilities.py`, runs before 13): CEC power lines (60 kV+) and EIA gas transmission pipelines are
  buffered into easements (15–75 m by voltage, 25 m gas) that count as unbuildable; water (State Water Board
  community systems) and sewer (city limits + county sewer districts) give `service` 0–1 (1 within 500 m, 0 at
  3 km). Water & sewer factor = 0.5 + 0.5 × service; easements are in "usable land". Service areas are today's
  boundaries, so the backtest carries some look-ahead; backtest rows also report `no_utilities_pct` (no water/sewer).
  Don't request SABL contact fields.
- **Regions** (`17_areas.py`, runs right after 01): the 9 Census county subdivisions tile the county; each is split
  into its towns (cities and CDPs, which never overlap each other) and "Rural <area>". An area's polygon is its
  rural land + its towns *whole* (assigned by interior point), because CCD lines cut through Lathrop and Manteca;
  using raw CCD polygons made towns + rural ≠ area. `18_check.py` (last pipeline step) fails the build if any
  count doesn't add up; run it after changing stats, areas or the model. C&I sq ft is rounded per building. `09_stats.py` computes the
  same metrics for areas (`areas.geojson`, kinds `Area` / `Rural`, not ranked); towns carry their `area` GEOID.
- **Buildings at every zoom:** footprints (`buildings.pmtiles`) start at z12; below that, `buildings_low.pmtiles`
  (z8–11) has one dot per few-pixel cell per year and type (`n` = count), using the same filter and colours.
- **Farmland contracts** (Williamson Act / Farmland Security Zone) come from the assessor parcels
  (`WMACT_CATEGORY` 1/4 = in force, 3/5 = non-renewal). `CONTRACT_PENALTY = 0.8`. Signing year = first two digits
  of the contract number (verified: starts 1965, FSZ bump ~1998; blank or future-looking numbers = always in force).
  Non-renewal contracts ending within `WINDOW` years count as "ending" (no penalty). Today's records omit
  contracts that already ended, so past years under-count contracts and the backtest can't show the penalty
  being too harsh.
- **Undated buildings** (no assessor year, in Microsoft's 2019–20 footprints) only exist from `UNDATED_FROM =
  2020` in the model. Counting them in every year was look-ahead.
- **Insurance** (HearthMap/NBER, CC BY 4.0, attribution required) is county-level only. **Crime**
  (CA DOJ) is per police agency; Sheriff-patrolled places (incl. Mountain House) share the Sheriff's rate.
  Railroad police are excluded. Neither is in the opportunity score, and the app no longer shows them.

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
  `egis` FRAP service needs a token; use the public ArcGIS Online copy (`services1.arcgis.com/jUJYIo9tSA7EHvfZ/
  .../California_Historic_Fire_Perimeters`). NIFC's InterAgency *history* is incomplete after ~2019, so don't use it.
- **Census API now requires a key**, so populations come from CA DOF E-1 (`11_insurance_crime.py`).
  DOF county rows are detected by matching the county total, because San Francisco has no
  "Unincorporated" row.
- **Overture only keeps ~3 releases online.** `OVERTURE_RELEASE` in `common.py` will go stale; update
  it to a current release before re-running step 02.
- **Assessor years lag:** 2023 onwards is badly incomplete (2016–25 is 33% below DOF single-family units added,
  while 2016–22 is only 5% below; `scripts/verify_counts.py [END_YEAR]` reproduces this), and there are a few 2026 records. The
  slider runs to 2026 but opens on 2025.

## Working conventions

- Keep the UI copy plain and specific, and state data caveats in the app where users see the number.
- Colours: buildings are hue = type, lightness = age (blue = residential, amber = commercial & industrial,
  grey = other; red `#e34948` = built in the slider year; validated colour-blind safe). Blue also = city growth,
  orange = fire history, magenta = hazard zones, cyan = flood zones, aqua/green = recommendation,
  yellow ramp = planned housing by density, red = planned commercial, violet = planned industrial,
  pale green = planned agriculture (general plan layer, off by default). The old "Buildings shown" filter was replaced by this colour coding.
- The before/after swipe-compare view was removed on purpose (buggy; the slider + arrows cover it).
  Predictions should follow the arrows: zones are built from the same clusters, projected 1.5 km ahead
  along each arrow. On average 86% of zone score lies within 60° ahead of the nearest arrow.
- New data sources: add a numbered pipeline step, cache raw downloads in `data/raw/`, list the
  source and licence in the README table, and add the step to `run_pipeline.sh`.
- After rebuilding data, publish it as a new GitHub release (`map-data.zip` with the contents of
  `web/public/data/`), then bump the default tag in `fetch_data.sh`.
