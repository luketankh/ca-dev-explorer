export const YEAR_MIN = 2000;
export const YEAR_MAX = 2026; // assessor records already include some 2026 completions

export const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
export const INITIAL_VIEW = { center: [-121.3, 37.93] as [number, number], zoom: 9.2 };
export const DEFAULT_PLACE = "Mountain House";

const base = import.meta.env.BASE_URL;
export const DATA = {
  buildings: `pmtiles://${location.origin}${base}data/buildings.pmtiles`,
  fires: `pmtiles://${location.origin}${base}data/fire_perimeters.pmtiles`,
  firms: `pmtiles://${location.origin}${base}data/firms.pmtiles`,
  fhsz: `pmtiles://${location.origin}${base}data/fhsz.pmtiles`,
  places: `${base}data/places.geojson`,
  stats: `${base}data/stats.json`,
  counties: `${base}data/counties.geojson`,
  arrows: `${base}data/growth_arrows.geojson`,
  context: `${base}data/context.json`,
  recCells: `${base}data/recommend_cells.geojson`,
  recZones: `${base}data/recommend_zones.geojson`,
  recommend: `${base}data/recommend.json`,
  steep: `${base}data/steep_terrain.geojson`,
};

// NAIP vintages available for San Joaquin County on Microsoft Planetary Computer
export const NAIP_YEARS = [2012, 2014, 2016, 2018, 2020, 2022];

// Colour roles (sequential ramps, light basemap)
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
  // terrain: brown ordinal pair
  hillside: "#e2cfa8",
  steep: "#a07d4f",
  text: "#0b0b0b",
  textSecondary: "#52514e",
};
