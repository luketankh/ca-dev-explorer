import { useEffect, useRef, useState } from "react";
import {
  addProtocol, setWorkerUrl, LngLatBounds, Map as MlMap, NavigationControl, Popup, ScaleControl,
  type MapGeoJSONFeature,
} from "maplibre-gl";
import { Protocol } from "pmtiles";
import "maplibre-gl/dist/maplibre-gl.css";
// Bundle MapLibre's module worker (and its shared chunk) so it works in dev and production builds
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

import { BASEMAP_STYLE, COLORS, DATA, DEFAULT_PLACE, INITIAL_VIEW, YEAR_MAX, YEAR_MIN } from "./config";
import {
  addDataLayers, applyYear, COUNTY_METRICS, recYearFor, setCountyMetric, setNaip, setVisibility,
  type CountyMetric, type ExtraData, type FireWindow, type LayerKey, type Visibility,
} from "./layers";
import Report from "./components/Report";
import type { Context, PlaceMetrics, Recommend, Stats } from "./types";

setWorkerUrl(maplibreWorkerUrl);
const protocol = new Protocol();
addProtocol("pmtiles", protocol.tile);

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LAYER_LABELS: [LayerKey, string, string][] = [
  ["naip", "Aerial imagery (NAIP)", "USDA NAIP via Planetary Computer, zoom in to view"],
  ["buildings", "Buildings by type & year built", "Overture Maps + County Assessor + Microsoft 2020"],
  ["arrows", "Growth direction arrows", "Where homes built in the last 5 years went, vs existing homes"],
  ["recommend", "Where to build next (predicted each year)", "Growth momentum × flat open land × next to town × fire risk"],
  ["terrain", "Terrain (shaded relief)", "Elevation tiles: USGS 3DEP via AWS Terrain Tiles"],
  ["steep", "Steep ground", "Slope from USGS 3DEP 30 m: hillside 15–25%, too steep >25%"],
  ["fires", "Fire perimeters", "CAL FIRE FRAP (all years) + NIFC WFIGS (current season)"],
  ["firms", "Fire detection heatmap", "NASA FIRMS MODIS, 2001–2025"],
  ["fhsz", "Fire Hazard Severity Zones", "CAL FIRE, SRA 2024 / LRA 2025"],
  ["places", "Cities & growth choropleth", "Census TIGER places"],
  ["counties", "County comparison (statewide)", "Insurance: HearthMap/NBER · Crime: CA DOJ OpenJustice"],
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
  const zoneRows = zone ? `<tr><th>Zone size</th><td>${Number(z.acres).toLocaleString()} acres mostly open</td></tr>` : "";
  const cellRows = cell ? `
    <tr><th>Cell score</th><td><b>${esc(c.score)}</b> / 100</td></tr>
    <tr><th>Growth momentum</th><td>${pct(c.momentum)}</td></tr>
    <tr><th>Next to town</th><td>${pct(c.adjacency)}</td></tr>
    <tr><th>Terrain</th><td>${pct(c.flat_share)} flat (≤15% slope) · avg slope ${esc(c.slope_mean)}% · ${esc(c.elev_m)} m</td></tr>
    <tr><th>Open land</th><td>${Number(c.room) === 1 ? "Yes" : Number(c.room) > 0 ? "Partly built" : "Built up"}</td></tr>
    <tr><th>Farmland contract</th><td>${Number(c.contract) > 0 ? `${pct(c.contract)} under Williamson Act / Farmland Security Zone` : "None"}${
      Number(c.contract_ending) > 0 ? ` · ${pct(c.contract_ending)} contract ending within 5 yrs` : ""}</td></tr>
    <tr><th>Fire risk</th><td><b>${pct(c.fire_risk)}</b>${c.fhsz_class && c.fhsz_class !== "None" ? ` · FHSZ ${esc(c.fhsz_class)}` : ""}</td></tr>
    <tr><th>Fire history</th><td>${pct(c.fire_history)} (frequency ${pct(c.fire_freq)}, repeat burns ${pct(c.fire_reburn)},
      recent big fire ${pct(c.fire_last)})${c.years_since_fire !== null && c.years_since_fire !== undefined && c.years_since_fire !== ""
        ? ` · last fire ${Number(c.years_since_fire) === 0 ? "this year" : `${esc(c.years_since_fire)} yrs ago`}` : " · none on record"}</td></tr>` : "";
  return `<div class="pop"><h4>${head}</h4><table>${zoneRows}${cellRows}</table>
    <div class="pop-id">500 m cell. Score = 100 × momentum × open land × flat share × next to town × (1 − ${contractPenalty} × farmland contract) × (1 − fire risk)<sup>${fireExponent}</sup>.</div></div>`;
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

function countyPopup(f: MapGeoJSONFeature, ctx: Context | null) {
  const p = f.properties as Record<string, string | number | null>;
  const n = (v: unknown, d = 1) => (v === null || v === undefined || v === "" ? "–" : Number(v).toFixed(d));
  const total = ctx?.state.counties ?? 58;
  return `<div class="pop"><h4>${esc(p.county)} County</h4><table>
    <tr><th>Home insurance (2024)</th><td>${p.premium ? "$" + Number(p.premium).toLocaleString() + "/yr" : "no data"}
      ${p.premium_rank ? ` · #${p.premium_rank} of ${ctx?.state.premium_counties ?? 57}` : ""}</td></tr>
    <tr><th>Violent crime / 1k</th><td>${n(p.violent_per_1k)} · #${esc(p.violent_rank)} of ${total}</td></tr>
    <tr><th>Property crime / 1k</th><td>${n(p.property_per_1k)} · #${esc(p.property_rank)} of ${total}</td></tr>
    <tr><th>Crime change 2015–25</th><td>${n(p.crime_change_10yr_pct)}%</td></tr></table>
    <div class="pop-id">Rank 1 = highest. Crime excludes railroad police.</div></div>`;
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
  const [year, setYear] = useState(YEAR_MAX - 1); // start on the last complete year
  const [playing, setPlaying] = useState(false);
  const [fireWindow, setFireWindow] = useState<FireWindow>("all");
  const [vis, setVis] = useState<Visibility>({
    naip: false, buildings: true, arrows: true, fires: true, firms: false, fhsz: true, places: true,
    counties: true, recommend: true, terrain: true, steep: true,
  });
  const [recommend, setRecommend] = useState<Recommend | null>(null);
  const [extra, setExtra] = useState<ExtraData | null>(null);
  const [context, setContext] = useState<Context | null>(null);
  const [countyMetric, setCountyMetricState] = useState<CountyMetric>("premium");
  const [naipShown, setNaipShown] = useState<number | null>(null);
  const [naipError, setNaipError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(INITIAL_VIEW.zoom);

  const places: PlaceMetrics[] = (placesFc?.features ?? []).map((f: GeoJSON.Feature) => f.properties as PlaceMetrics);

  // load summary data
  useEffect(() => {
    const get = (u: string) => fetch(u).then((r) => r.json());
    Promise.all([get(DATA.stats), get(DATA.places), get(DATA.counties), get(DATA.arrows), get(DATA.context),
      get(DATA.recZones), get(DATA.recommend), get(DATA.steep)]).then(
      ([s, p, c, a, ctx, rz, rec, steep]) => {
        setStats(s);
        // rank labels for every year's zones (the map filters them to the slider year)
        const recLabels: GeoJSON.FeatureCollection = {
          type: "FeatureCollection",
          features: Object.entries((rec as Recommend).by_year).flatMap(([yr, v]) => v.zones.map((z) => ({
            type: "Feature" as const, properties: { rank: z.rank, year: Number(yr) },
            geometry: { type: "Point" as const, coordinates: [z.lon, z.lat] },
          }))),
        };
        setExtra({ counties: c, arrows: a, recZones: rz, recLabels, steep });
        setRecommend(rec);
        fireExponent = (rec as Recommend).fire_exponent ?? fireExponent;
        contractPenalty = (rec as Recommend).contract_penalty ?? contractPenalty;
        setContext(ctx);
        setPlacesFc(p);
      },
    );
  }, []);

  // create main map
  useEffect(() => {
    if (!placesFc || !extra || map.current || !mapDiv.current) return;
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
      setReady(true);
    });
    m.on("zoom", () => setZoom(m.getZoom()));

    const popup = new Popup({ maxWidth: "300px" });
    const clickable = ["buildings-fill", "arrows-minor", "arrows-major", "arrows-minor-infill", "arrows-major-infill",
      "rec-cells", "fires-fill", "places-fill", "counties-fill"];
    m.on("click", (e) => {
      const feats = m.queryRenderedFeatures(e.point, { layers: clickable.filter((l) => m.getLayer(l)) });
      const hit = (...ids: string[]) => feats.find((f) => ids.includes(f.layer.id));
      const b = hit("buildings-fill");
      const arrow = hit("arrows-minor", "arrows-major", "arrows-minor-infill", "arrows-major-infill");
      const recCell = hit("rec-cells");
      const fire = hit("fires-fill");
      const place = m.getZoom() >= 9.5 ? hit("places-fill") : undefined;
      const county = hit("counties-fill");
      if (b) popup.setLngLat(e.lngLat).setHTML(buildingPopup(b)).addTo(m);
      else if (arrow) popup.setLngLat(e.lngLat).setHTML(arrowPopup(arrow)).addTo(m);
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
      else if (place) setSelected(String(place.properties.GEOID));
      else if (county) popup.setLngLat(e.lngLat).setHTML(countyPopup(county, contextRef.current)).addTo(m);
    });
    clickable.forEach((l) => {
      m.on("mouseenter", l, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", l, () => (m.getCanvas().style.cursor = ""));
    });
    return () => {
      m.remove();
      map.current = null;
    };
  }, [placesFc, extra]);

  const yearRef = useRef(year);
  yearRef.current = year;
  const contextRef = useRef<Context | null>(null);
  contextRef.current = context;

  // statewide county comparison metric
  useEffect(() => {
    if (ready && map.current) setCountyMetric(map.current, countyMetric);
  }, [ready, countyMetric]);

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

  // NAIP imagery follows the slider year
  useEffect(() => {
    if (!ready || !map.current) return;
    setNaip(map.current, year, vis.naip)
      .then((v) => {
        setNaipShown(vis.naip ? v : null);
        setNaipError(null);
      })
      .catch((e) => setNaipError(String(e.message ?? e)));
  }, [ready, year, vis.naip]);

  // selected place: highlight + zoom
  const prevSel = useRef<string | null>(null);
  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !placesFc) return;
    if (prevSel.current) m.setFeatureState({ source: "places", id: prevSel.current }, { selected: false });
    prevSel.current = selected;
    if (!selected) {
      m.flyTo({ center: INITIAL_VIEW.center, zoom: INITIAL_VIEW.zoom });
      return;
    }
    m.setFeatureState({ source: "places", id: selected }, { selected: true });
    const f = placesFc.features.find((x: GeoJSON.Feature) => x.properties?.GEOID === selected);
    if (f) m.fitBounds(bboxOf(f.geometry), { padding: 60, maxZoom: 14, duration: 1200 });
  }, [ready, selected, placesFc]);

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

  const toggle = (k: LayerKey) => setVis((v) => ({ ...v, [k]: !v[k] }));

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <h1>CA Development Explorer</h1>
          <p>Where California is building, and how close it is to wildfire.</p>
        </div>

        <section>
          <h3>Layers</h3>
          {LAYER_LABELS.map(([k, label, src]) => (
            <label key={k} className="layer">
              <input type="checkbox" checked={vis[k]}
                onChange={() => toggle(k)} />
              <span>
                {label}
                <small>{src}</small>
              </span>
            </label>
          ))}
          {vis.naip && (
            <div className="note">
              {naipError ? `Imagery unavailable: ${naipError}` :
                zoom < 11 ? "Zoom in to see aerial imagery." :
                naipShown ? `Showing NAIP ${naipShown} (nearest flight at or before ${year}).` : "Loading imagery…"}
            </div>
          )}
        </section>

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

        {vis.counties && (
          <section>
            <h3>County comparison shows</h3>
            <div className="seg">
              {([["premium", "Insurance"], ["violent_per_1k", "Violent crime"], ["property_per_1k", "Property crime"]] as
                [CountyMetric, string][]).map(([k, l]) => (
                <button key={k} className={countyMetric === k ? "on" : ""} onClick={() => setCountyMetricState(k)}>{l}</button>
              ))}
            </div>
            {zoom > 8.5 && <div className="note">Zoom out to see all counties.</div>}
          </section>
        )}


        <section className="legend">
          <h3>Legend</h3>
          <div className="legend-title">Buildings</div>
          <div className="caption" style={{ marginTop: 0 }}>Colored by type and age; see “Building colors” above.</div>
          <div className="legend-title">Fire perimeters</div>
          <div className="ramp" style={{ background: `linear-gradient(90deg, ${COLORS.fireOld}, ${COLORS.fireRecent})` }} />
          <div className="ramp-labels"><span>Older</span><span>Recent</span></div>
          <div className="legend-title">Fire Hazard Severity Zones</div>
          {Object.entries(COLORS.hazard).map(([k, c]) => (
            <div key={k} className="sw"><i style={{ background: c }} />{k}</div>
          ))}
          <div className="legend-title">Cities: 10-yr residential growth</div>
          <div className="ramp" style={{
            background: `linear-gradient(90deg, ${COLORS.growthRamp.map(([, c]) => c).join(",")})`,
          }} />
          <div className="ramp-labels"><span>0%</span><span>10%</span><span>25%</span><span>60%+</span></div>
          <div className="legend-title">Growth direction</div>
          <div className="sw"><i className="arrow-sw" />New homes (last 5 yrs) vs existing</div>
          <div className="legend-title">Where to build next: suitability</div>
          <div className="ramp" style={{
            background: `linear-gradient(90deg, ${COLORS.suitRamp.map(([, c]) => c).join(",")})`,
          }} />
          <div className="ramp-labels"><span>Low</span><span>Medium</span><span>High</span></div>
          <div className="sw"><i style={{ border: `2px dashed ${COLORS.suitDark}`, background: "transparent" }} />Ranked zone (number = rank)</div>
          <div className="legend-title">Steep ground (slope)</div>
          <div className="sw"><i style={{ background: COLORS.hillside }} />Hillside 15–25%: costly to build</div>
          <div className="sw"><i style={{ background: COLORS.steep }} />Over 25%: generally not buildable</div>
          {vis.counties && (
            <>
              <div className="legend-title">Counties: {COUNTY_METRICS[countyMetric].label}</div>
              <div className="ramp" style={{
                background: `linear-gradient(90deg, ${COUNTY_METRICS[countyMetric].stops.map(([, c]) => c).join(",")})`,
              }} />
              <div className="ramp-labels">
                {COUNTY_METRICS[countyMetric].stops.filter((_, i) => i % 2 === 0).map(([v]) => (
                  <span key={v}>{COUNTY_METRICS[countyMetric].fmt(v)}</span>
                ))}
              </div>
            </>
          )}
        </section>
      </aside>

      <main className="mapwrap">
        <div ref={mapDiv} className="map" />
        {zoom < 12 && vis.buildings && <div className="hint">Zoom in to see individual buildings</div>}

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
      </main>

      {stats && (
        <Report stats={stats} places={places} selected={selected} year={year} context={context}
          arrows={extra?.arrows ?? null} recommend={recommend}
          onZone={(lon, lat) => map.current?.flyTo({ center: [lon, lat], zoom: 12.5, duration: 1200 })}
          onSelect={setSelected} onPickYear={(y) => { setPlaying(false); setYear(y); }} />
      )}
    </div>
  );
}
