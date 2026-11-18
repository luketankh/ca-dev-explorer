import { useEffect, useState } from "react";
import type { PlaceMetrics, RecZone, Recommend, Stats } from "../types";
import BuiltChart from "./BuiltChart";
import { recYearFor } from "../layers";

interface Props {
  stats: Stats;
  places: PlaceMetrics[];
  selected: string | null;
  year: number;
  arrows: GeoJSON.FeatureCollection | null;
  recommend: Recommend | null;
  onSelect: (geoid: string | null) => void;
  onPickYear: (y: number) => void;
  /** Rank of the highlighted zone in this year's prediction, if any. */
  selectedZone: number | null;
  /** With a region selected: its own zone ranking, or the county top 10. */
  zoneScope: "region" | "county";
  onZoneScope: (s: "region" | "county") => void;
  onZone: (zone: RecZone, year: number) => void;
}

const KIND_LABEL: Record<string, string> = {
  City: "Incorporated city", CDP: "Community (census-designated place)",
  Area: "Area (Census county division)", Rural: "Rural land outside the towns",
};

/** [layer, what it covers (area, years), known gaps] for the Data coverage table. */
const COVERAGE: [string, string, string][] = [
  ["Buildings", "Every building footprint in the county (Overture 2026, Microsoft 2020)",
    "Year built from the county assessor for ~90%; 8% (mostly rural) undated before 2020 (grey). 2016–2022 matches state housing estimates within ~5% county-wide; 2023 onwards is far from complete (about a third of new homes so far). Only ~47% of commercial/industrial buildings have a year"],
  ["Growth arrows", "Every year 2000–2026: clusters of homes built in the 5 years to the slider year",
    "Residential only. Needs 20+ new homes close together, so quiet towns and scattered rural building get none"],
  ["Build next (green cells, zones)", "A prediction for every year 2000–2025 (2026 shows 2025), whole county, 500 m cells",
    "Cells only show where they score 5+; they need recent home building nearby. Delta Primary Zone and water excluded"],
  ["Fire history", "CAL FIRE perimeters, all years on record (fires 10+ acres), plus this season; NASA satellite detections 2001–2025",
    "Small fires under 10 acres are missing from the perimeter record"],
  ["Fire hazard zones", "CAL FIRE 2024 (state areas) / 2025 (local areas)", "Today's map, also used for past years"],
  ["Flood", "FEMA flood maps (effective 2009–2016) and DWR 200-year floodplain", "Shown, not scored. Older maps; levee status can change"],
  ["Utilities", "Power lines 60 kV+, gas transmission pipelines, community water systems, city and county sewer",
    "Today's boundaries, used for past years too. No local distribution lines or pipe capacity"],
  ["Land use", "City and county general plans, c. 2004–2014", "Not current zoning; shown, not scored"],
  ["Terrain", "USGS 3DEP elevation (slope at 25 m)", "None significant"],
  ["Regions", "County, 9 Census county divisions, 8 cities, 20 communities, rural land", "Nothing below town level yet"],
];

const fmt = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? "–" : v.toLocaleString(undefined, { maximumFractionDigits: digits });
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);

function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
      {note && <div className="kpi-note">{note}</div>}
    </div>
  );
}

/** Score factors in display order: [key, short label, what 100 means]. */
const FACTORS: [string, string, string][] = [
  ["momentum", "Grow", "right where recent building is heading"],
  ["open_land", "Open", "mostly unbuilt land"],
  ["flat", "Flat", "slope under 15%"],
  ["next_to_town", "Town", "within 1 km of a town"],
  ["farmland", "Farm", "no farmland (Williamson Act) contract"],
  ["water_sewer", "W/S", "water and sewer within 500 m"],
  ["power_gas", "Power", "no power-line or gas-pipeline easement"],
  ["usable_land", "Canal", "no water, canal right-of-way or floodway"],
  ["flood", "Flood", "outside the 100- and 200-year floodplains"],
  ["land_use", "Plan", "not planned for industry"],
  ["fire", "Fire", "no wildfire risk"],
];

const FULL_NAME: Record<string, string> = {
  momentum: "Growth momentum", open_land: "Open land", flat: "Flat ground", next_to_town: "Next to town",
  farmland: "Farmland contracts", water_sewer: "Water & sewer", power_gas: "Power lines & gas pipelines",
  usable_land: "Water, canals & floodway", flood: "Flood", land_use: "General plan", fire: "Fire risk",
};

/** One small heat-coloured cell per factor, 0-100 (100 = no penalty). */
function FactorStrip({ f }: { f: Record<string, number> }) {
  return (
    <div className="factors" aria-label="Score factors, 0 to 100">
      {FACTORS.map(([k, label, full]) => {
        const v = f[k] ?? 0;
        return (
          <span key={k} className="factor" title={`${FULL_NAME[k]}: ${v}/100. 100 = ${full}.`}>
            <span className="factor-val" style={{ background: `hsl(${Math.round(v * 1.2)}, 55%, ${92 - v * 0.12}%)` }}>{v}</span>
            <span className="factor-lab">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

/** Plain-words water/sewer access for a zone (0-1 averages over its cells). */
const utilityNote = (water: number, sewer: number) => {
  const say = (v: number, what: string) => (v >= 0.9 ? `${what} nearby` : v <= 0.1 ? `no ${what} within 3 km` : `${what} partly nearby`);
  return water >= 0.9 && sewer >= 0.9 ? "water & sewer nearby" : `${say(water, "water")}, ${say(sewer, "sewer")}`;
};

/** Share in FEMA's 100-year floodplain, floodway included (the pipeline stores them as separate classes). */
const fema100 = (a: { flood_100yr_share?: number; flood_floodway_share?: number }) =>
  (a.flood_100yr_share ?? 0) + (a.flood_floodway_share ?? 0);

export default function Report({ stats, places, selected, year, arrows, recommend, onSelect, onPickYear,
  selectedZone, zoneScope, onZoneScope, onZone }: Props) {
  const [chartUse, setChartUse] = useState<"res" | "ci">("res");
  // bring the picked zone's row into view (e.g. after clicking the zone on the map)
  useEffect(() => {
    if (selectedZone !== null) {
      document.querySelector(`tr[data-zone="${selectedZone}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [selectedZone]);
  const recYear = recYearFor(year);
  const rec = recommend?.by_year[String(recYear)];
  const ranked = [...places]
    .filter((p) => (p.kind === "City" || p.kind === "CDP") && p.opportunity_score !== null)
    .sort((a, b) => (b.opportunity_score ?? 0) - (a.opportunity_score ?? 0));
  const p = places.find((x) => x.GEOID === selected);
  // the county division a town or rural remainder belongs to
  const parent = p?.area ? places.find((x) => x.GEOID === p.area && x.kind === "Area") : undefined;
  const isTown = p?.kind === "City" || p?.kind === "CDP";
  const area = p ?? { ...stats.county, name: stats.county.name };
  // a selected region shows its own ranking (cells within 1.5 km of it, ranked locally) or the county top 10
  const regionMode = !!p && zoneScope === "region";
  const zones = rec ? (regionMode ? rec.regional?.[p!.GEOID] ?? [] : rec.zones) : [];
  const series = p ? stats.places[p.GEOID] : stats.county;
  const builtToYear =
    series.before + series.yearly.reduce((s, v, i) => (stats.years[i] <= year ? s + v : s), 0);
  type GrowthArea = {
    window: string; shift_km: number; direction: string | null; new_homes: number; bearing: number | null;
    kind: "arrow" | "infill"; name: string;
  };
  // growth areas (clusters of new homes) in this place, or the largest ones county-wide
  const growth = (arrows?.features ?? [])
    .map((f) => f.properties as GrowthArea & { year: number; GEOID: string | null })
    .filter((g) => g.year === year && (!p ? true
      : p.kind === "Area" ? places.some((t) => t.GEOID === g.GEOID && t.area === p.GEOID)
        : g.GEOID === p.GEOID))
    .sort((a, b) => b.new_homes - a.new_homes);
  const growthShown = growth.slice(0, p ? 6 : 5);
  // homes built in the 5 years to the slider year (explains a missing arrow)
  const homesWindow = series.yearly.reduce((t, v, i) => (stats.years[i] > year - 5 && stats.years[i] <= year ? t + v : t), 0);

  return (
    <div className="report-body">
      <header className="report-head">
        {p && (
          <nav className="crumbs" aria-label="Region">
            <button className="link" onClick={() => onSelect(null)}>San Joaquin County</button>
            {parent && parent.GEOID !== p.GEOID && <> › <button className="link" onClick={() => onSelect(parent.GEOID)}>{parent.name}</button></>}
          </nav>
        )}
        <h2>{area.name}</h2>
        <div className="sub">
          {p ? KIND_LABEL[p.kind] : "MVP study area: 9 areas, 8 cities, 20 communities and the rural land between them"}
          {p?.rank ? ` · Opportunity rank #${p.rank} of ${ranked.length}` : ""}
          {p?.kind === "Area" && p.towns ? ` · Towns: ${p.towns}` : ""}
        </div>
      </header>

      {recommend && rec && (
        <section>
          <h3>Where to build next · predicted in {recYear}</h3>
          <div className="caption" style={{ marginTop: 0 }}>
            Using only data available in {recYear}: mostly open land just ahead of where homes went in {rec.window},
            next to existing towns, on flat ground, not locked up in farmland contracts, with higher wildfire risk
            penalised progressively harder.
            Move the year slider to see each year's prediction. Click a zone to fly there.
            {year > recYear && ` (No prediction for ${year} yet; showing the latest, ${recYear}.)`}
          </div>
          {rec.next && rec.next.homes_built > 0 && (
            <div className="what-next">
              <b>What happened next:</b> of the {fmt(rec.next.homes_built)} homes built {rec.next.period},{" "}
              <b>{rec.next.in_zones_pct}%</b> landed in these zones, which cover only {rec.next.zone_area_pct}% of the county.
              {!rec.next.complete && " This period isn't over yet, and recent assessor records are incomplete, so treat this as early."}
            </div>
          )}
          {p && (
            <div className="seg zone-scope" role="tablist" aria-label="Zone ranking">
              <button role="tab" aria-selected={regionMode} className={regionMode ? "on" : ""}
                onClick={() => onZoneScope("region")}>Best in {p.name}</button>
              <button role="tab" aria-selected={!regionMode} className={!regionMode ? "on" : ""}
                onClick={() => onZoneScope("county")}>County top 10</button>
            </div>
          )}
          {regionMode && (
            <div className="caption">
              {zones.length
                ? `${p!.name}'s best ${zones.length === 1 ? "zone" : `${zones.length} zones`} in ${recYear}, ranked within ${p!.name}${isTown
                  ? ` and up to ${((recommend.utilities?.region_buffer_m ?? 1500) / 1000).toFixed(1)} km around it` : ""}. “County #” is the zone's place in the county top 10, if it made it.`
                : `No green cells or zones in or around ${p!.name} in ${recYear}. Cells only score (and show) where homes were
                   built nearby in ${rec.window}: the model extends recent growth, so places with little new building get no score,
                   even if the land itself is fine. Constraints (farmland contracts, steep ground, power-line easements, no water or sewer nearby, fire risk) can also
                   push scores below the cut-off.`}
            </div>
          )}
          {zones.length > 0 && <div className="caption">Each box is a factor from 0 to 100 (hover for what it
            means). <b>Score = the factors multiplied</b>, e.g. 69 × 93 × 56 … → 33. Zones are ranked by total score
            (bigger zones count more), so the order can differ from the score.</div>}
          {zones.length > 0 && <table className="rank rec">
            <thead>
              <tr><th>#</th><th>Zone</th><th className="num">Open acres</th><th className="num" title="The zone's factors multiplied, 0-100">Score</th></tr>
            </thead>
            <tbody>
              {zones.map((z) => (
                <tr key={z.rank} data-zone={z.rank} className={z.rank === selectedZone ? "sel" : ""} onClick={() => onZone(z, recYear)}
                  aria-selected={z.rank === selectedZone}>
                  <td><span className="rec-rank">{z.rank}</span></td>
                  <td>{z.label}
                    {regionMode && (z.county_rank
                      ? <span className="county-rank">County #{Math.round(z.county_rank)}</span>
                      : <span className="county-rank muted">Not in county top 10</span>)}
                    <div className="kpi-note">Avg slope {fmt(z.slope_mean, 1)}% · {pct(z.flat_share)} flat
                      {z.fhsz !== "None" ? ` · Hazard zone: ${z.fhsz}` : ""}
                      {z.contract_share >= 0.05 ? ` · ${pct(z.contract_share)} under farmland contract` : ""}
                      {z.contract_ending_share >= 0.05 ? ` · ${pct(z.contract_ending_share)} contract ending` : ""}
                      {fema100(z) >= 0.05 ? ` · ${pct(fema100(z))} in 100-yr floodplain` : ""}
                      {(z.flood_levee_share ?? 0) >= 0.05 ? ` · ${pct(z.flood_levee_share)} levee-protected` : ""}
                      {(z.flood_200yr_share ?? 0) >= 0.05 ? ` · ${pct(z.flood_200yr_share)} in 200-yr floodplain` : ""}
                      {(z.easement_share ?? 0) >= 0.02 ? ` · ${pct(z.easement_share)} in power/gas easements` : ""}
                      {z.water_access !== undefined ? ` · ${utilityNote(z.water_access, z.sewer_access ?? 0)}` : ""}
                      {(z.plan_nonres_share ?? 0) >= 0.05 ? ` · ${pct(z.plan_nonres_share)} planned industrial` : ""}</div>
                    {z.factors && <FactorStrip f={z.factors} />}</td>
                  <td className="num">{fmt(z.acres)}</td>
                  <td className="num"><b>{fmt(z.score ?? z.score_sum / Math.max(z.cells, 1))}</b></td>
                </tr>
              ))}
            </tbody>
          </table>}
          <details className="method">
            <summary>How this is calculated, and how well it worked in the past</summary>
            <p>The county is cut into {recommend.cell_m} m squares. Each square gets 11 factors, each from 0 to 100
              (100 = nothing holding it back). <b>The score is the factors multiplied together.</b> One weak factor
              pulls the whole score down; it can't be made up for by another.</p>
            <table className="rank method-table">
              <thead><tr><th>Factor</th><th>100 means</th><th>Lower when</th></tr></thead>
              <tbody>
                <tr><td><b>Grow</b></td><td>Right where recent building is heading</td><td>Away from the growth arrows</td></tr>
                <tr><td><b>Open</b></td><td>Mostly unbuilt</td><td>Already built on (warehouse lots count 3× their roof)</td></tr>
                <tr><td><b>Flat</b></td><td>Slope under {recommend.terrain.slope_ok_pct}%</td><td>Hillside; over {recommend.terrain.slope_max_pct}% counts as 0</td></tr>
                <tr><td><b>Town</b></td><td>Within 1 km of a town</td><td>Further out; 0 at 4 km</td></tr>
                <tr><td><b>Farm</b></td><td>No farmland contract</td><td>Under a Williamson Act contract (loses {Math.round(recommend.contract_penalty * 100)}%)</td></tr>
                <tr><td><b>W/S</b></td><td>Water and sewer within {recommend.utilities?.full_m ?? 500} m</td><td>Further away; 50 at 3 km+</td></tr>
                <tr><td><b>Power</b></td><td>No power line or gas pipeline</td><td>Inside their easements (15–75 m either side)</td></tr>
                <tr><td><b>Canal</b></td><td>No water, canal or floodway</td><td>Water, canal right-of-way (30 m) or FEMA floodway</td></tr>
                <tr><td><b>Flood</b></td><td>Outside the floodplains</td><td>In the 100- or 200-year floodplain (loses {Math.round((recommend.flood_penalty ?? 0.3) * 100)}%)</td></tr>
                <tr><td><b>Plan</b></td><td>Not planned for industry</td><td>Planned Industrial in the general plan (loses 80%)</td></tr>
                <tr><td><b>Fire</b></td><td>No wildfire risk</td><td>Hazard zones and past fires nearby; 25% risk → 56</td></tr>
              </tbody>
            </table>
            <p><b>Zones:</b> touching squares scoring {recommend.threshold}+ are joined into a zone. A zone's factors are the
              averages of its squares, and its score is those factors multiplied. Zones are <b>ranked by total
              score</b> (all their squares added up), so a big good zone beats a small slightly better one.
              The Delta Primary Zone, mostly-water squares and very steep land are left out.</p>
            <p><b>Backtest:</b> using only data available at the time, the top 5% of the county picked by the model
              contained this share of the homes actually built in the next five years. Buildings with no recorded year
              only count as built from {recommend.undated_from}, when satellite footprints confirm them. The hazard
              zones (2024) and terrain are today's maps.</p>
            <table className="rank">
              <thead><tr><th>As of</th><th>Homes built</th><th className="num">Model</th><th className="num">No water &amp; sewer</th><th className="num">Edge-of-town rule</th><th className="num">Random</th></tr></thead>
              <tbody>
                {recommend.backtest.map((t) => (
                  <tr key={t.as_of}>
                    <td>{t.as_of}</td><td>{t.predicts}: {fmt(t.homes_built)}</td>
                    <td className="num"><b>{t.captured_pct}%</b></td>
                    <td className="num">{t.no_utilities_pct === undefined ? "–" : `${t.no_utilities_pct}%`}</td>
                    <td className="num">{t.baseline_pct}%</td>
                    <td className="num">{t.top_area_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>Flood zones are shown on the map and next to each zone, but are not part of the score yet.
              Not yet included: zoning and general plans, sewer/water plant capacity, land prices and ownership.
              Treat zones as places to investigate, not approvals.</p>
          </details>
        </section>
      )}

      <section>
        <h3>Development</h3>
        <div className="kpis">
          <Kpi label="10-yr residential growth" value={area.growth_10yr_pct === null ? "–" : `${fmt(area.growth_10yr_pct, 1)}%`}
            note="homes built 2016–25 ÷ stock in 2015" />
          <Kpi label="Homes built 2016–2025" value={fmt(area.res_built_2016_2025)} />
          <Kpi label="New since 2020 snapshot" value={fmt(area.new_since_2020_snapshot)}
            note="buildings with no assessor year, missing from MS 2020 footprints" />
          <Kpi label={`Dated homes by ${year}`} value={fmt(builtToYear)} />
        </div>
        <div className="kpis" style={{ marginTop: 8 }}>
          <Kpi label="Commercial & industrial built 2016–25" value={`${fmt(area.ci_sqft_2016_2025 / 1e6, 1)}M sq ft`}
            note={`building footprint · only ${pct(area.ci_dated_share)} of C&I buildings have a year`} />
          <Kpi label="Commercial & industrial buildings" value={fmt(area.ci_buildings)} />
        </div>
        <div className="chart-head">
          <div className="chart-title">{chartUse === "res" ? "Residential buildings by year built" : "Commercial & industrial footprint by year built"}</div>
          <div className="seg small">
            <button className={chartUse === "res" ? "on" : ""} onClick={() => setChartUse("res")}>Homes</button>
            <button className={chartUse === "ci" ? "on" : ""} onClick={() => setChartUse("ci")}>Commercial & ind.</button>
          </div>
        </div>
        <BuiltChart years={stats.years} values={chartUse === "res" ? series.yearly : series.yearly_ci_sqft}
          unit={chartUse === "res" ? "homes built" : "sq ft of footprint built"} selectedYear={year} onPickYear={onPickYear} />
        <div className="caption">Click a bar to jump the map to that year. 2023 onwards is far
          from complete in assessor records (about a third of the homes the state counts), so recent bars and growth read low{chartUse === "ci" ? "; many commercial buildings have no year at all" : ""}.</div>
        <div className="chart-title">
          Growth areas, {year - 4}–{year}
          {growth.length > 0 && <span className="muted"> · {growth.length} cluster{growth.length > 1 ? "s" : ""}
            {growth.length > growthShown.length ? `, ${growthShown.length} largest shown` : ""}</span>}
        </div>
        {growthShown.length ? (
          <ul className="growth-list">
            {growthShown.map((g, i) => (
              <li key={i}>
                {g.kind === "infill" || g.bearing === null
                  ? <span className="dot-infill" />
                  : <span className="arrow-sw" style={{ transform: `rotate(${g.bearing - 90}deg)` }} />}
                <span>
                  <b>{fmt(g.new_homes)}</b> homes{!p && ` in ${g.name}`} ·{" "}
                  {g.kind === "infill" ? "infill" : <>{fmt(g.shift_km, 1)} km {g.direction} of existing homes</>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="caption">
            No growth arrow: {fmt(homesWindow)} home{homesWindow === 1 ? "" : "s"} built {p ? "here" : "in the county"} in{" "}
            {year - 4}–{year}. An arrow needs a cluster of 20+ new homes close together (within ~350 m of each other).
          </div>
        )}
      </section>

      <section>
        <h3>Wildfire exposure</h3>
        <div className="kpis">
          <Kpi label={`Fires within ${stats.method.fire_buffer_km} km since ${stats.method.fire_since}`}
            value={fmt(area.fires_10km_since_2000)} />
          <Kpi label="Acres burned within 10 km" value={fmt(area.burned_acres_10km_since_2000)} />
          <Kpi label="Nearest fire since 2000" value={area.nearest_fire_km === null ? "–" : `${fmt(area.nearest_fire_km, 1)} km`} />
          <Kpi label="Wildland fire detections, 10 km" value={fmt(area.firms_wildland_10km_since_2001)}
            note={`NASA FIRMS 2001–25, inside hazard zones (${fmt(area.firms_10km_since_2001)} incl. farm burning)`} />
          <Kpi label="Area in High/Very High FHSZ" value={pct(area.fhsz_high_vhigh_share)} />
          <Kpi label="Buildings in any hazard zone" value={pct(area.buildings_in_fhsz_share)} />
        </div>
        <div className="chart-title">Fire history (frequency &amp; recency, 10 km)</div>
        <div className="kpis">
          <Kpi label="Most recent fire nearby"
            value={area.last_fire_year ? `${area.last_fire_year}` : "None on record"}
            note={area.last_fire_name ? `${area.last_fire_name} · ${fmt(area.fires_on_record)} fires (10+ acres) on record` : undefined} />
          <Kpi label="Fire history score" value={pct(area.fire_history)}
            note="average of the three parts below; older fires count less (half-life 10 yrs)" />
        </div>
        <div className="fire-parts">
          {([["Frequency", area.fire_freq, "separate fires nearby, age-weighted"],
             ["Repeat burning", area.fire_reburn, "share of land burned, repeat burns count again"],
             ["Recent big fire", area.fire_last, "how recently a fire burned ≥1% of the area"],
             ["Satellite detections", area.fire_detections, "wildland hot spots, age-weighted"]] as [string, number, string][])
            .map(([label, v, note]) => (
              <div key={label} className="fire-part">
                <div className="fire-part-head"><span>{label}</span><b>{pct(v)}</b></div>
                <div className="meter"><i style={{ width: `${Math.round((v ?? 0) * 100)}%` }} /></div>
                <div className="kpi-note">{note}</div>
              </div>
            ))}
        </div>
      </section>

      {area.flood_100yr_share !== undefined && (
        <section>
          <h3>Flood exposure</h3>
          <div className="kpis">
            <Kpi label="Land in FEMA 100-year floodplain" value={pct(fema100(area))}
              note="1% chance a year · lenders require flood insurance" />
            <Kpi label="Floodway" value={pct(area.flood_floodway_share)} note="river channel area, effectively unbuildable" />
            <Kpi label="Levee-protected land" value={pct(area.flood_levee_share)} note="would flood if a levee failed" />
            <Kpi label="Land in 500-year floodplain" value={pct(area.flood_500yr_share)} note="0.2% chance a year" />
            <Kpi label="Land in DWR 200-year floodplain" value={pct(area.flood_200yr_share)}
              note="California SB 5: new urban development here needs 200-year flood protection" />
          </div>
          <div className="caption">{stats.method.flood ?? "FEMA flood zones and DWR 200-year floodplain."} Turn on
            “Flood zones” in the layer list to see them on the map.</div>
        </section>
      )}

      {p && (
        <section>
          <h3>Scores</h3>
          <div className="kpis three">
            <Kpi label="Growth" value={fmt(p.growth_score)} />
            <Kpi label="Wildfire risk" value={fmt(p.risk_score)} />
            <Kpi label="Opportunity" value={fmt(p.opportunity_score)} />
          </div>
        </section>
      )}

      <section>
        <h3>Up-and-coming ranking</h3>
        <table className="rank">
          <thead>
            <tr><th>#</th><th>Place</th><th className="num">10-yr growth</th><th className="num">Fire risk</th><th className="num">Score</th></tr>
          </thead>
          <tbody>
            {ranked.map((r) => (
              <tr key={r.GEOID} className={r.GEOID === selected ? "sel" : ""} onClick={() => onSelect(r.GEOID)}>
                <td>{r.rank}</td>
                <td>{r.name}</td>
                <td className="num">{fmt(r.growth_10yr_pct, 1)}%</td>
                <td className="num">{fmt(r.risk_score)}</td>
                <td className="num"><strong>{fmt(r.opportunity_score)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
        <details className="method">
          <summary>How scores are calculated</summary>
          <p><b>Growth:</b> {stats.method.growth}</p>
          <p><b>Wildfire risk:</b> {stats.method.risk}</p>
          <p><b>Opportunity:</b> {stats.method.opportunity}.</p>
        </details>
      </section>
      <section>
        <details className="method">
          <summary>Data coverage: what we have and what we don't</summary>
          <table className="rank coverage">
            <thead><tr><th>Layer</th><th>Covers</th><th>Gaps</th></tr></thead>
            <tbody>
              {COVERAGE.map(([layer, covers, gaps]) => (
                <tr key={layer}><td><b>{layer}</b></td><td>{covers}</td><td>{gaps}</td></tr>
              ))}
            </tbody>
          </table>
          <p><b>Not in the data at all:</b> current zoning, land prices and sales, parcel ownership (left out on purpose),
            approved but unbuilt subdivisions, sewer and water plant capacity, local power and gas distribution lines,
            schools, jobs and commute times, and anything below town level (no neighbourhoods or Census tracts yet).</p>
        </details>
      </section>
    </div>
  );
}
