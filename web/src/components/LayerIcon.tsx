import type { ReactNode } from "react";
import type { LayerKey } from "../layers";

// One line icon per map layer, drawn on a 24 × 24 grid with the current text colour.
const PATHS: Record<LayerKey, ReactNode> = {
  // apartment block + house: buildings
  buildings: (
    <>
      <rect x="4" y="3" width="10" height="18" rx="1" />
      <path d="M7 7h1M10 7h1M7 11h1M10 11h1M7 15h1M10 15h1" />
      <path d="M14 21h6v-8l-3-3-3 3" />
    </>
  ),
  // arrow pushing out from a dot: direction of growth
  arrows: (
    <>
      <circle cx="6" cy="18" r="2" />
      <path d="M8 16 19 5" />
      <path d="M12 5h7v7" />
    </>
  ),
  // map pin with a star: where to build next
  recommend: (
    <>
      <path d="M12 22s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12Z" />
      <path d="m12 6.5 1.1 2.2 2.4.3-1.75 1.7.4 2.4L12 12l-2.15 1.1.4-2.4L8.5 9l2.4-.3Z" />
    </>
  ),
  // rising bar chart over a baseline: cities coloured by growth
  places: (
    <>
      <path d="M3 21h18" />
      <path d="M6 21v-5M10 21v-8M14 21v-11M18 21V5" />
    </>
  ),
  // flame: past fire perimeters
  fires: (
    <path d="M12 22c4 0 7-2.7 7-6.8 0-3.2-2-5.6-3.6-7.4-.4 2-1.5 3.2-2.6 3.6.6-3.4-.6-6.6-3.3-8.4.2 3-1.3 5-2.9 7C5.4 11.6 5 13.2 5 15.2 5 19.3 8 22 12 22Z" />
  ),
  // warning triangle: fire hazard severity zones
  fhsz: (
    <>
      <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  // waves: flood zones
  flood: (
    <>
      <path d="M2 7c2 0 2-1.5 4-1.5S8 7 10 7s2-1.5 4-1.5S16 7 18 7s2-1.5 4-1.5" />
      <path d="M2 12.5c2 0 2-1.5 4-1.5s2 1.5 4 1.5 2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5" />
      <path d="M2 18c2 0 2-1.5 4-1.5S8 18 10 18s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5" />
    </>
  ),
  // plan divided into zoned plots: general plan land use
  plans: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 10h9M12 3v18M12 15h9" />
    </>
  ),
  // landscape photo: aerial imagery
  aerial: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="9.5" r="1.8" />
      <path d="m3 17 5-5 4 4 3-3 6 6" />
    </>
  ),
  // transmission tower: power lines & gas pipelines
  utilities: (
    <>
      <path d="M8 22 12 3l4 19" />
      <path d="M5 7h14M6.5 12h11M9.6 13 14.8 20M14.4 13 9.2 20" />
    </>
  ),
  // tap with a drop: water & sewer service
  services: (
    <>
      <path d="M4 9h9a3 3 0 0 1 3 3v1" />
      <path d="M4 6v6M8 9V6M6 6h4" />
      <path d="M16 16.5c0 1.4-1 2.5-2 2.5s-2-1.1-2-2.5 2-3.5 2-3.5 2 2.1 2 3.5Z" transform="translate(2 1)" />
    </>
  ),
};

export default function LayerIcon({ layer, size = 22 }: { layer: LayerKey; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[layer]}
    </svg>
  );
}
