import type { LatLng } from '../lib/geometry';

export interface Weights {
  sinuosity: number;
  scenery: number;
  community: number;
}

export interface Pin {
  lat: number;
  lon: number;
  type: 'lookout' | 'caution' | 'scenic';
  title: string;
  desc: string;
}

export interface Route {
  id: string;
  name: string;
  type: string;
  highlights: string;
  /** Measured-ish curvature proxy, 0-10. */
  sinuosity: number;
  /** AUTHOR ESTIMATE, not measured. */
  scenery: number;
  /** AUTHOR ESTIMATE, percent. */
  canopy: number;
  /** AUTHOR ESTIMATE description. */
  waterProximity: string;
  /** AUTHOR ESTIMATE, 0-10. */
  community: number;
  /** Paraphrased rider sentiment — not a verbatim quote. */
  communityIntel: string;
  note: string;
  color: string;
  coords: LatLng[];
  pins?: Pin[];
}

export type ScoredRoute = Route & { score: number };

export interface ScannedRoad {
  id: string;
  name: string;
  /** Raw curvature (radians per km). */
  curveDensity: number;
  sinuosity: number;
  score: number;
  coords: LatLng[];
}

/** A photo-worthy place to stop along a scenic route. */
export interface ScenicStop {
  lat: number;
  lon: number;
  title: string;
  /** What you'll see / why it's worth stopping. */
  blurb: string;
  kind: 'viewpoint' | 'waterfall' | 'gorge' | 'water' | 'overlook' | 'village' | 'forest' | 'bridge' | 'caution';
  /** Suggested Street View camera heading (degrees, 0=N) toward the view. */
  heading: number;
  /** OSM/Wikipedia provenance, if the stop was anchored to a tagged feature. */
  source?: string;
}

/** Per-dimension scenery rubric, each 0-10. */
export interface ScenicRubric {
  curvature: number;
  scenery: number;
  greenery: number;
  water: number;
  notability: number;
}

/**
 * A build-time-generated scenic ride. Geometry is OSRM-snapped to real roads.
 * Produced by the agentic pipeline (see docs/plans) and baked into the app.
 */
export interface ScenicRoute {
  id: string;
  name: string;
  theme: string;
  region: string;
  distanceKm: number;
  drivingTime: string;
  summary: string;
  /** Judge panel's one-line verdict on why this ride is worth taking. */
  whyRide: string;
  rubric: ScenicRubric;
  /** Composite 0-100 score (judge-adjusted). */
  score: number;
  color: string;
  /** Snapped, road-following polyline. */
  coords: LatLng[];
  stops: ScenicStop[];
}
