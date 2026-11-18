import { useEffect, useRef, useState } from "react";
import {
  addProtocol, setWorkerUrl, LngLatBounds, Map as MlMap, NavigationControl, Popup, ScaleControl,
  type MapGeoJSONFeature,
} from "maplibre-gl";
import { Protocol } from "pmtiles";
import "maplibre-gl/dist/maplibre-gl.css";
// Bundle MapLibre's module worker (and its shared chunk) so it works in dev and production builds
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

import { BASEMAP_STYLE, COLORS, DATA, DEFAULT_PLACE, INITIAL_VIEW, YEAR_MAX, YEAR_MIN, PLAN_CLASSES } from "./config";
import {
  addAreaLayers, addDataLayers, addUtilityLines, applyYear, setRegionHighlight, showAreas, recYearFor, setVisibility, setZoneHighlight, setZoneScope,
  type ExtraData, type FireWindow, type LayerKey, type Visibility,
} from "./layers";
import Report from "./components/Report";
import Regions from "./components/Regions";
import LayerIcon from "./components/LayerIcon";
import type { PlaceMetrics, Recommend, Stats } from "./types";

setWorkerUrl(maplibreWorkerUrl);
const protocol = new Protocol();
addProtocol("pmtiles", protocol.tile);

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// [key, short label under the icon, full name, source] — full name and source show in the tooltip
const LAYER_LABELS: [LayerKey, string, string, string][] = [
  ["buildings", "Buildings", "Buildings by type & year built", "Overture Maps + County Assessor + Microsoft 2020"],
  ["arrows", "Growth", "Growth direction arrows", "Where homes built in the last 5 years went, vs existing homes"],
  ["recommend", "Build next", "Where to build next (predicted each year)", "Growth momentum × flat open land × next to town × fire risk"],
  ["places", "Cities", "Cities & growth choropleth", "Census TIGER places"],
  ["fires", "Past fires", "Fire perimeters", "CAL FIRE FRAP (all years) + NIFC WFIGS (current season)"],
  ["fhsz", "Fire hazard", "Fire Hazard Severity Zones", "CAL FIRE, SRA 2024 / LRA 2025"],
  ["flood", "Flood", "Flood zones", "FEMA flood maps (2009–2016) + DWR 200-year floodplain"],
  ["plans", "Land use", "General plan land use", "City & county general plans, c. 2004–2014 (CA Resources Agency / UC Davis)"],
  ["utilities", "Power & gas", "Power lines & gas pipelines", "CA Energy Commission transmission lines (60 kV+) + EIA gas transmission pipelines"],
  ["services", "Water & sewer", "Water & sewer service areas", "State Water Board community water systems + city limits & county sewer districts"],
  ["aerial", "Aerial", "Aerial photo (latest)", "USDA NAIP imagery via USGS The National Map, latest vintage; doesn't change with the year slider"],
];

function pointInRing([x, y]: number[], ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// fire exponent and farmland-contract penalty used by the model (read from recommend.json on load)
let fireExponent = 2;
let contractPenalty = 0.8;

function recPopup(cell: MapGeoJSONFeature | undefined, zone: { properties: unknown } | undefined) {
  const c = (cell?.properties ?? {}) as Record<string, number | string>;
  const z = (zone?.properties ?? {}) as Record<string, number | string>;
  const pct = (v: unknown) => `${Math.round(Number(v) * 100)}%`;
  const head = zone ? `#${esc(z.rank)} ${esc(z.label)}` : "Development suitability";
  const zoneRows = zone ? `<tr><th>Zone size</th><td>${Number(z.acres).toLocaleString()} acres mostly open</td></tr>
    ${z.flood_100yr_share !== undefined ? `<tr><th>Flood</th><td>${floodSummary(z)}</td></tr>` : ""}` : "";
  const cellRows = cell ? `
    <tr><th>Cell score</th><td><b>${esc(c.score)}</b> / 100</td></tr>
    <tr><th>Growth momentum</th><td>${pct(c.momentum)}</td></tr>
    <tr><th>Next to town</th><td>${pct(c.adjacency)}</td></tr>
    <tr><th>Terrain</th><td>${pct(c.flat_share)} flat (≤15% slope) · avg slope ${esc(c.slope_mean)}% · ${esc(c.elev_m)} m</td></tr>
    <tr><th>Open land</th><td>${Number(c.room) === 1 ? "Yes" : Number(c.room) > 0 ? "Partly built" : "Built up"}</td></tr>
    <tr><th>Farmland contract</th><td>${Number(c.contract) > 0 ? `${pct(c.contract)} under Williamson Act / Farmland Security Zone` : "None"}${
      Number(c.contract_ending) > 0 ? ` · ${pct(c.contract_ending)} contract ending within 5 yrs` : ""}</td></tr>
    ${c.utilities !== undefined ? `<tr><th>Water & sewer</th><td>water ${pct(c.water_access)}, sewer ${pct(c.sewer_access)} access</td></tr>` : ""}
    ${c.lost !== undefined && Number(c.lost) > 0 ? `<tr><th>Unusable land</th><td>${pct(c.lost)} in easements, water or canal right-of-way</td></tr>` : ""}
    ${c.plan_nonres !== undefined && Number(c.plan_nonres) > 0 ? `<tr><th>General plan</th><td>${pct(c.plan_nonres)} planned industrial</td></tr>` : ""}
    <tr><th>Fire risk</th><td><b>${pct(c.fire_risk)}</b>${c.fhsz_class && c.fhsz_class !== "None" ? ` · FHSZ ${esc(c.fhsz_class)}` : ""}</td></tr>
    <tr><th>Fire history</th><td>${pct(c.fire_history)} (frequency ${pct(c.fire_freq)}, repeat burns ${pct(c.fire_reburn)},
      recent big fire ${pct(c.fire_last)})${c.years_since_fire !== null && c.years_since_fire !== undefined && c.years_since_fire !== ""
        ? ` · last fire ${Number(c.years_since_fire) === 0 ? "this year" : `${esc(c.years_since_fire)} yrs ago`}` : " · none on record"}</td></tr>` : "";
  return `<div class="pop"><h4>${head}</h4><table>${zoneRows}${cellRows}</table>
    <div class="pop-id">500 m square. Score = its 11 factors (0–100 each) multiplied; see “How this is calculated” in Analysis.</div></div>`;
}

/** One line of flood exposure for a zone or place (shares are 0-1 of its area). */
function floodSummary(z: Record<string, number | string>) {
  const share = (k: string) => Number(z[k] ?? 0);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const fema100 = share("flood_100yr_share") + share("flood_floodway_share");
  const parts = [
    `<b>${pct(fema100)}</b> in FEMA 100-year floodplain${share("flood_floodway_share") >= 0.01 ? ` (${pct(share("flood_floodway_share"))} floodway)` : ""}`,
    share("flood_levee_share") >= 0.01 ? `${pct(share("flood_levee_share"))} levee-protected` : "",
    share("flood_500yr_share") >= 0.01 ? `${pct(share("flood_500yr_share"))} in 500-year` : "",
    `${pct(share("flood_200yr_share"))} in DWR 200-year floodplain`,
  ];
  return parts.filter(Boolean).join(" · ");
}

const FLOOD_LABEL: Record<string, string> = {
  floodway: "Floodway", "100yr": "100-year floodplain", "500yr": "500-year floodplain", levee: "Levee-protected area",
};
const FLOOD_NOTE: Record<string, string> = {
  floodway: "River channel kept clear for flood flows; effectively unbuildable.",
  "100yr": "1% chance of flooding each year. Lenders require flood insurance; new homes must be raised above the flood level.",
  "500yr": "0.2% chance of flooding each year. Moderate risk; insurance optional.",
  levee: "Protected by a levee, but would flood if the levee failed.",
};

function floodPopup(f: MapGeoJSONFeature) {
  const p = f.properties as Record<string, string | number>;
  const cls = String(p.cls);
  return `<div class="pop"><h4>${esc(FLOOD_LABEL[cls] ?? "Flood zone")}</h4><table>
    <tr><th>FEMA zone</th><td>${esc(p.zone)}${p.sub ? ` · ${esc(String(p.sub).toLowerCase())}` : ""}</td></tr>
    ${p.bfe !== undefined && p.bfe !== null && p.bfe !== "" ? `<tr><th>Base flood elevation</th><td>${esc(p.bfe)} ft</td></tr>` : ""}
    </table><p class="pop-text">${esc(FLOOD_NOTE[cls] ?? "")}</p>
    <div class="pop-id">FEMA National Flood Hazard Layer, San Joaquin County map (effective 2009–2016).</div></div>`;
}

function planPopup(f: MapGeoJSONFeature) {
  const p = f.properties as Record<string, string | number>;
  const cls = PLAN_CLASSES.find(([code]) => code === Number(p.luc));
  return `<div class="pop"><h4>${esc(cls?.[1] ?? p.luc_name)}</h4><table>
    <tr><th>Planned use</th><td>${esc(p.luc_name)}</td></tr>
    <tr><th>Area</th><td>${Number(p.acres).toLocaleString()} acres</td></tr>
    </table><p class="pop-text">${esc(cls?.[3] ?? "")}</p>
    <div class="pop-id">General plans of c. 2004–2014, not current zoning. Confirm with the city or county planning
    department. Source: California Resources Agency / UC Davis.</div></div>`;
}

function utilityPopup(f: MapGeoJSONFeature) {
  const p = f.properties as Record<string, string | number | boolean>;
  const gas = p.kind === "gas";
  const head = gas ? "Natural gas transmission pipeline" : `${p.kv ? `${esc(p.kv)} kV ` : ""}power line`;
  return `<div class="pop"><h4>${head}</h4><table>
    ${p.name && !gas ? `<tr><th>Line</th><td>${esc(p.name)}</td></tr>` : ""}
    ${p.owner ? `<tr><th>Operator</th><td>${esc(p.owner)}</td></tr>` : ""}
    <tr><th>Treated as unbuildable</th><td>${esc(p.buffer_m)} m either side (easement / setback)</td></tr>
    </table><p class="pop-text">Homes are kept out of transmission easements and back from high-pressure gas lines,
    so the where-to-build-next score counts this strip as lost land.</p>
    <div class="pop-id">${gas ? "U.S. EIA natural gas pipelines" : "California Energy Commission transmission lines"}.
    Local distribution lines aren't public.</div></div>`;
}

function servicePopup(feats: MapGeoJSONFeature[]) {
  const row = (f: MapGeoJSONFeature) => {
    const p = f.properties as Record<string, string | number>;
    return `<tr><th>${p.kind === "water" ? "Water" : "Sewer"}</th><td>${esc(p.name)}${
      p.population ? ` · serves ~${Number(p.population).toLocaleString()} people` : ""}</td></tr>`;
  };
  const kinds = new Set(feats.map((f) => f.properties.kind));
  return `<div class="pop"><h4>${kinds.size === 2 ? "Water and sewer service" : kinds.has("water") ? "Water service area" : "Sewer service area"}</h4>
    <table>${feats.map(row).join("")}</table>
    <p class="pop-text">Land inside or within 500 m of water and sewer service scores higher: new homes can hook up
    without long main extensions.</p>
    <div class="pop-id">Today's boundaries: State Water Board (community water systems), city limits and
    San Joaquin County sewer districts.</div></div>`;
}

function arrowPopup(f: MapGeoJSONFeature) {
  const p = f.properties as Record<string, string | number>;
  const text = p.kind === "infill"
    ? `Infill: ${Number(p.new_homes).toLocaleString()} homes built ${esc(p.window)} inside existing development.`
    : `${Number(p.new_homes).toLocaleString()} homes built ${esc(p.window)}, centered <b>${esc(p.shift_km)} km
       ${esc(p.direction)}</b> of the existing homes within 2 km.`;
  return `<div class="pop"><h4>Growth area · ${esc(p.name)}</h4><p class="pop-text">${text}</p>
    <div class="pop-id">One arrow per cluster of new homes. Direction is to scale; length is clamped
    for readability; width grows with the number of homes.</div></div>`;
}

function bboxOf(geom: GeoJSON.Geometry): LngLatBounds {
  const b = new LngLatBounds();
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") b.extend(c as [number, number]);
    else if (Array.isArray(c)) c.forEach(walk);
  };
  walk((geom as GeoJSON.Polygon).coordinates);
  return b;
}

function buildingPopup(f: MapGeoJSONFeature) {
  const p = f.properties as Record<string, string | number>;
  const yearText =
    p.ys === "assessor" ? `${p.y}` : p.ys === "new" ? "After 2020 (est.)" : "Before 2020 (year unknown)";
  const source =
    p.ys === "assessor" ? "County assessor" : p.ys === "new" ? "Not in Microsoft 2020 footprints" : "In Microsoft 2020 footprints";
  const sqft = p.area_m2 ? Math.round(Number(p.area_m2) * 10.764).toLocaleString() : "–";
  const rows: [string, string][] = [
    ["Year built", yearText],
    ["Year source", source],
    ["Use", String(p.use || p.category || "–")],
    ["Units", p.units ? String(p.units) : "–"],
    ["Footprint", `${sqft} sq ft`],
    ["Height", p.h ? `${Number(p.h).toFixed(1)} m` : "–"],
    ["Outline from", String(p.src ?? "–")],
  ];
  return `<div class="pop"><h4>Building</h4><table>${rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join("")}</table><div class="pop-id">Overture ID ${esc(p.id)}</div></div>`;
}

function firePopup(f: MapGeoJSONFeature) {
  const p = f.properties as Record<string, string | number>;
  return `<div class="pop"><h4>${esc(p.name || "Unnamed fire")}</h4><table>
    <tr><th>Year</th><td>${esc(p.year)}</td></tr>
    <tr><th>Size</th><td>${Number(p.acres || 0).toLocaleString()} acres</td></tr>
    <tr><th>Agency</th><td>${esc(p.agency || "–")}</td></tr></table></div>`;
}

export default function App() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [placesFc, setPlacesFc] = useState<GeoJSON.FeatureCollection | null>(null);
  // the county's areas (Census county divisions) and their rural land outside towns
  const [areasFc, setAreasFc] = useState<GeoJSON.FeatureCollection | null>(null);
  const [year, setYear] = useState(YEAR_MAX - 1); // start on the last complete year
  const [playing, setPlaying] = useState(false);
  const [fireWindow, setFireWindow] = useState<FireWindow>("all");
  // start uncluttered: buildings, growth arrows and the build-next prediction; everything else is opt-in
  const [vis, setVis] = useState<Visibility>({
    buildings: true, arrows: true, recommend: true,
    fires: false, fhsz: false, flood: false, plans: false, places: false, utilities: false, services: false, aerial: false,
  });
  const [recommend, setRecommend] = useState<Recommend | null>(null);
  const [extra, setExtra] = useState<ExtraData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(INITIAL_VIEW.zoom);
  // the right panel (regions list or analysis) stays closed until the user asks for it
  const [panel, setPanel] = useState<"regions" | "report" | null>(null);
  const showReport = panel !== null;
  // bumped when a region is picked, so picking the already-selected region still re-fits the map
  const [focusTick, setFocusTick] = useState(0);
  // the ranked zone picked in the report, highlighted on the map
  const [zonePick, setZonePick] = useState<{ year: number; rank: number; scope: "region" | "county" } | null>(null);
  // with a region selected, rank zones within it ("region") or show the county top 10 ("county")
  const [zoneScope, setZoneScopeState] = useState<"region" | "county">("region");
  const pickRegion = (geoid: string | null) => {
    setSelected(geoid);
    setFocusTick((t) => t + 1);
    // stay on the Regions tab; the user opens Analysis when they want it
  };

  // the map fills the freed space when the panel opens or closes
  useEffect(() => { map.current?.resize(); }, [showReport]);

  const places: PlaceMetrics[] = (placesFc?.features ?? []).map((f: GeoJSON.Feature) => f.properties as PlaceMetrics);
  const areas: PlaceMetrics[] = (areasFc?.features ?? []).map((f: GeoJSON.Feature) => f.properties as PlaceMetrics);
  // every selectable region: towns + areas + rural land
  const regions = [...places, ...areas];

  // load summary data
  useEffect(() => {
    const get = (u: string) => fetch(u).then((r) => r.json());
    Promise.all([get(DATA.stats), get(DATA.places), get(DATA.arrows), get(DATA.recZones), get(DATA.recommend),
      get(DATA.recRegionZones), get(DATA.areas)]).then(
      ([s, p, a, rz, rec, rrz, ar]) => {
        setAreasFc(ar);
        setStats(s);
        // rank labels for every year's zones (the map filters them to the slider year)
        const recLabels: GeoJSON.FeatureCollection = {
          type: "FeatureCollection",
          features: Object.entries((rec as Recommend).by_year).flatMap(([yr, v]) => v.zones.map((z) => ({
            type: "Feature" as const, properties: { rank: z.rank, year: Number(yr) },
            geometry: { type: "Point" as const, coordinates: [z.lon, z.lat] },
          }))),
        };
        // each region's own zone ranks
        const recRegionLabels: GeoJSON.FeatureCollection = {
          type: "FeatureCollection",
          features: Object.entries((rec as Recommend).by_year).flatMap(([yr, v]) =>
            Object.entries(v.regional ?? {}).flatMap(([geoid, zs]) => zs.map((z) => ({
              type: "Feature" as const, properties: { rank: z.rank, year: Number(yr), GEOID: geoid },
              geometry: { type: "Point" as const, coordinates: [z.lon, z.lat] },
            })))),
        };
        setExtra({ arrows: a, recZones: rz, recLabels, recRegionZones: rrz, recRegionLabels });
        setRecommend(rec);
        fireExponent = (rec as Recommend).fire_exponent ?? fireExponent;
        contractPenalty = (rec as Recommend).contract_penalty ?? contractPenalty;
        setPlacesFc(p);
      },
    );
  }, []);

  // create main map
  useEffect(() => {
    if (!placesFc || !extra || !areasFc || map.current || !mapDiv.current) return;
    const m = new MlMap({
      container: mapDiv.current, style: BASEMAP_STYLE, center: INITIAL_VIEW.center, zoom: INITIAL_VIEW.zoom,
      attributionControl: { compact: true },
    });
    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __map: MlMap }).__map = m; // debugging handle
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new ScaleControl({ unit: "imperial" }), "top-left");
    m.on("load", () => {
      addDataLayers(m, placesFc, true, extra);
      addUtilityLines(m);
      addAreaLayers(m, areasFc);
      setReady(true);
    });
    m.on("zoom", () => setZoom(m.getZoom()));

    const popup = new Popup({ maxWidth: "300px" });
    const clickable = ["buildings-fill", "power-lines", "gas-lines", "arrows-minor", "arrows-major", "arrows-minor-infill", "arrows-major-infill",
      "rec-region-fill", "rec-zones-fill", "rec-cells", "fires-fill", "flood-fill", "plans-fill", "water-fill", "sewer-line", "places-fill"];
    m.on("click", (e) => {
      const feats = m.queryRenderedFeatures(e.point, { layers: clickable.filter((l) => m.getLayer(l)) });
      const hit = (...ids: string[]) => feats.find((f) => ids.includes(f.layer.id));
      const b = hit("buildings-fill");
      const arrow = hit("arrows-minor", "arrows-major", "arrows-minor-infill", "arrows-major-infill");
      const recCell = hit("rec-cells");
      const zoneHit = hit("rec-region-fill", "rec-zones-fill");
      const fire = hit("fires-fill");
      const flood = hit("flood-fill");
      const plan = hit("plans-fill");
      const line = hit("power-lines", "gas-lines");
      const svc = feats.filter((f) => ["water-fill", "sewer-line"].includes(f.layer.id));
      const place = m.getZoom() >= 9.5 ? hit("places-fill") : undefined;
      if (b) popup.setLngLat(e.lngLat).setHTML(buildingPopup(b)).addTo(m);
      else if (line) popup.setLngLat(e.lngLat).setHTML(utilityPopup(line)).addTo(m);
      else if (arrow) popup.setLngLat(e.lngLat).setHTML(arrowPopup(arrow)).addTo(m);
      else if (zoneHit) zoneClickRef.current(zoneHit);
      else if (recCell) {
        const zone = m.getSource("rec-zones")
          ? m.querySourceFeatures("rec-zones").find((z) => {
            const g = z.geometry as GeoJSON.Polygon;
            return z.properties?.year === recYearFor(yearRef.current) && g
              && pointInRing([e.lngLat.lng, e.lngLat.lat], g.coordinates?.[0] ?? []);
          })
          : undefined;
        popup.setLngLat(e.lngLat).setHTML(recPopup(recCell, zone)).addTo(m);
      }
      else if (fire) popup.setLngLat(e.lngLat).setHTML(firePopup(fire)).addTo(m);
      else if (flood) popup.setLngLat(e.lngLat).setHTML(floodPopup(flood)).addTo(m);
      else if (plan) popup.setLngLat(e.lngLat).setHTML(planPopup(plan)).addTo(m);
      else if (svc.length) popup.setLngLat(e.lngLat).setHTML(servicePopup(svc)).addTo(m);
      else if (place) setSelected(String(place.properties.GEOID));
    });
    clickable.forEach((l) => {
      m.on("mouseenter", l, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", l, () => (m.getCanvas().style.cursor = ""));
    });
    return () => {
      m.remove();
      map.current = null;
    };
  }, [placesFc, extra, areasFc]);

  // clicking a ranked zone on the map: open Analysis on that zone (refs keep the map's click handler current)
  const zoneClickRef = useRef<(f: MapGeoJSONFeature) => void>(() => {});
  zoneClickRef.current = (f) => {
    const region = f.layer.id === "rec-region-fill";
    const pick = { year: Number(f.properties.year), rank: Number(f.properties.rank),
      scope: region ? "region" as const : "county" as const };
    setPanel("report");
    setZonePick(pick);
    const feat = zoneFeature(pick);
    if (feat) map.current?.fitBounds(bboxOf(feat.geometry), { padding: 80, maxZoom: 14, duration: 1000 });
  };
  const yearRef = useRef(year);
  yearRef.current = year;

  // default selection
  useEffect(() => {
    if (ready && places.length && selected === null) {
      const d = places.find((p) => p.name === DEFAULT_PLACE);
      if (d) setSelected(d.GEOID);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, placesFc]);

  // year / fire window
  useEffect(() => {
    if (!ready || !map.current) return;
    applyYear(map.current, year, fireWindow);
  }, [ready, year, fireWindow]);

  // layer visibility
  useEffect(() => {
    if (ready && map.current) setVisibility(map.current, vis);
  }, [ready, vis]);

  // selected place: highlight + zoom
  const prevSel = useRef<string | null>(null);
  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !placesFc || !areasFc) return;
    const isPlace = (id: string | null) => !!id && placesFc.features.some((x) => x.properties?.GEOID === id);
    if (isPlace(prevSel.current)) m.setFeatureState({ source: "places", id: prevSel.current! }, { selected: false });
    prevSel.current = selected;
    if (!selected) {
      // whole county: fit every area in view
      setRegionHighlight(m, null);
      const all = areasFc.features.filter((x) => x.properties?.kind === "Area");
      if (all.length) {
        const bb = all.map((x) => bboxOf(x.geometry)).reduce((a, b) => a.extend(b));
        m.fitBounds(bb, { padding: 30, duration: 1200 });
      } else m.flyTo({ center: INITIAL_VIEW.center, zoom: INITIAL_VIEW.zoom });
      return;
    }
    if (isPlace(selected)) m.setFeatureState({ source: "places", id: selected }, { selected: true });
    const f = [...placesFc.features, ...areasFc.features].find((x: GeoJSON.Feature) => x.properties?.GEOID === selected);
    setRegionHighlight(m, f ?? null);
    if (f) m.fitBounds(bboxOf(f.geometry), { padding: 60, maxZoom: 14, duration: 1200 });
  }, [ready, selected, placesFc, areasFc, focusTick]);

  // county structure (area boundaries) while browsing regions or when an area is selected
  const selKind = regions.find((r) => r.GEOID === selected)?.kind;
  useEffect(() => {
    if (ready && map.current) showAreas(map.current, panel === "regions" || selKind === "Area" || selKind === "Rural");
  }, [ready, panel, selKind]);

  // zone highlight: cleared when the region or the prediction year changes
  useEffect(() => { setZonePick(null); }, [selected, recYearFor(year), zoneScope]);
  const regionScope = selected && zoneScope === "region" ? selected : null;
  const zoneFeature = (pick: typeof zonePick) => {
    if (!pick || !extra) return null;
    const fc = pick.scope === "region" ? extra.recRegionZones : extra.recZones;
    return fc.features.find((x) => x.properties?.year === pick.year && x.properties?.rank === pick.rank
      && (pick.scope === "county" || x.properties?.GEOID === selected)) ?? null;
  };
  useEffect(() => {
    if (ready && map.current) setZoneHighlight(map.current, zoneFeature(zonePick));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, zonePick]);
  useEffect(() => {
    if (ready && map.current) setZoneScope(map.current, year, regionScope);
  }, [ready, year, regionScope]);

  // play animation
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setYear((y) => {
        if (y >= YEAR_MAX) {
          setPlaying(false);
          return y;
        }
        return y + 1;
      });
    }, 900);
    return () => clearInterval(t);
  }, [playing]);

  const [hoverLayer, setHoverLayer] = useState<LayerKey | null>(null);
  const toggle = (k: LayerKey) => setVis((v) => ({ ...v, [k]: !v[k] }));

  return (
    <div className={`app${showReport ? " with-report" : ""}`}>
      <aside className="side">
        <div className="brand">
          <h1>Project Marco Polo</h1>
          <p>Where California is building, and how close it is to wildfire and flooding.</p>
        </div>

        <section>
          <h3>Layers</h3>
          <div className="layer-grid">
            <button type="button" className="layer-btn all-off" aria-label="Turn all layers off"
              title="Turn all layers off (terrain shading stays on)"
              onClick={() => setVis((v) => Object.fromEntries(Object.keys(v).map((k) => [k, false])) as Visibility)}
              onMouseEnter={() => setHoverLayer(null)}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.6 3.6" />
                <path d="M6.6 6.6A17 17 0 0 0 2.5 12s3.5 7 9.5 7a9.6 9.6 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
              </svg>
              <span className="layer-short">All off</span>
            </button>
            {LAYER_LABELS.map(([k, short, name, src]) => (
              <button key={k} type="button" className={`layer-btn${vis[k] ? " on" : ""}`}
                aria-pressed={vis[k]} aria-label={name} title={`${name}\n${src}`} onClick={() => toggle(k)}
                onMouseEnter={() => setHoverLayer(k)} onMouseLeave={() => setHoverLayer(null)}
                onFocus={() => setHoverLayer(k)} onBlur={() => setHoverLayer(null)}>
                <LayerIcon layer={k} />
                <span className="layer-short">{short}</span>
              </button>
            ))}
          </div>
          {(() => {
            const info = LAYER_LABELS.find(([k]) => k === hoverLayer);
            return (
              <div className="layer-info">
                {info
                  ? <><b>{info[2]}</b>{vis[info[0]] ? " · on" : " · off"}<small>{info[3]}</small></>
                  : <small>Click an icon to show or hide a layer. Hover for details.</small>}
              </div>
            );
          })()}
        </section>

        {vis.buildings && (
          <section>
            <h3>Building colors</h3>
            {([["Residential", COLORS.buildingRamp], ["Commercial & industrial", COLORS.buildingRampCI],
               ["Other", COLORS.buildingRampOther]] as [string, [number, string][]][]).map(([label, stops]) => (
              <div key={label} className="type-key">
                <span className="type-name">{label}</span>
                <span className="type-ramp" style={{ background: `linear-gradient(90deg, ${stops.map(([, c]) => c).join(",")})` }} />
              </div>
            ))}
            <div className="type-key">
              <span className="type-name">Built in {year}</span>
              <span className="type-ramp" style={{ background: COLORS.builtThisYear }} />
            </div>
            <div className="caption">Lighter = older, darker = newer (≤1950 → 2025). Type comes from the county
              assessor parcel; “Other” = agricultural, public, institutional or no parcel match.</div>
          </section>
        )}

        {vis.fires && (
          <section>
            <h3>Fire history shown</h3>
            <div className="seg">
              {([["all", "All to date"], ["10y", "Last 10 yrs"], ["year", "Selected year"]] as [FireWindow, string][]).map(
                ([k, l]) => (
                  <button key={k} className={fireWindow === k ? "on" : ""} onClick={() => setFireWindow(k)}>{l}</button>
                ),
              )}
            </div>
          </section>
        )}

        {(vis.buildings || vis.fires || vis.fhsz || vis.flood || vis.plans || vis.places || vis.arrows || vis.recommend
          || vis.utilities || vis.services) && (
          <section className="legend">
            <h3>Legend</h3>
            {vis.buildings && (
              <>
                <div className="legend-title"><LayerIcon layer="buildings" size={15} />Buildings</div>
                <div className="caption" style={{ marginTop: 0 }}>Colored by type and age; see “Building colors” above.</div>
              </>
            )}
            {vis.fires && (
              <>
                <div className="legend-title"><LayerIcon layer="fires" size={15} />Fire perimeters</div>
                <div className="ramp" style={{ background: `linear-gradient(90deg, ${COLORS.fireOld}, ${COLORS.fireRecent})` }} />
                <div className="ramp-labels"><span>Older</span><span>Recent</span></div>
              </>
            )}
            {vis.fhsz && (
              <>
                <div className="legend-title"><LayerIcon layer="fhsz" size={15} />Fire Hazard Severity Zones</div>
                {Object.entries(COLORS.hazard).map(([k, c]) => (
                  <div key={k} className="sw"><i style={{ background: c }} />{k}</div>
                ))}
              </>
            )}
            {vis.flood && (
              <>
                <div className="legend-title"><LayerIcon layer="flood" size={15} />Flood zones</div>
                {(["floodway", "100yr", "500yr", "levee"] as const).map((k) => (
                  <div key={k} className="sw"><i style={{
                    background: COLORS.flood[k],
                    ...(k === "levee" ? { border: `1px dashed ${COLORS.floodLeveeLine}` } : {}),
                  }} />{FLOOD_LABEL[k]}</div>
                ))}
                <div className="sw"><i style={{ border: `2px dashed ${COLORS.flood200}`, background: "transparent" }} />DWR 200-year floodplain</div>
              </>
            )}
            {vis.utilities && (
              <>
                <div className="legend-title"><LayerIcon layer="utilities" size={15} />Power lines & gas pipelines</div>
                <div className="sw"><i className="line" style={{ background: COLORS.powerLine, height: 3 }} />Power line (thicker = higher kV)</div>
                <div className="sw"><i className="line" style={{ background: `repeating-linear-gradient(90deg, ${COLORS.gasLine} 0 6px, transparent 6px 9px)`, height: 3 }} />Gas transmission pipeline</div>
                <div className="caption" style={{ marginTop: 2 }}>Easements and setbacks along them count as unbuildable in the score.</div>
              </>
            )}
            {vis.services && (
              <>
                <div className="legend-title"><LayerIcon layer="services" size={15} />Water & sewer service</div>
                <div className="sw"><i style={{ background: `${COLORS.waterService}33`, border: `1px solid ${COLORS.waterService}` }} />Community water system</div>
                <div className="sw"><i style={{ border: `2px dashed ${COLORS.sewerService}`, background: "transparent" }} />Sewer service (city or county district)</div>
                <div className="caption" style={{ marginTop: 2 }}>Land within 500 m scores higher. Today's boundaries.</div>
              </>
            )}
            {vis.plans && (
              <>
                <div className="legend-title"><LayerIcon layer="plans" size={15} />General plan land use (c. 2004–2014)</div>
                {PLAN_CLASSES.filter(([code]) => code !== 9 && code !== -1).map(([code, label, color]) => (
                  <div key={code} className="sw"><i style={{ background: color }} />{label}</div>
                ))}
              </>
            )}
            {vis.places && (
              <>
                <div className="legend-title"><LayerIcon layer="places" size={15} />Cities: 10-yr residential growth</div>
                <div className="ramp" style={{
                  background: `linear-gradient(90deg, ${COLORS.growthRamp.map(([, c]) => c).join(",")})`,
                }} />
                <div className="ramp-labels"><span>0%</span><span>10%</span><span>25%</span><span>60%+</span></div>
              </>
            )}
            {vis.arrows && (
              <>
                <div className="legend-title"><LayerIcon layer="arrows" size={15} />Growth direction</div>
                <div className="sw"><i className="arrow-sw" />New homes (last 5 yrs) vs existing</div>
              </>
            )}
            {vis.recommend && (
              <>
                <div className="legend-title"><LayerIcon layer="recommend" size={15} />Where to build next: suitability</div>
                <div className="ramp" style={{
                  background: `linear-gradient(90deg, ${COLORS.suitRamp.map(([, c]) => c).join(",")})`,
                }} />
                <div className="ramp-labels"><span>Low</span><span>Medium</span><span>High</span></div>
                <div className="sw"><i style={{ border: `2px dashed ${COLORS.suitDark}`, background: "transparent" }} />Ranked zone (number = rank)</div>
              </>
            )}
          </section>
        )}
      </aside>

      <main className="mapwrap">
        <div ref={mapDiv} className="map" />
        {zoom < 12 && vis.buildings && <div className="hint">Buildings shown as dots; zoom in for footprints</div>}

        <div className="timebar">
          <button className="play" onClick={() => {
            if (!playing && year >= YEAR_MAX) setYear(YEAR_MIN);
            setPlaying((p) => !p);
          }} aria-label={playing ? "Pause" : "Play"}>{playing ? "❚❚" : "▶"}</button>
          <div className="year">{year}</div>
          <input type="range" min={YEAR_MIN} max={YEAR_MAX} value={year}
            onChange={(e) => { setPlaying(false); setYear(Number(e.target.value)); }} aria-label="Year" />
          <div className="ticks">
            {Array.from({ length: Math.floor((YEAR_MAX - YEAR_MIN) / 5) + 1 }, (_, i) => YEAR_MIN + i * 5).map((y) => (
              <span key={y} style={{ left: `${((y - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}%` }}>{y}</span>
            ))}
          </div>
        </div>
        <button className={`regions-toggle${panel === "regions" ? " on" : ""}`}
          onClick={() => setPanel((v) => (v === "regions" ? null : "regions"))}
          aria-expanded={panel === "regions"} aria-controls="report">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12Z" /><circle cx="12" cy="10" r="2.5" />
          </svg>
          {panel === "regions" ? "Hide regions" : "Regions"}
        </button>
        <button className={`report-toggle${panel === "report" ? " on" : ""}`}
          onClick={() => setPanel((v) => (v === "report" ? null : "report"))}
          aria-expanded={panel === "report"} aria-controls="report">
          {panel === "report" ? "Hide recommendations" : "Where to build next"}
        </button>
      </main>

      {stats && panel && (
        <aside className="report" id="report">
          <div className="panel-tabs" role="tablist">
            <button role="tab" aria-selected={panel === "regions"} className={panel === "regions" ? "on" : ""}
              onClick={() => setPanel("regions")}>Regions</button>
            <button role="tab" aria-selected={panel === "report"} className={panel === "report" ? "on" : ""}
              onClick={() => setPanel("report")}>Analysis</button>
            <button className="panel-close" aria-label="Close panel" onClick={() => setPanel(null)}>×</button>
          </div>
          {panel === "regions"
            ? <Regions stats={stats} regions={regions} selected={selected} onPick={pickRegion} />
            : <Report stats={stats} places={regions} selected={selected} year={year}
                arrows={extra?.arrows ?? null} recommend={recommend}
                selectedZone={zonePick?.year === recYearFor(year) ? zonePick.rank : null}
                zoneScope={zoneScope} onZoneScope={setZoneScopeState}
                onZone={(z, y) => {
                  const pick = { year: y, rank: z.rank, scope: regionScope ? "region" as const : "county" as const };
                  setZonePick(pick);
                  const f = zoneFeature(pick);
                  if (f) map.current?.fitBounds(bboxOf(f.geometry), { padding: 80, maxZoom: 14, duration: 1200 });
                  else map.current?.flyTo({ center: [z.lon, z.lat], zoom: 12.5, duration: 1200 });
                }}
                onSelect={setSelected} onPickYear={(y) => { setPlaying(false); setYear(y); }} />}
        </aside>
      )}
    </div>
  );
}
