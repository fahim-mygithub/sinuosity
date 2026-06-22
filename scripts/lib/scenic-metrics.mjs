// Shared, deterministic scenic-route metrics for the build pipeline (plain Node, no deps).
// This is the JS mirror of the curvature/geometry helpers in src/lib/geometry.ts; the
// Vitest dataset-invariant test re-measures the shipped dataset with the TS versions, so
// the two implementations are kept honest (any drift fails the build).
//
// Curvature is MEASURED here, never hand-assigned. The 0-10 mapping (Math.min(10, radPerKm*4))
// is identical to the app's Live-scan scaling (src/lib/overpass.ts) so a road scores the same
// in both tabs.

const d2r = Math.PI / 180;

/** Great-circle distance in km. */
export function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b[0] - a[0]) * d2r;
  const dLon = (b[1] - a[1]) * d2r;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * d2r) * Math.cos(b[0] * d2r) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
export const haversineM = (a, b) => haversineKm(a, b) * 1000;

export function pathLengthKm(coords) {
  let d = 0;
  for (let i = 0; i < coords.length - 1; i++) d += haversineKm(coords[i], coords[i + 1]);
  return d;
}

// cos-lat-corrected ground vector so turn angles aren't distorted by meridian convergence.
function groundVector(a, b) {
  const lonScale = Math.cos(((a[0] + b[0]) / 2) * d2r);
  return [b[0] - a[0], (b[1] - a[1]) * lonScale];
}
function turnAngle(v1, v2) {
  const m1 = Math.hypot(v1[0], v1[1]);
  const m2 = Math.hypot(v2[0], v2[1]);
  if (m1 === 0 || m2 === 0) return null;
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (m1 * m2);
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

/** Curvature density: total angular deviation (radians) per km. Higher = twistier. */
export function sinuosityScore(coords) {
  const dist = pathLengthKm(coords);
  if (dist < 0.25) return 0;
  let deviation = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    const a = turnAngle(groundVector(coords[i - 1], coords[i]), groundVector(coords[i], coords[i + 1]));
    if (a != null) deviation += a;
  }
  return deviation / dist;
}

/** Map curvature density to the 0-10 "Twisties" scale (same scaling as the Live-scan tab). */
export function curvature10(coords) {
  return Math.round(Math.min(10, sinuosityScore(coords) * 4) * 10) / 10;
}

// "Rideable flow" curvature band: count only turns that are real curves a rider leans into —
// excluding junction/intersection corners (> ~75°, which the honesty audit showed inflate the
// score) and sub-degree digitization jitter (< ~4°). Mirror of flowCurvature in src/lib/geometry.ts.
const FLOW_MIN_TURN = (4 * Math.PI) / 180;
const FLOW_MAX_TURN = (75 * Math.PI) / 180;

/**
 * Flow-aware curvature on the 0-10 "Twisties" scale: total in-band angular deviation per km of
 * cleaned road. This is the measure the Live-scan tab now uses; bringing the baked Scenic/Curated
 * routes onto it keeps "twistiness" comparable across all three tabs (no junction-corner inflation).
 */
export function flowCurvature(coords) {
  const pts = cleanCoords(coords);
  const dist = pathLengthKm(pts);
  if (dist < 0.3) return 0;
  let deviation = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const angle = turnAngle(groundVector(pts[i - 1], pts[i]), groundVector(pts[i], pts[i + 1]));
    if (angle == null || angle < FLOW_MIN_TURN || angle > FLOW_MAX_TURN) continue;
    deviation += angle;
  }
  return Math.round(Math.min(10, (deviation / dist) * 4) * 10) / 10;
}

/**
 * Remove near-duplicate consecutive points and out-and-back spurs (dead-end U-turns
 * that draw the line back on itself). Spur removal is anchored on the ~180° reversal
 * apex and only peels legs that actually retrace each other, so hairpins/switchbacks
 * (which don't retrace) are preserved. Mirror of cleanCoords() in src/lib/geometry.ts.
 */
export function cleanCoords(coords, { dedupM = 6, matchM = 30, reversalRad = 150 * d2r } = {}) {
  const pts = [];
  for (const c of coords) {
    if (pts.length === 0 || haversineM(pts[pts.length - 1], c) > dedupM) pts.push(c);
  }
  let i = 1;
  while (i < pts.length - 1) {
    const angle = turnAngle(groundVector(pts[i - 1], pts[i]), groundVector(pts[i], pts[i + 1]));
    if (angle != null && angle >= reversalRad) {
      let t = 0;
      while (i - 1 - t >= 0 && i + 1 + t < pts.length && haversineM(pts[i - 1 - t], pts[i + 1 + t]) <= matchM) t++;
      if (t > 0) {
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
 * Local turn radius via the circumcircle (Menger curvature) of three consecutive points
 * — the roadcurvature.com / Adam Franco primitive. Returns metres; ~10000 for collinear.
 */
export function circumRadius(p0, p1, p2) {
  const a = haversineM(p0, p1);
  const b = haversineM(p1, p2);
  const c = haversineM(p0, p2);
  const area2 = Math.abs((a + b + c) * (b + c - a) * (c + a - b) * (a + b - c));
  if (area2 <= 0) return 10000;
  return (a * b * c) / Math.sqrt(area2);
}

// Radius bands -> weight (roadcurvature.com defaults): tighter turns count for more.
function radiusWeight(r) {
  if (r > 175) return 0;
  if (r > 100) return 1.0;
  if (r > 60) return 1.3;
  if (r > 30) return 1.6;
  return 2.0;
}

/**
 * roadcurvature.com "twistiness": sum of segment_length * weight(localRadius), using the
 * smaller of the two adjacent circumradii per interior segment. Returns the total value
 * (metres-in-weighted-turns) and per-km density. Used for road DISCOVERY ranking, where
 * the radius-banded metric resists the vertex-noise inflation that plain rad/km suffers.
 * Reference calibration: total ~300 = a pleasant twisty road, ~1000 = among the best.
 */
export function twistiness(coords) {
  if (coords.length < 3) return { value: 0, perKm: 0, lengthKm: pathLengthKm(coords) };
  const radii = new Array(coords.length).fill(10000);
  for (let i = 1; i < coords.length - 1; i++) radii[i] = circumRadius(coords[i - 1], coords[i], coords[i + 1]);
  let value = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const r = Math.min(radii[i] ?? 10000, radii[i + 1] ?? 10000);
    value += haversineM(coords[i], coords[i + 1]) * radiusWeight(r);
  }
  const lengthKm = pathLengthKm(coords);
  return { value: Math.round(value), perKm: lengthKm > 0 ? value / lengthKm : 0, lengthKm };
}

/**
 * Length-normalized, density-capped DISCOVERY rank key. The old discovery sort used the raw
 * total weighted-turn value, which scales with length (a long mild road out-totals a short
 * intense one) and lets mall-ring/roundabout geometry (perKm in the hundreds) dominate. This
 * caps the per-km density at a noise ceiling and weights by sqrt(length) — a mild preference
 * for sustained corridors without the linear length bias. NOT a 0-100 score; never feed it to
 * compositeScore (that is reserved for the rubric).
 */
export const DISCOVERY_DENSITY_CAP = 120; // weighted-m/km; real WNY roads cluster ~30-120
export function rankScore(perKm, lengthKm, cap = DISCOVERY_DENSITY_CAP) {
  if (!(lengthKm > 0) || !(perKm > 0)) return 0;
  return Math.min(perKm, cap) * Math.sqrt(lengthKm);
}

/**
 * Geodesic destination point: from [lat,lon], travel `distM` metres along compass `bearingDeg`.
 * Used to offset a sample point PERPENDICULAR to the road (bearing ± 90°) so scenery/land-cover
 * is measured from the VIEW beside the road, not the tarmac itself.
 */
export function destinationPoint(p, bearingDeg, distM) {
  const R = 6371000;
  const delta = distM / R;
  const theta = bearingDeg * d2r;
  const phi1 = p[0] * d2r;
  const lam1 = p[1] * d2r;
  const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
  const y = Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);
  const x = Math.cos(delta) - Math.sin(phi1) * sinPhi2;
  const lam2 = lam1 + Math.atan2(y, x);
  return [phi2 / d2r, (((lam2 / d2r) + 540) % 360) - 180];
}

/** Initial compass bearing a -> b, degrees 0..359. */
export function bearing(a, b) {
  const y = Math.sin((b[1] - a[1]) * d2r) * Math.cos(b[0] * d2r);
  const x = Math.cos(a[0] * d2r) * Math.sin(b[0] * d2r) - Math.sin(a[0] * d2r) * Math.cos(b[0] * d2r) * Math.cos((b[1] - a[1]) * d2r);
  return Math.round((Math.atan2(y, x) / d2r + 360) % 360);
}

// Motorcycle-audience composite weights (sum to 1). Curvature is the headline term.
export const COMPOSITE_WEIGHTS = { curvature: 0.35, scenery: 0.2, greenery: 0.15, water: 0.15, notability: 0.15 };

/** Deterministic 0-100 composite from a 0-10 rubric. Reproducible; replaces the LLM score. */
export function compositeScore(rubric, weights = COMPOSITE_WEIGHTS) {
  const w = weights;
  const avg =
    w.curvature * (rubric.curvature ?? 0) +
    w.scenery * (rubric.scenery ?? 0) +
    w.greenery * (rubric.greenery ?? 0) +
    w.water * (rubric.water ?? 0) +
    w.notability * (rubric.notability ?? 0);
  return Math.round(avg * 10);
}

/** Format minutes as "35 min" / "1h 12m". */
export function formatDriveTime(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Parse "35 min" / "1h 12m" / "~40 min" back to minutes (for proportional rescale). */
export function parseDriveTime(s) {
  if (typeof s !== 'string') return null;
  const h = s.match(/(\d+)\s*h/);
  const m = s.match(/(\d+)\s*m/);
  if (h || m) return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
  const only = s.match(/(\d+)/);
  return only ? +only[1] : null;
}
