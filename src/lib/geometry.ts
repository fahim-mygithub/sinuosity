export type LatLng = [number, number];

/** Great-circle distance between two points in kilometers. */
export function haversine(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[0] * Math.PI) / 180) *
      Math.cos((b[0] * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** Total path length in km. */
export function pathLength(coords: LatLng[]): number {
  let d = 0;
  for (let i = 0; i < coords.length - 1; i++) d += haversine(coords[i], coords[i + 1]);
  return d;
}

/** Initial compass bearing a → b, degrees 0..359 (0 = north). Used to aim a stop's Street View
 *  camera from the road toward the feature beside it. */
export function bearing(a: LatLng, b: LatLng): number {
  const d2r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * d2r) * Math.cos(b[0] * d2r);
  const x =
    Math.cos(a[0] * d2r) * Math.sin(b[0] * d2r) -
    Math.sin(a[0] * d2r) * Math.cos(b[0] * d2r) * Math.cos((b[1] - a[1]) * d2r);
  return Math.round((Math.atan2(y, x) / d2r + 360) % 360);
}

/**
 * Local equirectangular vector from `a` to `b`, with longitude scaled by cos(latitude)
 * so that a degree of longitude and a degree of latitude represent the same ground
 * distance. Without this correction, turn angles computed from raw lat/lon deltas are
 * distorted (~22% at WNY's latitude) because meridians converge.
 */
function groundVector(a: LatLng, b: LatLng): [number, number] {
  const lonScale = Math.cos(((a[0] + b[0]) / 2) * (Math.PI / 180));
  return [b[0] - a[0], (b[1] - a[1]) * lonScale];
}

/** Angle (radians) between two consecutive ground vectors, clamped to [0, π]. */
function turnAngle(v1: [number, number], v2: [number, number]): number | null {
  const m1 = Math.hypot(v1[0], v1[1]);
  const m2 = Math.hypot(v2[0], v2[1]);
  if (m1 === 0 || m2 === 0) return null;
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (m1 * m2);
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

/**
 * Curvature score: total angular deviation (radians) per km of road.
 * Higher = twistier. Returns 0 for segments shorter than 250m (too short to judge).
 */
export function sinuosityScore(coords: LatLng[]): number {
  const dist = pathLength(coords);
  if (dist < 0.25) return 0;

  let deviation = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    const angle = turnAngle(
      groundVector(coords[i - 1], coords[i]),
      groundVector(coords[i], coords[i + 1]),
    );
    if (angle != null) deviation += angle;
  }
  return deviation / dist;
}

/**
 * Map a curvature density (radians per km, from {@link sinuosityScore}) onto the
 * 0–10 "Twisties" scale the UI shows. This is the SAME scaling the Live-scan tab
 * uses (`Math.min(10, s * 4)` in overpass.ts), so a road scores identically in the
 * scenic and live-scan views. Curvature for the scenic dataset is computed with
 * this — never hand-assigned by a language model.
 */
export function curvature10(coords: LatLng[]): number {
  return Math.round(Math.min(10, sinuosityScore(coords) * 4) * 10) / 10;
}

/** Distance in meters (haversine), for the small thresholds used by cleanCoords. */
function metersBetween(a: LatLng, b: LatLng): number {
  return haversine(a, b) * 1000;
}

/**
 * Remove the two geometry artifacts the OSRM "route-via-stops" fallback bakes into a
 * polyline: (1) duplicate / near-coincident consecutive points, and (2) out-and-back
 * spurs — where the route drives into a dead-end overlook and U-turns straight back
 * out, drawing the line on top of itself and inflating distance.
 *
 * Spur removal is anchored on the U-turn apex (a near-180° reversal vertex) and only
 * peels points whose outbound and return legs actually retrace each other (within
 * `matchM`). A switchback/hairpin does NOT retrace — its two legs head to different
 * places — so genuine twisties are preserved; only true dead-end backtracks collapse.
 */
export function cleanCoords(
  coords: LatLng[],
  opts: { dedupM?: number; matchM?: number; reversalRad?: number } = {},
): LatLng[] {
  const dedupM = opts.dedupM ?? 6;
  const matchM = opts.matchM ?? 30;
  const reversalRad = opts.reversalRad ?? (150 * Math.PI) / 180;

  // 1) drop near-duplicate consecutive points
  const pts: LatLng[] = [];
  for (const c of coords) {
    if (pts.length === 0 || metersBetween(pts[pts.length - 1], c) > dedupM) pts.push(c);
  }

  // 2) collapse out-and-back spurs anchored on U-turn apexes
  let i = 1;
  while (i < pts.length - 1) {
    const angle = turnAngle(groundVector(pts[i - 1], pts[i]), groundVector(pts[i], pts[i + 1]));
    if (angle != null && angle >= reversalRad) {
      // peel matching outbound/return pairs around the apex i
      let t = 0;
      while (
        i - 1 - t >= 0 &&
        i + 1 + t < pts.length &&
        metersBetween(pts[i - 1 - t], pts[i + 1 + t]) <= matchM
      ) {
        t++;
      }
      if (t > 0) {
        // outbound [i-t .. i], return [i .. i+t] retrace; keep junction pts[i-t]
        pts.splice(i - t + 1, 2 * t);
        i = Math.max(1, i - t);
        continue;
      }
    }
    i++;
  }
  return pts;
}

/**
 * Indices of out-and-back spur apexes still present in a polyline — a U-turn vertex
 * whose neighbours sit within `matchM` of each other. Used by tests to assert the
 * shipped dataset is spur-free. Returns [] for a clean line.
 */
export function spurApexes(coords: LatLng[], matchM = 30): number[] {
  const reversalRad = (150 * Math.PI) / 180;
  const hits: number[] = [];
  for (let i = 1; i < coords.length - 1; i++) {
    const angle = turnAngle(groundVector(coords[i - 1], coords[i]), groundVector(coords[i], coords[i + 1]));
    if (angle != null && angle >= reversalRad && metersBetween(coords[i - 1], coords[i + 1]) <= matchM) {
      hits.push(i);
    }
  }
  return hits;
}

/**
 * Index of the point with the sharpest turn (largest angular deviation).
 * Useful for picking route-defining waypoints rather than evenly-spaced ones.
 */
export function sharpestTurnIndices(coords: LatLng[], count: number): number[] {
  const angles: { idx: number; angle: number }[] = [];
  for (let i = 1; i < coords.length - 1; i++) {
    const angle = turnAngle(
      groundVector(coords[i - 1], coords[i]),
      groundVector(coords[i], coords[i + 1]),
    );
    if (angle != null) angles.push({ idx: i, angle });
  }
  return angles
    .sort((a, b) => b.angle - a.angle)
    .slice(0, count)
    .map((a) => a.idx)
    .sort((a, b) => a - b); // keep route order
}
