import { useState } from "react";
import type { Context, PlaceMetrics, Recommend, Stats } from "../types";
import BuiltChart from "./BuiltChart";
import { recYearFor } from "../layers";

interface Props {
  stats: Stats;
  places: PlaceMetrics[];
  selected: string | null;
  year: number;
  context: Context | null;
  arrows: GeoJSON.FeatureCollection | null;
  recommend: Recommend | null;
  onSelect: (geoid: string | null) => void;
  onPickYear: (y: number) => void;
  onZone: (lon: number, lat: number) => void;
}

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

function vsState(v: number, s: number) {
  const d = Math.round((v / s - 1) * 100);
  return d === 0 ? "same as state" : `${Math.abs(d)}% ${d > 0 ? "above" : "below"} state`;
}

export default function Report({ stats, places, selected, year, context, arrows, recommend, onSelect, onPickYear,
  onZone }: Props) {
  const [chartUse, setChartUse] = useState<"res" | "ci">("res");
  const recYear = recYearFor(year);
  const rec = recommend?.by_year[String(recYear)];
  const ranked = [...places]
    .filter((p) => p.opportunity_score !== null)
    .sort((a, b) => (b.opportunity_score ?? 0) - (a.opportunity_score ?? 0));
  const p = places.find((x) => x.GEOID === selected);
  const area = p ?? { ...stats.county, name: stats.county.name };
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
    .filter((g) => g.year === year && (p ? g.GEOID === p.GEOID : true))
    .sort((a, b) => b.new_homes - a.new_homes);
  const growthShown = growth.slice(0, p ? 6 : 5);
  const crime = context ? (p ? context.places[p.GEOID] : null) : null;
  const ctyC = context?.county;
  const st = context?.state;

  return (
    <aside className="report">
      <header className="report-head">
        {p && <button className="link" onClick={() => onSelect(null)}>← San Joaquin County</button>}
        <h2>{area.name}</h2>
        <div className="sub">
          {p ? (p.kind === "City" ? "Incorporated city" : "Census-designated place") : "MVP study area"}
          {p?.rank ? ` · Opportunity rank #${p.rank} of ${ranked.length}` : ""}
        </div>
      </header>

      {recommend && rec && (
        <section>
          <h3>Where to build next · predicted in {recYear}</h3>
          <div className="caption" style={{ marginTop: 0 }}>
            Using only data available in {recYear}: mostly open land just ahead of where homes went in {rec.window},
            next to existing towns, on flat ground, with higher wildfire risk penalised progressively harder.
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
          <table className="rank rec">
            <thead>
              <tr><th>#</th><th>Zone</th><th className="num">Open acres</th><th className="num">Momentum</th><th className="num">Fire risk</th></tr>
            </thead>
            <tbody>
              {rec.zones.map((z) => (
                <tr key={z.rank} className={p && z.place === p.name ? "sel" : ""} onClick={() => onZone(z.lon, z.lat)}>
                  <td><span className="rec-rank">{z.rank}</span></td>
                  <td>{z.label}
                    <div className="kpi-note">Avg slope {fmt(z.slope_mean, 1)}% · {pct(z.flat_share)} flat
                      {z.fhsz !== "None" ? ` · Hazard zone: ${z.fhsz}` : ""}</div></td>
                  <td className="num">{fmt(z.acres)}</td>
                  <td className="num">{pct(z.momentum)}</td>
                  <td className="num">{pct(z.fire_risk)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details className="method">
            <summary>How this is calculated, and how well it worked in the past</summary>
            <p>The county is cut into {recommend.cell_m} m cells. Each cell scores
              <b> 100 × growth momentum × open land × flat share × next to town × (1 − fire risk)<sup>{recommend.fire_exponent}</sup></b>.
              The fire penalty grows faster than the risk: a cell keeps{" "}
              {[0.1, 0.25, 0.5].map((r) => `${Math.round((1 - r) ** recommend.fire_exponent * 100)}% of its score at ${r * 100}% risk`).join(", ")},
              and nothing at maximum risk.</p>
            <ul>
              <li><b>Growth momentum:</b> how far the cell lies in the path of the growth arrows: 1.5 km ahead
                of each cluster of new homes, along its direction, weighted by the cluster's size.</li>
              <li><b>Open land:</b> building footprint under 6% of the cell (6–12% counts half).</li>
              <li><b>Flat share (terrain):</b> share of the cell with slope ≤ {recommend.terrain.slope_ok_pct}%, plus half the
                share at {recommend.terrain.slope_ok_pct}–{recommend.terrain.slope_max_pct}% (hillside, costly grading).
                Steeper land doesn't count. Slope from {recommend.terrain.dem} elevation.</li>
              <li><b>Next to town:</b> within 1 km of built-up land, fading to zero at 4 km.</li>
              <li><b>Fire risk:</b> {recommend.fire_method} History and detections use a 5 km ring around each
                cell, and the backtest only uses fires known at the time.</li>
              <li><b>Excluded:</b> the Delta Primary Zone (Delta Protection Act; {fmt(recommend.excluded.delta_primary_zone_cells)} cells),
                mostly-water cells, and {fmt(recommend.excluded.too_steep_cells)} cells that are too steep (under 20% flat land).</li>
            </ul>
            <p><b>Backtest:</b> using only data available at the time, the top 5% of the county picked by the model
              contained this share of the homes actually built in the next five years:</p>
            <table className="rank">
              <thead><tr><th>As of</th><th>Homes built</th><th className="num">Model</th><th className="num">Edge-of-town rule</th><th className="num">Random</th></tr></thead>
              <tbody>
                {recommend.backtest.map((t) => (
                  <tr key={t.as_of}>
                    <td>{t.as_of}</td><td>{t.predicts}: {fmt(t.homes_built)}</td>
                    <td className="num"><b>{t.captured_pct}%</b></td><td className="num">{t.baseline_pct}%</td>
                    <td className="num">{t.top_area_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>Not yet included: zoning and general plans, sewer/water capacity, flood zones, land prices and
              ownership. Treat zones as places to investigate, not approvals.</p>
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
        <div className="caption">Click a bar to jump the map to that year. The most recent 1–2 years
          may be incomplete in assessor records{chartUse === "ci" ? "; many commercial buildings have no year at all" : ""}.</div>
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
          <div className="caption">No cluster of 20+ new homes in the 5 years to {year}.</div>
        )}
      </section>

      {context && ctyC && st && (
        <section>
          <h3>Cost of ownership &amp; safety</h3>
          <div className="kpis">
            <Kpi label={`Home insurance, county median (${context.insurance_year})`}
              value={ctyC.premium ? `$${fmt(ctyC.premium)}/yr` : "–"}
              note={ctyC.premium ? `${vsState(ctyC.premium, st.premium_median)} median · #${ctyC.premium_rank} of ${st.premium_counties} counties (1 = priciest)` : undefined} />
            <Kpi label="Premium as % of home value" value={ctyC.premium_pct_of_home_value ? `${ctyC.premium_pct_of_home_value}%` : "–"}
              note={ctyC.median_home_value ? `median home value $${fmt(ctyC.median_home_value)}` : undefined} />
            <Kpi label={`Violent crimes per 1,000 (${context.crime_year})`}
              value={fmt((crime ?? ctyC).violent_per_1k, 1)}
              note={`${vsState((crime ?? ctyC).violent_per_1k, st.violent_per_1k)} (${fmt(st.violent_per_1k, 1)})`} />
            <Kpi label={`Property crimes per 1,000 (${context.crime_year})`}
              value={fmt((crime ?? ctyC).property_per_1k, 1)}
              note={`${vsState((crime ?? ctyC).property_per_1k, st.property_per_1k)} (${fmt(st.property_per_1k, 1)})`} />
          </div>
          <div className="caption">
            {crime
              ? crime.crime_coverage === "own"
                ? `Crime reported by the ${crime.crime_agency}.`
                : `${area.name} has no police department of its own; figures are for the area the ${crime.crime_agency.replace(" (unincorporated + contract cities)", "")} patrols (${fmt(crime.crime_pop)} residents).`
              : `County-wide: all agencies except railroad police. Crime count change 2015–2025: ${fmt(ctyC.crime_change_10yr_pct, 1)}%.`}
            {" "}Insurance is a county-level median of escrowed premiums (HearthMap, from NBER WP 32579); it is the
            same for every place in the county.
          </div>
        </section>
      )}

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
          <p><b>Growth:</b> {stats.method.growth} Scored as a percentile among places with ≥300 dated homes.</p>
          <p><b>Wildfire risk:</b> {stats.method.risk}</p>
          <p><b>Opportunity:</b> {stats.method.opportunity}.</p>
        </details>
      </section>
    </aside>
  );
}
