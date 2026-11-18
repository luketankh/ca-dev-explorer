# Project Marco Polo (MVP)

A map explorer for real-estate developers that shows **how an area developed over time** and
**how exposed it is to wildfire**. Think of it as an Overture-style map with a time slider:

- **Buildings by year built.** Every building is coloured by its construction year and appears on
  the map in the year it was built.
- **Where to build next, predicted each year.** Zones just ahead of the growth arrows, re-predicted for every
  slider year with only the data known then, plus what actually happened next.
- **Wildfire history.** Historical fire perimeters on the map; NASA FIRMS satellite fire detections feed the fire-risk score and reports.
- **Wildfire hazard.** CAL FIRE Fire Hazard Severity Zones.
- **Flood zones and planned land use.** FEMA / DWR flood zones and city & county general plans (context only).
- **Utilities.** Power lines and gas pipelines (their easements count against a site) and water and sewer
  service areas (sites close to both score higher).
- **Regions.** The county split into 9 areas (Census county divisions) that cover all of it, each holding its
  cities, communities and rural land. Pick any of them to zoom there and see its own ranked zones.
- **Area report.** For each city: residential growth, homes built per year, wildfire exposure,
  and a transparent "up-and-coming" ranking.

The map opens uncluttered: only buildings, growth arrows and the build-next prediction are on; every other
layer is opt-in, and the legend lists only the layers that are on. The recommendations and area report open from
the **Where to build next** button at the bottom right.

MVP scope: **San Joaquin County** (Mountain House, Tracy, Lathrop, Manteca, Stockton, Lodi, …).
The fire layers cover all of California.

## Run it

You need **Node.js 20+** (and `curl` + `unzip`, which macOS and most Linux systems already have).

```bash
./fetch_data.sh   # downloads the pre-built map data (~95 MB) from the GitHub release "data-v8"
./dev.sh          # installs packages on first run, then serves http://localhost:5173
```

The map data lives in `web/public/data/` and is git-ignored. To rebuild it from the original
sources instead (Python 3.12+):

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./run_pipeline.sh   # ~15 min; downloads ~1 GB (mostly the Microsoft California footprints)
```

Flood data alone (already in `data-v8`): `cd pipeline && ../.venv/bin/python 14_flood.py` (about a minute;
downloads ~15 MB from FEMA and DWR). Re-run it after `09_stats.py` or `13_recommend.py`.

General plan layer alone: `cd pipeline && ../.venv/bin/python 15_general_plans.py` (a few seconds, no download;
reads `reference/general_plans/`).

After a rebuild, publish new data for everyone by zipping the folder's contents as `map-data.zip`
and attaching it to a new release (e.g. `data-v9`). Others can then run `./fetch_data.sh data-v9`.

`dev.sh` also uses a project-local Node in `.tools/node` if one exists (git-ignored).

## How each building gets a year

Footprints come from **Overture Maps** (current release), which merges OpenStreetMap and
Microsoft ML buildings. Each building is then dated in this order:

| Priority | Source | Meaning | Share in San Joaquin |
|---|---|---|---|
| 1 | San Joaquin County Assessor parcels (`YEAR_BUILT`) | Exact year of the parcel's main structure | 90% |
| 2 | Not in Microsoft US Building Footprints v2 (imagery Apr 2020) | Built after ~2020, shown from 2021 | 2% |
| 3 | In the Microsoft 2020 footprints, no assessor year | Built before 2020, exact year unknown (grey) | 8% |

**Checked against official figures** (`scripts/verify_counts.py`, California Department of Finance E-8 / E-5
housing estimates; compare with single-family units, since we count buildings, not apartments):

| Homes built 2016–2022 | Ours | DOF single-family units added | Difference |
|---|---|---|---|
| San Joaquin County | 17,847 | 18,818 | −5% |
| Lathrop | 3,129 | 3,705 | −16% |
| Lodi | 1,445 | 1,305 | +11% |
| Manteca | 4,091 | 4,238 | −3% |
| Ripon | 324 | 327 | −1% |
| Stockton | 2,468 | 2,738 | −10% |
| Tracy | 2,651 | 2,774 | −4% |

Through 2025 the gap widens to −33% county-wide: assessor records for 2023–2025 are far from complete (965
homes recorded vs ~9,000 units the state counts). Recent growth figures read low. Our 2015 stock is ~12% above
DOF's single-family count, because garages and second units on residential parcels count as buildings.
Mountain House only became a city in 2024, so DOF has no comparable city series.

Caveats: the assessor year applies to every building on a parcel, so a newer garage or shed gets
the house's year. The last one or two years may be incomplete in assessor records.

## Data sources

| Layer | Source | Notes |
|---|---|---|
| Buildings | [Overture Maps](https://overturemaps.org) buildings, release `2026-10-21.0` | ODbL / CDLA. Overture keeps only its last ~3 releases online |
| Year built, farmland contracts | San Joaquin County parcels ([ArcGIS service](https://services2.arcgis.com/GQhSReJEO6f7tsvy/ArcGIS/rest/services/Parcels/FeatureServer)) | Only property fields are downloaded, including Williamson Act / Farmland Security Zone status. **Owner and mailing-address fields are not.** |
| 2020 snapshot | [Microsoft US Building Footprints v2](https://github.com/microsoft/USBuildingFootprints) | ODbL |
| Fire perimeters | [CAL FIRE FRAP California Fire Perimeters (all)](https://data.ca.gov/dataset/california-fire-perimeters-all) through 2025, plus [NIFC WFIGS](https://data-nifc.opendata.arcgis.com/) perimeters for the current season | FRAP is the state's authoritative record (fires 10+ acres). NIFC's interagency *history* was dropped: it is complete only to ~2019 and missed the 2020 SCU Lightning Complex |
| Fire detections | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/download/) MODIS yearly country files, 2001–2025 | Vegetation fires only (type 0), confidence ≥ 30 |
| Flood zones | [FEMA National Flood Hazard Layer](https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28), San Joaquin County map 06077C (effective 2009–2016) | Public domain. Floodway, 100-year (A/AE/AH/AO), 500-year and levee-protected areas. Shown for context; not in the score |
| 200-year floodplain | DWR [Best Available Maps](https://ferix.water.ca.gov/arcgis/rest/services/other/BAM/MapServer/11) (SB 5), USACE Sacramento–San Joaquin Comprehensive Study | Coarse, valley-wide study; use as a flag. California requires 200-year protection for new urban development in the Central Valley |
| General plan land use | California Resources Agency / UC Davis ICE general plans ("rural residential" variant), via [Data Basin](https://databasin.org/datasets/1cda3056a4ad4ece86eb5eda4ef17e82/); see `reference/general_plans/README.md` | Free to use; credit the Resources Agency. Plans of c. 2004–2014, not current zoning. Shown for context; not in the score |
| Hazard zones | CAL FIRE FHSZ, SRA (2024) + LRA (2025), via a public Sonoma County mirror | Confirm with [CAL FIRE OSFM](https://osfm.fire.ca.gov/) before relying on them |
| Elevation / slope | [USGS 3DEP](https://www.usgs.gov/3d-elevation-program) 1 arc-second DEM (model); [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (map shading) | Public domain (USGS). Slope classes: ≤ 15% buildable, 15–25% hillside, > 25% too steep. Used in the model; no longer drawn as a map layer |
| Home insurance | [HearthMap](https://hearthmap.app/home-insurance-by-county/california) county premiums (2024), from Keys & Mulder, NBER WP 32579 | CC BY 4.0, attribution required. Median escrowed premium for mortgaged owner-occupied homes; county level only; 57 of 58 counties. **Still built by step 11, but no longer shown in the app** |
| Crime | [CA DOJ OpenJustice](https://openjustice.doj.ca.gov/exploration/crime-statistics/crimes-clearances) Crimes & Clearances 1985–2025, by agency | Railroad police excluded. City rates only where the city has its own police department; otherwise the Sheriff's patrol-area rate. **Still built by step 11, but no longer shown in the app** |
| Population | [CA Dept. of Finance E-1](https://dof.ca.gov/forecasting/demographics/estimates-e1/) (Jan 1, 2025) | Denominator for crime rates (the Census API now requires a key) |
| Boundaries | Census TIGERweb (state, county, cities, CDPs, county subdivisions) | Public domain. The 9 county subdivisions (CCDs) tile the county; `17_areas.py` splits each into its towns and rural land |
| Power lines | [California Energy Commission, California Electric Transmission Lines](https://services3.arcgis.com/bWPjFyq029ChCGur/arcgis/rest/services/Transmission_Line/FeatureServer/2) | Free to use with attribution ([CEC conditions of use](https://www.energy.ca.gov/conditions-of-use)). 60 kV and up; local distribution lines aren't public |
| Gas pipelines | [U.S. EIA, Natural Gas Interstate and Intrastate Pipelines](https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Natural_Gas_Interstate_and_Intrastate_Pipelines_1/FeatureServer/0) | Public domain. Transmission pipelines only (PG&E's California Gas Transmission in this county) |
| Water service | [State Water Board, California Drinking Water System Area Boundaries](https://gispublic.waterboards.ca.gov/portalserver/rest/services/Drinking_Water/California_Drinking_Water_System_Area_Boundaries/FeatureServer/0) | Public. Community water systems only. Contact fields (phone, email, address) are not downloaded |
| Sewer service | City limits (Census) + [San Joaquin County Public Works sewer districts](https://services2.arcgis.com/GQhSReJEO6f7tsvy/arcgis/rest/services/SewerDistricts/FeatureServer/0) | Public. Cities run their own sewer; the county runs 9 small districts for unincorporated subdivisions |
| Basemap | [OpenFreeMap](https://openfreemap.org) Positron | Free, no API key |
| Aerial photo | USDA NAIP via [USGS The National Map, USGS Imagery Only](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer) | Public domain, no key. Latest vintage only (refreshed 2024); doesn't follow the year slider. Off by default |

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

These weights are a starting point for discussion, not a validated model. Insurance and crime are not part
of the score, and the app no longer shows them (removed to declutter; `11_insurance_crime.py` still builds the data).

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

`score = 100 × growth momentum × open land × flat share × next to town × (1 − 0.8 × farmland contract) × water & sewer × usable land × land use × (1 − fire risk)²`

Each zone in the app lists these factors as 0–100 sub-scores (100 = no penalty), so you can see which factor
separates two zones.

The fire penalty is progressive (`FIRE_EXPONENT = 2` in `13_recommend.py`): a cell keeps 81% of its score at
10% fire risk, 56% at 25%, 25% at 50% and 0% at maximum risk. Raise the exponent to be harsher. History: the
factor was (1 − 0.8 × risk), briefly (1 − 0.4 × risk), then made progressive so fire counts for more.

| Factor | How it's measured |
|---|---|
| Growth momentum | Each cluster of homes built in the last 5 years (the growth arrows) projects a Gaussian 1.5 km ahead of itself along its growth direction (σ 1.2 km), weighted by √homes. Infill clusters project a round kernel |
| Open land | Building footprint < 6% of the cell = 1, 6–12% = 0.5, more = 0. Commercial and industrial buildings count at 3× their roof area (`CI_COVERAGE`), for parking and yards |
| Flat share (terrain) | Share of the cell with slope ≤ 15%, plus half the share at 15–25% (hillside: costly grading). Land steeper than 25% doesn't count. Slope is computed at 25 m from USGS 3DEP 1 arc-second bare-earth elevation (`pipeline/terrain.py`) |
| Next to town | 1 within 1 km of a built-up cell (≥ 10% footprint), falling to 0 at 4 km |
| Farmland contract | Share of the cell under a Williamson Act or Farmland Security Zone contract (county assessor `WMACT_CATEGORY`), which blocks development while it runs: 9 years after a notice of non-renewal (19 for Farmland Security Zones). `CONTRACT_PENALTY = 0.8`. Each year counts only contracts signed by then (the contract number starts with the year: `71…` = 1971). A contract in non-renewal that ends within the next 5 years counts as *ending*: it isn't penalised, and the app reports it as a sign the owner is leaving the program |
| Water & sewer | `0.5 + 0.5 × service` (`16_utilities.py`, `SERVICE_FLOOR = 0.5`). Service = average of water and sewer access, each 1 inside or within 500 m of a community water system / sewer service area, falling to 0 at 3 km. A cell far from both keeps half its score |
| Usable land | `1 − share of the cell lost` to power-line and gas-pipeline easements or setbacks (15 m either side of 60–69 kV lines, 25 m for 115 kV, 40 m for 230 kV, 75 m for 500 kV, 25 m for gas transmission), water, and a 30 m right-of-way along canals and the California Aqueduct (`CANAL_SETBACK_M`) |
| Land use | `1 − 0.8 × share planned Industrial` in the general plans (c. 2004–2014, `PLAN_PENALTY`). Commercial, open space and agricultural designations aren't penalised: penalising them too lowered the backtest, because much housing has been built on land those plans called something else |
| Fire risk | 0.5 × FHSZ at the cell (Moderate 0.4 / High 0.7 / Very High 1) + 0.3 × fire history within 5 km + 0.2 × age-weighted wildland detections within 5 km (see [Fire history](#fire-history-frequency-and-recency)) |
| Excluded | Delta Primary Zone ([DWR boundary](https://gis.water.ca.gov/arcgis/rest/services/Boundaries/i03_Delta_PrimarySecondary_Zones/FeatureServer/0); urban development restricted by the Delta Protection Act) cells > 40% water (Overture water), and cells too steep to build (< 20% of the land under 15% slope) |

Cells scoring ≥ 30 that touch each other are merged into zones, ranked by total score (top 10 shown).
Every region also gets its **own ranking** (top 5): cells inside each town (plus 1.5 km around it, where towns
grow) or inside each area or rural remainder, merged into zones with a local threshold (half the region's best
cell score, at most 30, at least 5), so places like Mountain House get a list even when nothing there makes the
county top 10. Each local zone shows its county rank where it overlaps a county zone.

**A prediction for every year.** (The earlier before/after swipe view was removed: it was buggy, and the
year slider plus the growth arrows show change over time more directly.) The model runs once per year from 2000 to 2025, each time using only what
was known that year: homes built, growth clusters and fires. The map and report show the prediction
for the slider year (2026 shows the latest, 2025). For past years the report adds **"What happened next"**:
the share of homes built in the following five years that landed inside that year's zones.

| Predicted in | Homes built next 5 yrs | In that year's zones | Zone area (share of county) |
|---|---|---|---|
| 2000 | 29,784 (2001–05) | 52% | 3.9% |
| 2005 | 11,121 (2006–10) | 29% | 3.5% |
| 2010 | 5,427 (2011–15) | 53% | 3.5% |
| 2015 | 11,397 (2016–20) | 41% | 2.3% |
| 2020 | 7,415 (2021–25) | 33% | 3.2% |

For complete five-year windows (predictions made 2000–2020), the zones cover 2–4% of the county and catch
27–56% of the homes built over the next five years. Windows after 2020 are still open and assessor
records lag, so the app labels those as early.

**Backtest.** Re-running the model with only the data available at the time, the top 5% of the
county it picked contained this share of the homes actually built in the following 5 years:

| As of | Predicts | Model | Without water & sewer | Edge-of-town rule (no direction) | Random |
|---|---|---|---|---|---|
| 2010 | 2011–15 | 62% | 62% | 40% | 5% |
| 2013 | 2014–18 | 50% | 50% | 29% | 5% |
| 2016 | 2017–21 | 57% | 56% | 30% | 5% |
| 2019 | 2020–24 | 48% | 46% | 26% | 5% |

History of this table: 62 / 50 / 57 / 44% before utilities; 66 / 50 / 57 / 46% with utilities; now
62 / 50 / 57 / 48% after the land-use fix (industrial land, warehouse lots and canals). That fix removed zones on
industrial land (e.g. beside the Aqueduct south of Mountain House) at the cost of 4 points in 2010 and a gain of
2 in 2019. Penalising commercial and open-space designations as well cost 2–8 points, so they aren't penalised.
The water/sewer gain carries some look-ahead: service-area boundaries are today's and have grown into
subdivisions built since. The edge-of-town rule dropped because warehouse lots now count as built land.

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
- **Water and sewer service areas and power/gas lines** are today's maps too (see above).

Previous figures, for reference: 56 / 48 / 52 / 40% (model) and 35 / 29 / 31 / 25% (edge-of-town rule),
before the undated-building fix and the farmland factor.

Flood risk is shown but not scored: `14_flood.py` adds each zone's share of land in the FEMA 100-year floodplain,
floodway, levee-protected areas and the DWR 200-year floodplain (SB 5), visible in the zone list, the zone popup
and the "Flood zones" map layer. Several top zones around Lathrop sit mostly behind levees and inside the
200-year floodplain, so a flood penalty is the obvious next step for the score.

General plan land use is shown (the "General plan land use" layer) but not scored. It is 10–20 years old and is
not zoning, so use it as a first check on whether housing is planned for an area.

Not included yet: current zoning and spheres of influence, sewer/water plant capacity, local electric and gas
distribution (not public), land prices and ownership, and approved but unbuilt subdivisions. Treat zones as places to investigate, not approvals.

## Project layout

See also `CLAUDE.md` (working notes for contributors and Claude Code) and `docs/CHAT_HISTORY.md`
(the full conversation in which the project was built).

```
pipeline/            Python data pipeline (run in order, or ./run_pipeline.sh)
  01_boundaries.py     Census state / county / places
  17_areas.py          Census county subdivisions (9 areas tiling the county) + each area's rural land -> areas.
                       An area = its rural land + its towns whole (division lines cut through Lathrop and
                       Manteca), so towns + rural land add up exactly to each area
                       (runs right after 01)
  02_overture_buildings.py  Overture buildings via DuckDB (S3 GeoParquet)
  03_ms_baseline.py    Microsoft 2020 footprints (California, filtered to the AOI)
  04_parcels.py        County assessor parcels with YEAR_BUILT and Williamson Act contract status
  05_fire_perimeters.py, 06_firms.py, 07_fhsz.py   Fire layers (statewide)
  08_buildings_year.py Assigns a year to each building
  09_stats.py          Per-place and per-area metrics + scores -> web/public/data/{places,areas}.geojson, stats.json
  10_tiles.py, tiler.py  Pure-Python vector tiler -> web/public/data/*.pmtiles (buildings_low.pmtiles: building
                         dots for zoomed-out views, z8-11; footprints from z12)
  11_insurance_crime.py  County insurance + crime (statewide), city crime rates -> counties.geojson, context.json
                         (not shown in the app any more)
  12_growth_arrows.py    Growth-direction arrows per place and year -> growth_arrows.geojson
  16_utilities.py        Power lines, gas pipelines, water + sewer service areas -> utility_lines.geojson,
                         service_areas.geojson (runs before 13, which scores with them)
  13_recommend.py        Where-to-build-next model for every year 2000-2025 + backtest ->
                         recommend_cells.pmtiles, recommend_zones.geojson, recommend_region_zones.geojson,
                         recommend.json
  14_flood.py            FEMA flood zones + DWR 200-year floodplain -> flood.pmtiles, flood_200yr.geojson;
                         adds flood_* shares to places, county stats and every year's zones (not scored)
  15_general_plans.py    General plan land use (reference/general_plans) -> general_plans.geojson (not scored)
  18_check.py            Consistency checks: areas add up to the county, towns + rural land to each area, series
                         to headline counts, growth %, zone ranks / acres / polygons. Fails the pipeline on mismatch
web/                 React + MapLibre GL + PMTiles front end (Vite)
data/                Raw and intermediate files (git-ignored)
```

## Adding another county

1. Set `COUNTY_FIPS`, `AOI_NAME` and `AOI_BBOX` in `pipeline/common.py`.
2. Find that county's assessor parcel service with a year-built field and update `04_parcels.py`.
   Availability varies by county; Regrid and ReportAll sell this data statewide.
3. Run `./run_pipeline.sh`, then update `INITIAL_VIEW` and `DEFAULT_PLACE`
   in `web/src/config.ts`.

## Known limitations / next steps

- Single county. Statewide coverage needs parcel data for each county (or a paid provider).
- Score flood risk (it is shown, not scored), e.g. a penalty for the 100-year floodplain and a flag for the
  200-year floodplain without 200-year protection.
- Score general plan land use (e.g. favour cells planned for housing), current zoning, home prices (Zillow ZHVI),
  Census building permits, and VIIRS (375 m) fire detections alongside MODIS.
- Building detection on each NAIP year would give "first seen" dates where assessor data is missing.
