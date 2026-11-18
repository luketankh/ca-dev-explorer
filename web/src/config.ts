export const YEAR_MIN = 2000;
export const YEAR_MAX = 2026; // assessor records already include some 2026 completions

export const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
export const INITIAL_VIEW = { center: [-121.3, 37.93] as [number, number], zoom: 9.2 };
export const DEFAULT_PLACE = "Mountain House";

const base = import.meta.env.BASE_URL;
export const DATA = {
  buildings: `pmtiles://${location.origin}${base}data/buildings.pmtiles`,
  buildingsLow: `pmtiles://${location.origin}${base}data/buildings_low.pmtiles`,
  fires: `pmtiles://${location.origin}${base}data/fire_perimeters.pmtiles`,
  fhsz: `pmtiles://${location.origin}${base}data/fhsz.pmtiles`,
  places: `${base}data/places.geojson`,
  stats: `${base}data/stats.json`,
  arrows: `${base}data/growth_arrows.geojson`,
  recCells: `pmtiles://${location.origin}${base}data/recommend_cells.pmtiles`,
  recZones: `${base}data/recommend_zones.geojson`,
  recommend: `${base}data/recommend.json`,
  flood: `pmtiles://${location.origin}${base}data/flood.pmtiles`,
  flood200: `${base}data/flood_200yr.geojson`,
  plans: `${base}data/general_plans.geojson`,
  // latest USDA NAIP aerial imagery via USGS The National Map (public domain, no key); one vintage, not by year
  aerial: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
  areas: `${base}data/areas.geojson`,
  recRegionZones: `${base}data/recommend_region_zones.geojson`,
  utilityLines: `${base}data/utility_lines.geojson`,
  serviceAreas: `${base}data/service_areas.geojson`,
};


// Colour roles (sequential ramps, light basemap)
/** General plan land-use classes (reference/general_plans), in legend order: [code, label, colour, housing note]. */
export const PLAN_CLASSES: [number, string, string, string][] = [
  [5, "High density residential (8+ homes/acre)", "#c9861a", "Housing is the planned use."],
  [6, "Medium density residential (0.5–8 homes/acre)", "#eeb54a", "Housing is the planned use (typical suburban subdivisions)."],
  [7, "Low density residential (2–20 acre lots)", "#f8dc86", "Housing on large rural lots; suburban densities would need a plan amendment."],
  [13, "Very low density residential (20–160 acre lots)", "#fcf1c6", "Ranchettes; suburban densities would need a plan amendment."],
  [12, "Mixed use", "#c75b8f", "Housing allowed alongside shops and offices."],
  [11, "Planned development / specific plan", "#8fb3d9", "Often includes housing; check the specific plan."],
  [10, "Urban reserve", "#cfc5b4", "Held for future city growth; usually needs a plan amendment or annexation first."],
  [3, "High density commercial", "#d6504a", "Not planned for housing; needs a plan amendment."],
  [4, "Low density commercial, schools & public", "#f0a39b", "Not planned for housing; needs a plan amendment."],
  [2, "Industrial", "#8f79b8", "Not planned for housing; needs a plan amendment."],
  [1, "Agricultural", "#c6dca5", "Farming; homes beyond a farmhouse need a plan amendment."],
  [8, "Open space & public lands", "#69a468", "Not planned for development."],
  [9, "Water", "#a6d4ea", "Water."],
  [-1, "Other / not determined", "#e6e4de", "No class in the source data."],
];

export const COLORS = {
  // residential: one blue ramp, older = lighter, newer = darker (undated pre-2020 buildings use the lightest step)
  buildingRamp: [
    [1950, "#9ec5f4"],
    [1980, "#6da7ec"],
    [2000, "#2a78d6"],
    [2015, "#1c5cab"],
    [2025, "#0d366b"],
  ] as [number, string][],
  // commercial & industrial: one amber ramp, older = lighter (validated vs blue + red, incl. colour-blind)
  buildingRampCI: [
    [1950, "#fbe2a0"],
    [1980, "#f5c451"],
    [2000, "#eda100"],
    [2015, "#c98500"],
    [2025, "#8f5d00"],
  ] as [number, string][],
  // other (agricultural, public, institutional, no parcel match): neutral grey ramp, deliberately recessive
  buildingRampOther: [
    [1950, "#dcdad3"],
    [1980, "#c3c1b9"],
    [2000, "#a3a198"],
    [2015, "#85837b"],
    [2025, "#6b6a64"],
  ] as [number, string][],
  builtThisYear: "#e34948",
  // fire history: one orange ramp, older = lighter
  fireOld: "#f6c4a6",
  fireRecent: "#b8441a",
  // hazard zones: one magenta ordinal ramp
  hazard: { Moderate: "#f3c6d6", High: "#e87ba4", "Very High": "#b8336a" } as Record<string, string>,
  // places choropleth: blue ramp on 10-yr growth
  growthRamp: [
    [0, "#e8f0fb"],
    [10, "#9ec5f4"],
    [25, "#3987e5"],
    [60, "#184f95"],
  ] as [number, string][],
  // "where to build next" suitability: one aqua ramp
  suitRamp: [
    [5, "#d3f2e6"],
    [30, "#7fd6b4"],
    [60, "#1baf7a"],
    [100, "#0d6b49"],
  ] as [number, string][],
  suitDark: "#0d6b49",
  zoneHighlight: "#1baf7a", // glow around the zone picked in the report
  powerLine: "#2f3640",      // electric transmission lines (charcoal)
  gasLine: "#6d5bd0",        // natural gas transmission pipelines (dashed)
  waterService: "#1593b8",   // community water system service areas
  sewerService: "#6b8e23",   // sewer service areas (dashed outline)
  // flood: one cyan ordinal ramp, darker = more likely to flood (kept off the building blues and the aqua suitability ramp)
  flood: {
    floodway: "#0a5f7a",
    "100yr": "#2aa3c9",
    "500yr": "#9fd8ea",
    levee: "#d4edf5",
  } as Record<string, string>,
  floodLeveeLine: "#5fa9c2",
  flood200: "#6f3fb0", // DWR 200-year floodplain outline (violet, dashed)
  text: "#0b0b0b",
  textSecondary: "#52514e",
};
