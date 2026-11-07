# CA Development Explorer (MVP)

A map explorer for real-estate developers that shows **how an area developed over time** and
**how exposed it is to wildfire**. Think of it as an Overture-style map with a time slider:

- **Buildings by year built.** Every building is coloured by its construction year and appears on
  the map in the year it was built.
- **Aerial imagery by year.** USDA NAIP imagery (2012–2022) follows the slider.
- **Where to build next, predicted each year.** Zones just ahead of the growth arrows, re-predicted for every
  slider year with only the data known then, plus what actually happened next.
- **Wildfire history.** Historical fire perimeters plus a NASA FIRMS satellite fire-detection heatmap.
- **Wildfire hazard.** CAL FIRE Fire Hazard Severity Zones.
- **Area report.** For each city: residential growth, homes built per year, wildfire exposure,
  and a transparent "up-and-coming" ranking.

MVP scope: **San Joaquin County** (Mountain House, Tracy, Lathrop, Manteca, Stockton, Lodi, …).
The fire layers cover all of California.

## Run it

You need **Node.js 20+** (and `curl` + `unzip`, which macOS and most Linux systems already have).

```bash
./fetch_data.sh   # downloads the pre-built map data (~85 MB) from the GitHub release "data-v5"
./dev.sh          # installs packages on first run, then serves http://localhost:5173
```

The map data lives in `web/public/data/` and is git-ignored. To rebuild it from the original
sources instead (Python 3.12+):

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./run_pipeline.sh   # ~15 min; downloads ~1 GB (mostly the Microsoft California footprints)
```

After a rebuild, publish new data for everyone by zipping the folder's contents as `map-data.zip`
and attaching it to a new release (e.g. `data-v6`). Others can then run `./fetch_data.sh data-v6`.

`dev.sh` also uses a project-local Node in `.tools/node` if one exists (git-ignored).

## How each building gets a year

Footprints come from **Overture Maps** (current release), which merges OpenStreetMap and
Microsoft ML buildings. Each building is then dated in this order:

| Priority | Source | Meaning | Share in San Joaquin |
|---|---|---|---|
| 1 | San Joaquin County Assessor parcels (`YEAR_BUILT`) | Exact year of the parcel's main structure | 90% |
| 2 | Not in Microsoft US Building Footprints v2 (imagery Apr 2020) | Built after ~2020, shown from 2021 | 2% |
| 3 | In the Microsoft 2020 footprints, no assessor year | Built before 2020, exact year unknown (grey) | 8% |

Caveats: the assessor year applies to every building on a parcel, so a newer garage or shed gets
the house's year. The last one or two years may be incomplete in assessor records.

## Data sources

| Layer | Source | Notes |
|---|---|---|
| Buildings | [Overture Maps](https://overturemaps.org) buildings, release `2026-10-21.0` | ODbL / CDLA. Overture keeps only its last ~3 releases online |
| Year built, farmland contracts | San Joaquin County parcels ([ArcGIS service](https://services2.arcgis.com/GQhSReJEO6f7tsvy/ArcGIS/rest/services/Parcels/FeatureServer)) | Only property fields are downloaded, including Williamson Act / Farmland Security Zone status. **Owner and mailing-address fields are not.** |
| 2020 snapshot | [Microsoft US Building Footprints v2](https://github.com/microsoft/USBuildingFootprints) | ODbL |
| Aerial imagery | USDA NAIP via [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/dataset/naip) | Loaded live in the browser, not stored |
| Fire perimeters | [CAL FIRE FRAP California Fire Perimeters (all)](https://data.ca.gov/dataset/california-fire-perimeters-all) through 2025, plus [NIFC WFIGS](https://data-nifc.opendata.arcgis.com/) perimeters for the current season | FRAP is the state's authoritative record (fires 10+ acres). NIFC's interagency *history* was dropped: it is complete only to ~2019 and missed the 2020 SCU Lightning Complex |
| Fire detections | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/download/) MODIS yearly country files, 2001–2025 | Vegetation fires only (type 0), confidence ≥ 30 |
| Hazard zones | CAL FIRE FHSZ, SRA (2024) + LRA (2025), via a public Sonoma County mirror | Confirm with [CAL FIRE OSFM](https://osfm.fire.ca.gov/) before relying on them |
| Elevation / slope | [USGS 3DEP](https://www.usgs.gov/3d-elevation-program) 1 arc-second DEM (model); [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (map shading) | Public domain (USGS). Slope classes: ≤ 15% buildable, 15–25% hillside, > 25% too steep |
| Home insurance | [HearthMap](https://hearthmap.app/home-insurance-by-county/california) county premiums (2024), from Keys & Mulder, NBER WP 32579 | CC BY 4.0, attribution required. Median escrowed premium for mortgaged owner-occupied homes; county level only; 57 of 58 counties |
| Crime | [CA DOJ OpenJustice](https://openjustice.doj.ca.gov/exploration/crime-statistics/crimes-clearances) Crimes & Clearances 1985–2025, by agency | Railroad police excluded. City rates only where the city has its own police department; otherwise the Sheriff's patrol-area rate |
| Population | [CA Dept. of Finance E-1](https://dof.ca.gov/forecasting/demographics/estimates-e1/) (Jan 1, 2025) | Denominator for crime rates (the Census API now requires a key) |
| Boundaries | Census TIGERweb (state, county, cities, CDPs) | |
| Basemap | [OpenFreeMap](https://openfreemap.org) Positron | Free, no API key |

## Scores (per city / CDP)

- **10-yr growth:** residential buildings built 2016–2025 ÷ residential buildings built up to 2015.
  **Growth score (0–100, fixed scale):** that growth as an average yearly rate, with 5% a year (about 63%
  over 10 years) or more scoring 100 and 2.5% a year scoring 50 (`GROWTH_FULL_RATE` in `09_stats.py`).
  Only places with ≥ 300 dated homes are scored. It used to be a percentile, which made 3.6% growth
  (Stockton) score 64 and put 53% (Lathrop) and 68% (Mountain House) only 5 points apart.
- **Wildfire risk (0–100, fixed scale):** 50 pts × share of the place in High/Very High FHSZ
  + 30 pts × **fire history** + 20 pts × **satellite detections**, measured in a 10 km ring
  (see [Fire history](#fire-history-frequency-and-recency) below). Detections outside any hazard zone
  are ignored, because on the valley floor they are mostly farm burning. A fixed scale (not a percentile)
  means a place with no nearby wildland fire scores 0, and scores stay comparable across counties.
- **Opportunity:** `growth_score × (1 − risk_score / 100)`: a place with fire risk 30 keeps 70% of its
  growth score. (It was `growth_score − 0.5 × risk_score`; with growth on a fixed scale, subtracting let
  fire risk swamp growth, tying Tracy at 12% growth with towns at 3–4%.)

These weights are a starting point for discussion, not a validated model. Insurance and crime are
shown as context in the report and statewide county map but are **not** part of the score yet.

## Fire history (frequency and recency)

`pipeline/fire_history.py` is shared by the city scores (10 km ring) and the recommendation model
(5 km ring around each cell). It uses **every fire on record** (10+ acres), and each fire's weight
halves every 10 years (`HALF_LIFE`): a fire last year ≈ 1, 10 years ago 0.5, 20 years ago 0.25.

| Part | Measures | Full marks at |
|---|---|---|
| Frequency | Age-weighted number of separate fires per 100 km² | 4 |
| Repeat burning | Age-weighted share of the ring burned. Land that burns twice counts twice | 25% |
| Recent big fire | Max over fires of age weight × size factor (share of ring burned ÷ 1%), so a large fire last year ≈ 1 and a small grass fire counts little | burned ≥ 1% of the ring last year |
| Satellite detections | Age-weighted wildland FIRMS detections per 100 km² | 25 |

`fire history` = mean of the first three parts; `fire risk = 0.5 × hazard zone + 0.3 × fire history +
0.2 × detections`. The recommendation backtest computes fire history *as of* each test year, so it never
sees fires that hadn't happened yet.

## Growth-direction arrows

For slider year *Y*, homes with an assessor year in the five years up to *Y* are grouped into
spatial clusters (DBSCAN, 350 m neighbourhood). Every cluster of 20+ new homes gets its own grey
arrow, so a city growing in several directions shows several arrows.

- The arrow's tip sits on the cluster's center. It points away from the center of the existing homes
  (built up to *Y − 5*) within 2 km, so it shows which way that subdivision is pushing out.
- Clusters inside existing development (shift < 150 m) are drawn as grey circles ("infill").
- Arrows are screen-sized icons rotated to the true bearing. Their size grows with the number of new
  homes. Clusters of 100+ homes show from county zoom; smaller ones appear when zoomed in.
- The report lists each growth area for the selected city (or the largest ones county-wide).

## Residential vs non-residential

Each building carries the county assessor's use category for its parcel. The sidebar filter shows
**All / Residential / Commercial & industrial / Other** (agricultural, public, institutional, no
parcel match). Growth scores, arrows and the recommendation use **residential** only. The report
also shows commercial & industrial growth in **square feet of footprint**, because one warehouse is
otherwise counted the same as one house.

Caveat: only ~47% of commercial/industrial buildings have an assessor year (vs 98% of homes), so
non-residential growth is undercounted. Agricultural parcels mostly include a farmhouse plus barns.

## Where to build next (`13_recommend.py`)

The county is cut into 500 m cells, and each gets

`score = 100 × growth momentum × open land × flat share × next to town × (1 − 0.8 × farmland contract) × (1 − fire risk)²`

The fire penalty is progressive (`FIRE_EXPONENT = 2` in `13_recommend.py`): a cell keeps 81% of its score at
10% fire risk, 56% at 25%, 25% at 50% and 0% at maximum risk. Raise the exponent to be harsher. History: the
factor was (1 − 0.8 × risk), briefly (1 − 0.4 × risk), then made progressive so fire counts for more.

| Factor | How it's measured |
|---|---|
| Growth momentum | Each cluster of homes built in the last 5 years (the growth arrows) projects a Gaussian 1.5 km ahead of itself along its growth direction (σ 1.2 km), weighted by √homes. Infill clusters project a round kernel |
| Open land | Building footprint < 6% of the cell = 1, 6–12% = 0.5, more = 0 |
| Flat share (terrain) | Share of the cell with slope ≤ 15%, plus half the share at 15–25% (hillside: costly grading). Land steeper than 25% doesn't count. Slope is computed at 25 m from USGS 3DEP 1 arc-second bare-earth elevation (`pipeline/terrain.py`) |
| Next to town | 1 within 1 km of a built-up cell (≥ 10% footprint), falling to 0 at 4 km |
| Farmland contract | Share of the cell under a Williamson Act or Farmland Security Zone contract (county assessor `WMACT_CATEGORY`), which blocks development while it runs: 9 years after a notice of non-renewal (19 for Farmland Security Zones). `CONTRACT_PENALTY = 0.8`. Each year counts only contracts signed by then (the contract number starts with the year: `71…` = 1971). A contract in non-renewal that ends within the next 5 years counts as *ending*: it isn't penalised, and the app reports it as a sign the owner is leaving the program |
| Fire risk | 0.5 × FHSZ at the cell (Moderate 0.4 / High 0.7 / Very High 1) + 0.3 × fire history within 5 km + 0.2 × age-weighted wildland detections within 5 km (see [Fire history](#fire-history-frequency-and-recency)) |
| Excluded | Delta Primary Zone ([DWR boundary](https://gis.water.ca.gov/arcgis/rest/services/Boundaries/i03_Delta_PrimarySecondary_Zones/FeatureServer/0); urban development restricted by the Delta Protection Act) cells > 40% water (Overture water), and cells too steep to build (< 20% of the land under 15% slope) |

Cells scoring ≥ 30 that touch each other are merged into zones, ranked by total score (top 10 shown).

**A prediction for every year.** (The earlier before/after swipe view was removed: it was buggy, and the
year slider plus the growth arrows show change over time more directly.) The model runs once per year from 2000 to 2025, each time using only what
was known that year: homes built, growth clusters and fires. The map and report show the prediction
for the slider year (2026 shows the latest, 2025). For past years the report adds **"What happened next"**:
the share of homes built in the following five years that landed inside that year's zones.

| Predicted in | Homes built next 5 yrs | In that year's zones | Zone area (share of county) |
|---|---|---|---|
| 2000 | 29,784 (2001–05) | 56% | 5.2% |
| 2005 | 11,121 (2006–10) | 35% | 4.7% |
| 2010 | 5,427 (2011–15) | 59% | 4.5% |
| 2015 | 11,397 (2016–20) | 42% | 2.7% |
| 2020 | 7,415 (2021–25) | 36% | 3.9% |

For complete five-year windows (predictions made 2000–2020), the zones cover 2–5% of the county and catch
32–61% of the homes built over the next five years. Windows after 2020 are still open and assessor
records lag, so the app labels those as early.

**Backtest.** Re-running the model with only the data available at the time, the top 5% of the
county it picked contained this share of the homes actually built in the following 5 years:

| As of | Predicts | Model | Edge-of-town rule (no direction) | Random |
|---|---|---|---|---|
| 2010 | 2011–15 | 62% | 44% | 5% |
| 2013 | 2014–18 | 50% | 37% | 5% |
| 2016 | 2017–21 | 57% | 37% | 5% |
| 2019 | 2020–24 | 44% | 32% | 5% |

The 2019 figure is the lowest because much of the 2020–24 building went into fire-prone Tracy Hills, which
the model deliberately avoids. It ranks where it's *safer* to build, not only where building will happen.

What the backtest can and can't see:

- **No look-ahead from undated buildings.** Buildings with no assessor year (8%, mostly rural) only count as
  standing from 2020 (`UNDATED_FROM`), when Microsoft's 2019–20 footprints confirm them. They used to count in
  every year, so past predictions saw buildings that may not have existed yet. Removing that look-ahead raised
  *both* the model and the edge-of-town rule (the rule by 7–9 points), so the model's lead over the rule is now
  12–19 points rather than 16–22.
- **Farmland contracts** are taken from today's parcel records. Contracts on land that has since been
  developed are gone from those records, so the backtest can't show the penalty being too harsh. Changing the
  penalty from 0 to 0.5, 0.8 and 1.0 raised the top-5% capture by 1–3 points in each test year; 0.8 was kept
  rather than 1.0, which won only in 2019.
- **Hazard zones (2024) and terrain** are today's maps, used for every year.

Previous figures, for reference: 56 / 48 / 52 / 40% (model) and 35 / 29 / 31 / 25% (edge-of-town rule),
before the undated-building fix and the farmland factor.

Not included yet: zoning/general plans and spheres of influence, sewer/water capacity, FEMA flood
zones and the 200-year floodplain (SB 5), land prices and ownership, and approved but unbuilt subdivisions. Treat zones as places to
investigate, not approvals.

## Project layout

See also `CLAUDE.md` (working notes for contributors and Claude Code) and `docs/CHAT_HISTORY.md`
(the full conversation in which the project was built).

```
pipeline/            Python data pipeline (run in order, or ./run_pipeline.sh)
  01_boundaries.py     Census state / county / places
  02_overture_buildings.py  Overture buildings via DuckDB (S3 GeoParquet)
  03_ms_baseline.py    Microsoft 2020 footprints (California, filtered to the AOI)
  04_parcels.py        County assessor parcels with YEAR_BUILT and Williamson Act contract status
  05_fire_perimeters.py, 06_firms.py, 07_fhsz.py   Fire layers (statewide)
  08_buildings_year.py Assigns a year to each building
  09_stats.py          Per-place metrics + scores -> web/public/data/{places.geojson,stats.json}
  10_tiles.py, tiler.py  Pure-Python vector tiler -> web/public/data/*.pmtiles
  11_insurance_crime.py  County insurance + crime (statewide), city crime rates -> counties.geojson, context.json
  12_growth_arrows.py    Growth-direction arrows per place and year -> growth_arrows.geojson
  13_recommend.py        Where-to-build-next model for every year 2000-2025 + backtest ->
                         recommend_cells.pmtiles, recommend_zones.geojson, recommend.json
web/                 React + MapLibre GL + PMTiles front end (Vite)
data/                Raw and intermediate files (git-ignored)
```

## Adding another county

1. Set `COUNTY_FIPS`, `AOI_NAME` and `AOI_BBOX` in `pipeline/common.py`.
2. Find that county's assessor parcel service with a year-built field and update `04_parcels.py`.
   Availability varies by county; Regrid and ReportAll sell this data statewide.
3. Run `./run_pipeline.sh`, then update `INITIAL_VIEW`, `DEFAULT_PLACE` and `NAIP_YEARS`
   in `web/src/config.ts`.

## Known limitations / next steps

- Single county. Statewide coverage needs parcel data for each county (or a paid provider).
- Additional useful layers: FEMA flood zones, zoning/general plans, home prices (Zillow ZHVI),
  Census building permits, and VIIRS (375 m) fire detections alongside MODIS.
- Building detection on each NAIP year would give "first seen" dates where assessor data is missing.
