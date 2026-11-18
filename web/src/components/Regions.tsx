import { useState } from "react";
import type { PlaceMetrics, Stats } from "../types";

interface Props {
  stats: Stats;
  /** Towns (cities + communities), the county's areas and their rural land. */
  regions: PlaceMetrics[];
  selected: string | null;
  /** Fly to a region (GEOID) or, with null, to the whole county, and show its analysis. */
  onPick: (geoid: string | null) => void;
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString());
const KIND: Record<string, string> = { City: "City", CDP: "Community", Rural: "Rural land" };

/**
 * The county as a tree: County › 9 areas (Census county divisions, which tile the county) › each area's
 * cities, communities and the rural land between them. Every acre belongs to exactly one leaf.
 */
export default function Regions({ stats, regions, selected, onPick }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const needle = q.trim().toLowerCase();
  const hit = (r: PlaceMetrics) => r.name.toLowerCase().includes(needle);
  const areas = regions.filter((r) => r.kind === "Area").sort((a, b) => a.name.localeCompare(b.name));
  const order = { City: 0, CDP: 1, Rural: 2 } as Record<string, number>;
  const children = (a: PlaceMetrics) => regions
    .filter((r) => r.kind !== "Area" && r.area === a.GEOID)
    .sort((x, y) => order[x.kind] - order[y.kind] || x.name.localeCompare(y.name));
  const selArea = regions.find((r) => r.GEOID === selected)?.area;
  const towns = regions.filter((r) => r.kind === "City" || r.kind === "CDP");

  // bars compare new homes against the busiest area (areas) or busiest town/rural part (rows inside an area)
  const maxArea = Math.max(1, ...areas.map((a) => a.res_built_2016_2025));
  const maxChild = Math.max(1, ...regions.filter((r) => r.kind !== "Area").map((r) => r.res_built_2016_2025));
  const nTowns = (r: PlaceMetrics) => (r.towns ? r.towns.split(", ").length : 0);

  const Row = ({ r, child }: { r: PlaceMetrics; child?: boolean }) => {
    const homes = r.res_built_2016_2025;
    const max = child ? maxChild : maxArea;
    return (
      <button type="button" className={`region-row${child ? " child" : ""}${selected === r.GEOID ? " sel" : ""}`}
        onClick={() => onPick(r.GEOID)}>
        <span className="rr-name">{r.name}
          <small>{r.kind === "Area" ? `${nTowns(r)} town${nTowns(r) === 1 ? "" : "s"} + rural land`
            : `${KIND[r.kind]}${r.rank ? ` · opportunity #${r.rank}` : ""}`}</small>
        </span>
        <span className="rr-homes">
          <span className="rr-num">{fmt(homes)}</span>
          <span className="rr-bar"><i style={{ width: `${Math.max(2, (100 * homes) / max)}%` }} /></span>
        </span>
        <span className="rr-num rr-growth">{r.growth_10yr_pct === null || r.growth_10yr_pct === undefined
          ? "–" : `${r.growth_10yr_pct.toFixed(r.growth_10yr_pct < 10 ? 1 : 0)}%`}</span>
      </button>
    );
  };

  return (
    <div className="regions">
      <header className="report-head">
        <h2>Regions</h2>
        <div className="sub">The county is split into {areas.length} areas that cover all of it. Each area holds its
          towns and the rural land between them. Pick one to zoom the map to it; its analysis is in the Analysis tab.</div>
      </header>

      <button type="button" className={`region-row county${selected === null ? " sel" : ""}`} onClick={() => onPick(null)}>
        <span className="rr-name">{stats.county.name}
          <small>Whole county: {areas.length} areas, {towns.filter((t) => t.kind === "City").length} cities,{" "}
            {towns.filter((t) => t.kind === "CDP").length} communities</small></span>
        <span className="rr-homes"><span className="rr-num">{fmt(stats.county.res_built_2016_2025)}</span></span>
        <span className="rr-num rr-growth">{stats.county.growth_10yr_pct === null ? "–" : `${stats.county.growth_10yr_pct.toFixed(1)}%`}</span>
      </button>

      <input className="region-search" type="search" placeholder="Search areas, cities and communities" value={q}
        onChange={(e) => setQ(e.target.value)} aria-label="Search regions" />

      <div className="region-cols" aria-hidden="true">
        <span>Region</span><span title="Homes built 2016–2025 (county assessor)">New homes 2016–25</span>
        <span title="Homes built 2016–2025 as a share of homes standing in 2015">10-yr growth</span>
      </div>
      <ul className="area-list">
        {areas.map((a) => {
          const kids = children(a);
          const shownKids = needle ? kids.filter(hit) : kids;
          if (needle && !hit(a) && shownKids.length === 0) return null;
          const expanded = !!needle || (open[a.GEOID] ?? (selArea === a.GEOID || selected === a.GEOID));
          return (
            <li key={a.GEOID} className="area-group">
              <div className="area-head">
                <button type="button" className="area-toggle" aria-expanded={expanded}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${a.name}`}
                  onClick={() => setOpen((o) => ({ ...o, [a.GEOID]: !expanded }))}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2"
                    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                    style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </button>
                <Row r={a} />
              </div>
              {expanded && (
                <ul className="region-list nested">
                  {(needle && hit(a) ? kids : shownKids).map((r) => <li key={r.GEOID}><Row r={r} child /></li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <div className="caption">New homes = homes built 2016–2025 (county assessor; the latest year is incomplete).
        10-yr growth = those homes as a share of the homes standing in 2015. Bars compare areas with each other, and
        towns and rural land with each other. Areas are the Census Bureau's county divisions. Towns are incorporated cities and
        census-designated places; “rural land” is the rest of each area.</div>
    </div>
  );
}
