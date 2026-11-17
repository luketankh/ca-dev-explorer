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
  // flood: share of land in each class (pipeline/14_flood.py; absent if that step hasn't run)
  flood_floodway_share?: number;
  flood_100yr_share?: number; // 100-year floodplain excluding the floodway
  flood_500yr_share?: number;
  flood_levee_share?: number;
  flood_200yr_share?: number; // DWR 200-year floodplain (overlaps the FEMA classes)
  growth_score: number | null;
  risk_score: number;
  opportunity_score: number | null;
  rank: number | null;
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
  contract_share: number;
  contract_ending_share: number;
  flood_floodway_share?: number;
  flood_100yr_share?: number;
  flood_500yr_share?: number;
  flood_levee_share?: number;
  flood_200yr_share?: number;
  lon: number;
  lat: number;
}

export interface RecYear {
  window: string;
  zones: RecZone[];
  next: { period: string; complete: boolean; homes_built: number; in_zones_pct: number | null;
    zone_area_pct: number; top5_pct: number | null } | null;
}

export interface Recommend {
  first_year: number;
  by_year: Record<string, RecYear>;
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
  contract_penalty: number;
  undated_from: number;
  fire_half_life: number;
  fire_method: string;
  flood_method?: string;
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
  method: { fire_buffer_km: number; fire_since: number; growth: string; risk: string; opportunity: string; flood?: string };
}
