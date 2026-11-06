import type { ExpressionSpecification, FilterSpecification, Map as MlMap } from "maplibre-gl";
import { COLORS, DATA, YEAR_MAX } from "./config";
import { naipTileUrl, naipYearFor } from "./naip";

export type FireWindow = "all" | "10y" | "year";
export type LayerKey = "naip" | "buildings" | "arrows" | "recommend" | "fires" | "firms" | "fhsz" | "places" | "counties";
export type CountyMetric = "premium" | "violent_per_1k" | "property_per_1k";

export const COUNTY_METRICS: Record<CountyMetric, { label: string; stops: [number, string][]; fmt: (v: number) => string }> = {
  premium: {
    label: "Home insurance, median annual premium (2024)",
    stops: [[1200, "#e4e0f8"], [1700, "#b3a9ee"], [2300, "#7d6fe0"], [3000, "#4b3cb8"], [3900, "#2e2370"]],
    fmt: (v) => "$" + Math.round(v).toLocaleString(),
  },
  violent_per_1k: {
    label: "Violent crimes per 1,000 residents (2025)",
    stops: [[1, "#e4e0f8"], [2.5, "#b3a9ee"], [4, "#7d6fe0"], [5.5, "#4b3cb8"], [7.5, "#2e2370"]],
    fmt: (v) => v.toFixed(1),
  },
  property_per_1k: {
    label: "Property crimes per 1,000 residents (2025)",
    stops: [[5, "#e4e0f8"], [10, "#b3a9ee"], [15, "#7d6fe0"], [20, "#4b3cb8"], [27, "#2e2370"]],
    fmt: (v) => v.toFixed(1),
  },
};
export type Visibility = Record<LayerKey, boolean>;

export const LAYER_IDS: Record<LayerKey, string[]> = {
  naip: ["naip"],
  buildings: ["buildings-fill", "buildings-line"],
  fires: ["fires-fill", "fires-line"],
  firms: ["firms-heat"],
  fhsz: ["fhsz-fill"],
  places: ["places-fill", "places-line"],
  arrows: ["arrows-major", "arrows-minor", "arrows-major-infill", "arrows-minor-infill"],
  recommend: ["rec-cells", "rec-zones-line", "rec-labels"],
  counties: ["counties-fill", "counties-line"],
};

function firstSymbolLayer(map: MlMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === "symbol")?.id;
}

const rampStops = (stops: [number, string][]) => stops.flatMap(([v, c]) => [v, c]);

export function buildingColor(year: number): ExpressionSpecification {
  return [
    "case",
    ["==", ["get", "ys"], "unknown"], COLORS.buildingUnknown,
    ["==", ["get", "y"], year], COLORS.builtThisYear,
    ["interpolate", ["linear"], ["get", "y"], ...rampStops(COLORS.buildingRamp)],
  ] as ExpressionSpecification;
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

/** Add every data source/layer. `withPlaces` is false for the compare (swipe) map. */
export interface ExtraData {
  counties: GeoJSON.FeatureCollection;
  arrows: GeoJSON.FeatureCollection;
  recCells: GeoJSON.FeatureCollection;
  recZones: GeoJSON.FeatureCollection;
  recLabels: GeoJSON.FeatureCollection;
}

export function countyFill(metric: CountyMetric): ExpressionSpecification {
  return ["case", ["==", ["get", metric], null], "#f0efec",
    ["interpolate", ["linear"], ["get", metric], ...rampStops(COUNTY_METRICS[metric].stops)]] as ExpressionSpecification;
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

export function setCountyMetric(map: MlMap, metric: CountyMetric) {
  if (map.getLayer("counties-fill")) map.setPaintProperty("counties-fill", "fill-color", countyFill(metric));
}

export function addDataLayers(map: MlMap, places: GeoJSON.FeatureCollection, withPlaces = true,
                              extra?: ExtraData) {
  const before = firstSymbolLayer(map);

  if (extra) {
    // statewide county comparison (insurance / crime); fades out as you zoom into the county
    map.addSource("counties", { type: "geojson", data: extra.counties, promoteId: "GEOID" });
    map.addLayer({
      id: "counties-fill", type: "fill", source: "counties", maxzoom: 10,
      paint: {
        "fill-color": countyFill("premium"),
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.75, 9.5, 0],
      },
    }, before);
    map.addLayer({
      id: "counties-line", type: "line", source: "counties", maxzoom: 10,
      paint: { "line-color": "#ffffff", "line-width": 1, "line-opacity": 0.9 },
    }, before);
  }

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
    // lighter when zoomed out statewide so the county comparison stays readable
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
    // Drawn under the buildings so existing development stays visible.
    map.addSource("rec-cells", { type: "geojson", data: extra.recCells });
    map.addLayer({
      id: "rec-cells", type: "fill", source: "rec-cells",
      paint: {
        "fill-color": ["interpolate", ["linear"], ["get", "score"], ...rampStops(COLORS.suitRamp)],
        "fill-opacity": ["interpolate", ["linear"], ["get", "score"], 5, 0.15, 30, 0.45, 80, 0.65],
      },
    }, "buildings-fill");
    map.addSource("rec-zones", { type: "geojson", data: extra.recZones });
    map.addLayer({
      id: "rec-zones-line", type: "line", source: "rec-zones",
      paint: { "line-color": COLORS.suitDark, "line-width": 2, "line-dasharray": [3, 1.5] },
    });
    map.addSource("rec-labels", { type: "geojson", data: extra.recLabels });
    map.addLayer({
      id: "rec-labels", type: "symbol", source: "rec-labels",
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

/** Show NAIP imagery for the vintage nearest (at or before) `year`. Returns the vintage shown. */
export async function setNaip(map: MlMap, year: number, visible: boolean): Promise<number> {
  const vintage = naipYearFor(year);
  const current = map.getSource("naip") as unknown as { _vintage?: number } | undefined;
  if (!visible) {
    if (map.getLayer("naip")) map.setLayoutProperty("naip", "visibility", "none");
    return vintage;
  }
  if (current && current._vintage === vintage) {
    map.setLayoutProperty("naip", "visibility", "visible");
    return vintage;
  }
  const url = await naipTileUrl(vintage);
  if (map.getLayer("naip")) map.removeLayer("naip");
  if (map.getSource("naip")) map.removeSource("naip");
  map.addSource("naip", {
    type: "raster", tiles: [url], tileSize: 256, minzoom: 11, maxzoom: 18,
    attribution: `USDA NAIP ${vintage} via Microsoft Planetary Computer`,
  });
  (map.getSource("naip") as unknown as { _vintage: number })._vintage = vintage;
  // imagery sits under all data layers
  const firstData = ["fhsz-fill", "fires-fill"].find((id) => map.getLayer(id));
  map.addLayer({ id: "naip", type: "raster", source: "naip", minzoom: 11 }, firstData);
  return vintage;
}

export function setVisibility(map: MlMap, vis: Visibility) {
  (Object.keys(LAYER_IDS) as LayerKey[]).forEach((k) => {
    if (k === "naip") return;
    LAYER_IDS[k].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis[k] ? "visible" : "none");
    });
  });
}
