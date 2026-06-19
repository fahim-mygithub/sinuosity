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
