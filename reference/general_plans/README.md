# General Land Use Plans for California (reference data)

Statewide general-plan land use, standardised to 13 classes. The San Joaquin file is shown in the app as
the "General plan land use" layer (prepared by `pipeline/15_general_plans.py`); it is not in the score yet.

## Files

| File | Coverage | Where |
|---|---|---|
| `general_plans_san_joaquin.geojson` | San Joaquin County, 1,349 polygons, 2.4 MB | This folder |
| `general_plans_ca.gpkg` (layer `general_plans`) | All 58 counties, 133,203 polygons, 154 MB | GitHub release [`general-plans-v1`](https://github.com/luketankh/ca-dev-explorer/releases/tag/general-plans-v1) (too big for git) |

Both files are in WGS84 (EPSG:4326) and have these fields:

| Field | Meaning |
|---|---|
| `luc` | Land Use Code (number, see below) |
| `luc_name` | Class name |
| `county`, `fips` | County name and 3-digit county FIPS code |
| `acres` | Polygon area, computed in California Albers (EPSG:3310) |

## Land use classes

| `luc` | Class | Definition (from the source layer) |
|---|---|---|
| -1 | Other / not determined | |
| 1 | Agricultural | Intensive, extensive and general agriculture, grazing land |
| 2 | Industrial | Heavy and light industry |
| 3 | High density commercial | Downtown, office, highway and regional commercial, civic centres |
| 4 | Low density commercial | Neighbourhood, general and community commercial, schools, institutional, public/quasi-public |
| 5 | High density residential | More than 8 dwelling units per acre |
| 6 | Medium density residential | 0.5 to 8 dwelling units per acre |
| 7 | Low density residential | Lots over 2 and up to 20 acres |
| 8 | Open space and public lands | |
| 9 | Water | |
| 10 | Urban reserve | |
| 11 | Planned development / specific plan | Planned development, specific plan area, study area |
| 12 | Mixed use | Residential and commercial |
| 13 | Very low density residential | Lots over 20 and under 160 acres |

San Joaquin County by area: low density residential 37%, agricultural 32%, very low density
residential 14%, medium density residential 8%, everything else under 3% each.

## Source and credit

- **Source:** California Resources Agency / University of California Davis (Information Center
  for the Environment; Bob Johnston, Mike McCoy, Shengyi Gau). Distributed by the Conservation
  Biology Institute on Data Basin:
  <https://databasin.org/datasets/1cda3056a4ad4ece86eb5eda4ef17e82/>
- **Vintage:** first built in 2004, last updated about 2014. It reflects general plans of that
  era, not current ones.
- **Variant:** this is the "rural residential" scenario layer (`genplans_rr`), which reclassifies
  agricultural land with existing rural housing density as low or very low density residential.
  The sister dataset holds the general plans as delivered by the counties.
- **Terms:** free to use and redistribute. The State of California and the Resources Agency make
  no warranty about accuracy, and users must credit the Resources Agency as the original source.

## Changes from the original

The original shapefile (`genplans_rr.shp`, NAD83 California Teale Albers) was modified as follows:

1. Reprojected to WGS84 (EPSG:4326).
2. 1,491 invalid polygons repaired with `shapely.make_valid`.
3. Added `luc_name` (class names taken from the source layer file) and `acres`.
4. Dropped `OBJECTID`, `AREA_`, `PERIMETER`, `NUM`, `Shape_Leng`, `Shape_Area`; renamed
   `LUC` → `luc`, `CNTYNAME` → `county`, `FIPS` → `fips`.
5. San Joaquin file: filtered to `county == "San Joaquin"`.
