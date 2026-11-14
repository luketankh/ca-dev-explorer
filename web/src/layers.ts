import type { ExpressionSpecification, FilterSpecification, Map as MlMap } from "maplibre-gl";
import { COLORS, DATA, PLAN_CLASSES, YEAR_MAX } from "./config";

export type FireWindow = "all" | "10y" | "year";
export type LayerKey = "buildings" | "arrows" | "recommend" | "terrain" | "fires" | "firms" | "fhsz" | "flood" | "plans" | "places";
export type Visibility = Record<LayerKey, boolean>;

export const LAYER_IDS: Record<LayerKey, string[]> = {
  buildings: ["buildings-fill", "buildings-line"],
  fires: ["fires-fill", "fires-line"],
  firms: ["firms-heat"],
  fhsz: ["fhsz-fill"],
  flood: ["flood-fill", "flood-levee-line", "flood200-line"],
  plans: ["plans-fill", "plans-line"],
  places: ["places-fill", "places-line"],
  arrows: ["arrows-major", "arrows-minor", "arrows-major-infill", "arrows-minor-infill"],
  recommend: ["rec-cells", "rec-zones-line", "rec-labels"],
  terrain: ["hillshade"],
};

function firstSymbolLayer(map: MlMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === "symbol")?.id;
}

const rampStops = (stops: [number, string][]) => stops.flatMap(([v, c]) => [v, c]);

/** Hue = building type (assessor use), lightness = year built (darker = newer); red = built in `year`. */
export function buildingColor(year: number): ExpressionSpecification {
  const cat = ["coalesce", ["get", "category"], ""];
  // y = 0 (undated, existed before 2020) clamps to the lightest (oldest) step of its type
  const ramp = (stops: [number, string][]) => ["interpolate", ["linear"], ["get", "y"], ...rampStops(stops)];
  return [
    "case",
    ["==", ["get", "y"], year], COLORS.builtThisYear,
    ["==", cat, "Residential"], ramp(COLORS.buildingRamp),
    ["in", cat, ["literal", ["Commercial", "Industrial"]]], ramp(COLORS.buildingRampCI),
    ramp(COLORS.buildingRampOther),
  ] as unknown as ExpressionSpecification;
}

export type BuildingUse = "all" | "residential" | "ci" | "other";
export const BUILDING_USES: [BuildingUse, string][] = [
  ["all", "All"], ["residential", "Residential"], ["ci", "Commercial & industrial"], ["other", "Other"],
];

function useFilter(use: BuildingUse): unknown[] | null {
  const cat = ["coalesce", ["get", "category"], ""];
  if (use === "residential") return ["==", cat, "Residential"];
  if (use === "ci") return ["in", cat, ["literal", ["Commercial", "Industrial"]]];
  if (use === "other") return ["!", ["in", cat, ["literal", ["Residential", "Commercial", "Industrial"]]]];
  return null;
}

export function buildingFilter(year: number, use: BuildingUse = "all"): FilterSpecification {
  const yearF = ["any", ["==", ["get", "y"], 0], ["<=", ["get", "y"], year]];
  const u = useFilter(use);
  return (u ? ["all", yearF, u] : yearF) as FilterSpecification;
}

function fireStart(year: number, w: FireWindow) {
  return w === "all" ? 1900 : w === "10y" ? year - 9 : year;
}

export function fireFilter(year: number, w: FireWindow): FilterSpecification {
  return ["all", [">=", ["get", "year"], fireStart(year, w)], ["<=", ["get", "year"], year]] as FilterSpecification;
}

/** Add every data source/layer. `withPlaces: false` skips the places layers (for secondary maps). */
export interface ExtraData {
  arrows: GeoJSON.FeatureCollection;
  recZones: GeoJSON.FeatureCollection;
  recLabels: GeoJSON.FeatureCollection;
}

/** Predictions exist for REC_FIRST..REC_LAST; slider years outside that use the nearest one. */
export const REC_FIRST = 2000;
export const REC_LAST = 2025;
export const recYearFor = (year: number) => Math.min(REC_LAST, Math.max(REC_FIRST, year));

function recFilter(year: number): FilterSpecification {
  return ["==", ["get", "year"], recYearFor(year)] as FilterSpecification;
}

function arrowFilter(level: "major" | "minor", year: number, kind: "arrow" | "infill"): FilterSpecification {
  return ["all", ["==", ["get", "level"], level], ["==", ["get", "year"], year],
    ["==", ["get", "kind"], kind]] as FilterSpecification;
}

/** Translucent grey arrow pointing east (rotated per feature), drawn once at 2x resolution. */
function addArrowImage(map: MlMap) {
  if (map.hasImage("growth-arrow")) return;
  const w = 112, h = 44, c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  g.beginPath();
  g.moveTo(3, h * 0.36); g.lineTo(w * 0.62, h * 0.36); g.lineTo(w * 0.62, 3);
  g.lineTo(w - 3, h / 2);
  g.lineTo(w * 0.62, h - 3); g.lineTo(w * 0.62, h * 0.64); g.lineTo(3, h * 0.64);
  g.closePath();
  g.fillStyle = "rgba(61, 61, 58, 0.55)";
  g.fill();
  g.lineWidth = 3; g.strokeStyle = "rgba(255, 255, 255, 0.95)"; g.lineJoin = "round";
  g.stroke();
  map.addImage("growth-arrow", g.getImageData(0, 0, w, h), { pixelRatio: 2 });
}

export function addDataLayers(map: MlMap, places: GeoJSON.FeatureCollection, withPlaces = true,
                              extra?: ExtraData) {
  const before = firstSymbolLayer(map);

  if (extra) {
    // terrain: shaded relief from public elevation tiles (Terrarium encoding), under all data layers
    map.addSource("dem", {
      type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 14,
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      attribution: "Elevation: AWS Terrain Tiles (USGS 3DEP and others)",
    });
    map.addLayer({
      id: "hillshade", type: "hillshade", source: "dem",
      paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#5b5a55", "hillshade-highlight-color": "#ffffff" },
    }, before);
  }

  // general plan land use (reference/general_plans via pipeline/15_general_plans.py), under the hazard layers
  map.addSource("plans", { type: "geojson", data: DATA.plans });
  map.addLayer({
    id: "plans-fill", type: "fill", source: "plans",
    paint: {
      "fill-color": ["match", ["get", "luc"], ...PLAN_CLASSES.flatMap(([code, , color]) => [code, color]), "#e6e4de"] as unknown as ExpressionSpecification,
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 13, 0.45],
    },
  }, before);
  map.addLayer({
    id: "plans-line", type: "line", source: "plans", minzoom: 10,
    paint: { "line-color": "#ffffff", "line-width": 0.6, "line-opacity": 0.8 },
  }, before);

  // flood: FEMA flood zones (fill by class) + DWR 200-year floodplain (dashed outline); built by pipeline/14_flood.py
  map.addSource("flood", { type: "vector", url: DATA.flood });
  map.addLayer({
    id: "flood-fill", type: "fill", source: "flood", "source-layer": "flood",
    paint: {
      "fill-color": ["match", ["get", "cls"],
        "floodway", COLORS.flood.floodway, "100yr", COLORS.flood["100yr"], "500yr", COLORS.flood["500yr"],
        COLORS.flood.levee],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 13, 0.4],
    },
  }, before);
  map.addLayer({
    id: "flood-levee-line", type: "line", source: "flood", "source-layer": "flood",
    filter: ["==", ["get", "cls"], "levee"],
    paint: { "line-color": COLORS.floodLeveeLine, "line-width": 0.8, "line-dasharray": [2, 2] },
  }, before);
  map.addSource("flood200", { type: "geojson", data: DATA.flood200 });
  map.addLayer({
    id: "flood200-line", type: "line", source: "flood200",
    paint: { "line-color": COLORS.flood200, "line-width": 1.6, "line-dasharray": [3, 2] },
  }, before);

  map.addSource("fhsz", { type: "vector", url: DATA.fhsz });
  map.addLayer({
    id: "fhsz-fill", type: "fill", source: "fhsz", "source-layer": "fhsz",
    // LRA data also contains "NonWildland" polygons, which are not a hazard class
    filter: ["in", ["get", "hazard"], ["literal", ["Moderate", "High", "Very High"]]],
    paint: {
      "fill-color": ["match", ["get", "hazard"],
        "Very High", COLORS.hazard["Very High"], "High", COLORS.hazard.High, COLORS.hazard.Moderate],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.25, 8, 0.45],
    },
  }, before);

  map.addSource("fires", { type: "vector", url: DATA.fires });
  map.addLayer({
    id: "fires-fill", type: "fill", source: "fires", "source-layer": "fires",
    // lighter when zoomed out statewide
    paint: { "fill-color": COLORS.fireRecent, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.18, 8, 0.35] },
  }, before);
  map.addLayer({
    id: "fires-line", type: "line", source: "fires", "source-layer": "fires",
    paint: {
      "line-color": COLORS.fireRecent,
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.3, 8, 1],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.4, 8, 0.8],
    },
  }, before);

  map.addSource("firms", { type: "vector", url: DATA.firms });
  map.addLayer({
    id: "firms-heat", type: "heatmap", source: "firms", "source-layer": "firms",
    paint: {
      // low-zoom points are pre-aggregated (n = detections per cell); saturate gently
      "heatmap-weight": ["interpolate", ["linear"], ["coalesce", ["get", "n"], 1], 1, 0.03, 20, 0.3, 200, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 4, 0.4, 10, 1],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 4, 4, 10, 10, 14, 20],
      "heatmap-opacity": 0.8,
      "heatmap-color": [
        "interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(246,196,166,0)", 0.15, "#f6c4a6", 0.4, "#ec835a", 0.7, "#d95926", 1, "#8f2d0e",
      ],
    },
  }, before);

  if (withPlaces) {
    map.addSource("places", { type: "geojson", data: places, promoteId: "GEOID" });
    map.addLayer({
      id: "places-fill", type: "fill", source: "places", maxzoom: 13,
      paint: {
        "fill-color": ["case", ["==", ["get", "growth_10yr_pct"], null], "#f0efec",
          ["interpolate", ["linear"], ["get", "growth_10yr_pct"], ...rampStops(COLORS.growthRamp)]],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 12.5, 0],
      },
    }, before);
    map.addLayer({
      id: "places-line", type: "line", source: "places",
      paint: {
        "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#0b0b0b", "#7a7974"],
        "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 2.5, 1],
        "line-dasharray": [2, 1],
      },
    });
  }

  map.addSource("buildings", { type: "vector", url: DATA.buildings, minzoom: 12, maxzoom: 15 });
  map.addLayer({
    id: "buildings-fill", type: "fill", source: "buildings", "source-layer": "buildings", minzoom: 12,
    paint: { "fill-color": buildingColor(2025), "fill-opacity": 0.85 },
  });
  map.addLayer({
    id: "buildings-line", type: "line", source: "buildings", "source-layer": "buildings", minzoom: 14,
    paint: { "line-color": "#ffffff", "line-width": 0.5, "line-opacity": 0.6 },
  });

  if (extra) {
    // "Where to build next": suitability cells (aqua ramp) + ranked zone outlines + rank labels.
    // One prediction per year (made with data up to that year); filtered to the slider year.
    // Drawn under the buildings so existing development stays visible.
    map.addSource("rec-cells", { type: "vector", url: DATA.recCells, minzoom: 8, maxzoom: 13 });
    map.addLayer({
      id: "rec-cells", type: "fill", source: "rec-cells", "source-layer": "rec", filter: recFilter(REC_LAST),
      paint: {
        "fill-color": ["interpolate", ["linear"], ["get", "score"], ...rampStops(COLORS.suitRamp)],
        "fill-opacity": ["interpolate", ["linear"], ["get", "score"], 5, 0.15, 30, 0.45, 80, 0.65],
      },
    }, "buildings-fill");
    map.addSource("rec-zones", { type: "geojson", data: extra.recZones });
    map.addLayer({
      id: "rec-zones-line", type: "line", source: "rec-zones", filter: recFilter(REC_LAST),
      paint: { "line-color": COLORS.suitDark, "line-width": 2, "line-dasharray": [3, 1.5] },
    });
    map.addSource("rec-labels", { type: "geojson", data: extra.recLabels });
    map.addLayer({
      id: "rec-labels", type: "symbol", source: "rec-labels", filter: recFilter(REC_LAST),
      layout: {
        "text-field": ["to-string", ["get", "rank"]], "text-size": 13, "text-font": ["Noto Sans Bold"],
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#ffffff", "text-halo-color": COLORS.suitDark, "text-halo-width": 6 },
    });

    // growth direction: one translucent grey arrow per cluster of new homes, tip on the cluster,
    // rotated to the cluster's bearing. Icons keep a readable size at every zoom.
    // Major clusters (>= 100 homes) show from county zoom; minor ones only when zoomed in.
    addArrowImage(map);
    map.addSource("arrows", { type: "geojson", data: extra.arrows });
    // size grows with zoom and with the number of new homes in the cluster
    const homes = ["interpolate", ["linear"], ["get", "new_homes"], 20, 0.55, 300, 1, 1000, 1.45];
    const iconSize = ["interpolate", ["linear"], ["zoom"], 8, ["*", 0.5, homes], 12, ["*", 1.0, homes],
      15, ["*", 1.9, homes]] as unknown as ExpressionSpecification;
    for (const [lvl, minzoom] of [["major", 8], ["minor", 11]] as const) {
      map.addLayer({
        id: `arrows-${lvl}`, type: "symbol", source: "arrows", minzoom,
        filter: arrowFilter(lvl, YEAR_MAX, "arrow"),
        layout: {
          "icon-image": "growth-arrow", "icon-size": iconSize, "icon-anchor": "right",
          "icon-rotate": ["-", ["get", "bearing"], 90], "icon-rotation-alignment": "map",
          "icon-allow-overlap": true, "icon-ignore-placement": true,
        },
      });
      map.addLayer({
        id: `arrows-${lvl}-infill`, type: "circle", source: "arrows", minzoom,
        filter: arrowFilter(lvl, YEAR_MAX, "infill"),
        paint: {
          "circle-color": "#3d3d3a", "circle-opacity": 0.4, "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5, "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 14, 12],
        },
      });
    }
  }
}

/** Apply slider year + fire window to every time-aware layer. */
export function applyYear(map: MlMap, year: number, w: FireWindow, use: BuildingUse = "all") {
  if (!map.getLayer("buildings-fill")) return;
  map.setFilter("buildings-fill", buildingFilter(year, use));
  map.setFilter("buildings-line", buildingFilter(year, use));
  map.setPaintProperty("buildings-fill", "fill-color", buildingColor(year));
  for (const id of ["rec-cells", "rec-zones-line", "rec-labels"]) {
    if (map.getLayer(id)) map.setFilter(id, recFilter(year));
  }
  if (map.getLayer("arrows-major")) {
    for (const lvl of ["major", "minor"] as const) {
      map.setFilter(`arrows-${lvl}`, arrowFilter(lvl, year, "arrow"));
      map.setFilter(`arrows-${lvl}-infill`, arrowFilter(lvl, year, "infill"));
    }
  }
  const ff = fireFilter(year, w);
  map.setFilter("fires-fill", ff);
  map.setFilter("fires-line", ff);
  map.setFilter("firms-heat", ff);
  // recent fires darker/more opaque than old ones
  const start = fireStart(year, w);
  const span = Math.max(1, year - Math.max(start, year - 30));
  map.setPaintProperty("fires-fill", "fill-color", [
    "interpolate", ["linear"], ["get", "year"],
    year - span, COLORS.fireOld, year, COLORS.fireRecent,
  ] as ExpressionSpecification);
}

export function setVisibility(map: MlMap, vis: Visibility) {
  (Object.keys(LAYER_IDS) as LayerKey[]).forEach((k) => {
    LAYER_IDS[k].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis[k] ? "visible" : "none");
    });
  });
}
