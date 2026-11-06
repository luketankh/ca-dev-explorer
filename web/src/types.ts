export interface PlaceMetrics {
  GEOID: string;
  name: string;
  kind: "City" | "CDP";
  ci_buildings: number;
  ci_dated_share: number | null;
  ci_sqft_2016_2025: number;
  buildings: number;
  res_dated: number;
  new_since_2020_snapshot: number;
  res_stock_2015: number;
  res_built_2016_2025: number;
  res_built_2021_2025: number;
  growth_10yr_pct: number | null;
  fires_10km_since_2000: number;
  burned_acres_10km_since_2000: number;
  nearest_fire_km: number | null;
  firms_10km_since_2001: number;
  firms_wildland_10km_since_2001: number;
  burned_fraction_10km: number;
  wildland_detections_per_100km2: number;
  fire_history: number;
  fire_freq: number;
  fire_reburn: number;
  fire_last: number;
  fire_detections: number;
  years_since_fire: number | null;
  fires_on_record: number;
  fires_weighted: number;
  last_fire_name: string | null;
  last_fire_year: number | null;
  fhsz_high_vhigh_share: number;
  buildings_in_fhsz_share: number;
  growth_score: number | null;
  risk_score: number;
  opportunity_score: number | null;
  rank: number | null;
}

export interface PlaceContext {
  crime_agency: string;
  crime_coverage: "own" | "sheriff";
  crime_pop: number;
  violent_per_1k: number;
  property_per_1k: number;
  pop_2025: number | null;
}

export interface Context {
  crime_year: number;
  insurance_year: number;
  state: {
    premium_median: number;
    premium_mean: number;
    premium_counties: number;
    violent_per_1k: number;
    property_per_1k: number;
    counties: number;
  };
  county: {
    county: string;
    premium: number | null;
    median_home_value: number | null;
    premium_pct_of_home_value: number | null;
    premium_rank: number | null;
    violent_per_1k: number;
    property_per_1k: number;
    violent_rank: number;
    property_rank: number;
    crime_change_10yr_pct: number | null;
    pop_2025: number;
  };
  places: Record<string, PlaceContext>;
}

export interface RecZone {
  rank: number;
  label: string;
  place: string;
  score_sum: number;
  score_max: number;
  cells: number;
  acres: number;
  momentum: number;
  fire_risk: number;
  fhsz: string;
  burn_frac_5km: number;
  slope_mean: number;
  flat_share: number;
  elev_m: number;
  lon: number;
  lat: number;
}

export interface Recommend {
  as_of: number;
  window: string;
  cell_m: number;
  threshold: number;
  zones: RecZone[];
  backtest: { as_of: number; predicts: string; homes_built: number; top_area_pct: number;
    captured_pct: number; baseline_pct: number }[];
  excluded: { delta_primary_zone_cells: number; water_cells: number; too_steep_cells: number };
  terrain: { slope_ok_pct: number; slope_max_pct: number; dem: string };
  fire_exponent: number;
  fire_half_life: number;
  fire_method: string;
}

export interface Stats {
  years: number[];
  county: Omit<PlaceMetrics, "GEOID" | "kind" | "growth_score" | "risk_score" | "opportunity_score" | "rank"> & {
    yearly: number[];
    yearly_ci_sqft: number[];
    ci_buildings: number;
    ci_dated_share: number | null;
    ci_sqft_2016_2025: number;
    before: number;
  };
  places: Record<string, { name: string; kind: string; yearly: number[]; yearly_ci_sqft: number[]; before: number }>;
  method: { fire_buffer_km: number; fire_since: number; growth: string; risk: string; opportunity: string };
}
