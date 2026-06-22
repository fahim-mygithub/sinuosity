import type { LatLng } from '../lib/geometry';

export interface ScannedRoad {
  id: string;
  name: string;
  /** Raw curvature (radians per km). */
  curveDensity: number;
  sinuosity: number;
  score: number;
  coords: LatLng[];
  /** OSM `highway` class (secondary/tertiary/unclassified/...), if tagged. */
  highway?: string;
  /** OSM `surface` value, if tagged. */
  surface?: string;
  /** Posted speed in mph parsed from OSM `maxspeed`, or `null` when unknown/ambiguous. */
  maxspeedMph?: number | null;
  /** Whether the road is paved (unknown surface ⇒ treated as paved). */
  paved?: boolean;
  /** OSM `oneway` value, for the loop-closure wrong-way guard. */
  oneway?: string;
}

/**
 * A scanned road enriched with the FULL measured rubric — not just curvature, but scenery,
 * greenery, water and notability MEASURED from nearby OSM features (the same methodology the
 * build-time scenic pipeline uses, run live in the browser). The Scan tab ranks these by a
 * user-weighted composite and stitches them into rides.
 */
export interface ScoredRoad extends ScannedRoad {
  rubric: ScenicRubric;
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
