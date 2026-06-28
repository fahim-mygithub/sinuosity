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
 * Prefix-sum of path length: `cumulativeKm(coords)[k]` is the distance (km) from `coords[0]` to
 * `coords[k]`. The length of any sub-arc `i→j` is then `cum[j] - cum[i]` in O(1), which lets the
 * backtrack-detector (Phase C) avoid an O(n³) re-summation. Mirrors {@link pathLength}: the final
 * entry equals `pathLength(coords)`. Returns `[]` for an empty input and `[0]` for a single point.
 */
export function cumulativeKm(coords: LatLng[]): number[] {
  const cum: number[] = [];
  let d = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) d += haversine(coords[i - 1], coords[i]);
    cum.push(d);
  }
  return cum;
}

/**
 * Surface values OSM uses for roads that are NOT sealed. A leg on one of these is demoted by the
 * scan's rideability factor (it is never hard-dropped from the corpus — an unpaved way is often the
 * shared junction that chains two paved sweepers, so deleting it fragments the graph). See M7.
 */
export const UNPAVED = new Set([
  'unpaved', 'gravel', 'fine_gravel', 'compacted', 'dirt', 'ground', 'earth',
  'grass', 'sand', 'pebblestone', 'mud', 'woodchips',
]);

/**
 * Whether a road with this OSM `surface` value is paved. **Unknown ⇒ true** on purpose: most WNY
 * tertiary/unclassified roads are paved but untagged, so an absent/unrecognized surface must not
 * demote the road. Only an explicit {@link UNPAVED} value returns `false`. See M6/M7.
 */
export function isPaved(surface?: string): boolean {
  if (!surface) return true;
  return !UNPAVED.has(surface.trim().toLowerCase());
}

const KMH_TO_MPH = 0.621;

/**
 * Parse an OSM `maxspeed` value to mph, or `null` when unknown/ambiguous. Grammar (M6):
 *  - lowercase + trim; empty/undefined → `null`.
 *  - `none` → `70` (autobahn sentinel; high so it is never penalized); `walk` → `3`.
 *  - `signals`, `variable`, and country-coded values (`/^[a-z]{2}:/`, e.g. `ru:rural`,
 *    `de:urban`) → `null`.
 *  - explicit knots (`knots`/`kn`) → `null` (not a road speed).
 *  - otherwise split on `;` and take the **minimum** documented numeric value (the safer penalty
 *    signal). Per token: `N mph` → N; `N km/h|kmh|kph` → convert (`*0.621`, rounded); a **bare
 *    number** is km/h per OSM convention → convert.
 *
 * This returns the numeric mph only. The *neutrality* of an unknown speed (null ⇒ no penalty) is
 * enforced later in `rideabilityFactor`, not here.
 */
export function parseMaxspeedMph(raw?: string): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s === 'none') return 70;
  if (s === 'walk') return 3;
  if (s === 'signals' || s === 'variable') return null;
  if (/^[a-z]{2}:/.test(s)) return null;
  if (/\b(knots|kn)\b/.test(s)) return null;

  let min: number | null = null;
  for (const token of s.split(';')) {
    const m = token.match(/([0-9]+(?:\.[0-9]+)?)\s*(mph|km\/h|kmh|kph)?/);
    if (!m) continue;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) continue;
    const mph = m[2] === 'mph' ? n : Math.round(n * KMH_TO_MPH);
    if (min === null || mph < min) min = mph;
  }
  return min;
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
 * "Rideable" curvature on the 0–10 scale — like {@link curvature10}, but it only counts turning
 * that a rider experiences as a *flowing curve*. Two corrections matter for the Live scan, where
 * roads are stitched across junctions:
 *
 *  1. **Junction corners don't count.** A turn sharper than ~75° is almost always a road Teeing
 *     into another (or a stitch joining two ways at an intersection) — "a hard right at an
 *     intersection," not a sweeper. Those are excluded, so stitching two straight roads at a 90°
 *     corner no longer fabricates twistiness.
 *  2. **Digitization jitter doesn't count.** Sub-4° wobble between dense OSM vertices is mapping
 *     noise, not cornering, so a finely-sampled straight road doesn't read as curvy.
 *
 * Geometry is cleaned first (dedup + spur removal). Returns 0 for very short fragments.
 */
const FLOW_MIN_TURN = (4 * Math.PI) / 180;
const FLOW_MAX_TURN = (75 * Math.PI) / 180;
export function flowCurvature(coords: LatLng[]): number {
  const pts = cleanCoords(coords);
  const dist = pathLength(pts);
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
 * Options for {@link dropBacktracks}.
 *  - `rejoinM`   — two vertices this close (m) are a candidate rejoin (the line comes back to itself).
 *  - `minArcKm`  — the along-path gap `i→j` must be at least this long to be considered an excursion
 *                  (so a tight legitimate hairpin within a few hundred metres is never collapsed).
 *  - `bandM`     — Fréchet-style retrace band (m): the outbound half must run within this of the
 *                  return half for the excursion to count as an actual retrace (defaults to `rejoinM`).
 *  - `start`     — ride start anchor; with `shape==='loop'` the intended closure seam is exempted.
 *  - `shape`     — `'loop'` enables the loop-seam guard; `'out-and-back'` does NOT exempt an end spur.
 */
export interface DropBacktracksOpts {
  rejoinM?: number;
  minArcKm?: number;
  bandM?: number;
  start?: LatLng;
  shape?: 'loop' | 'out-and-back';
  /** Loop-close radius (km) used to size the seam-guard exemption; mirrors routeBuilder's gate. */
  loopCloseKm?: number;
}

const EXCURSION_RATIO = 1.8; // arc(i→j) must exceed this × straight(i→j) to read as a there-and-back
const MAX_COLLAPSE_FRAC = 0.4; // a single collapse may never remove more than this fraction of pts

/**
 * Remove a mid-route backtrack / dead-end spur: a stretch where the line runs out to some point and
 * RETRACES itself back to (near) where it left the main path, drawing over itself and inflating
 * distance. This is the runtime twin of {@link cleanCoords}'s spur removal, but it works on the
 * *rejoin* geometry (two far-apart-along-the-path vertices that sit close in space) rather than a
 * single U-turn apex, so it catches an end-of-ride out-and-back spur that cleanCoords' apex test
 * misses (the Eddy's-Overlook bug).
 *
 * For each `j` it finds the EARLIEST `i` such that:
 *   1. along-path gap arc(i→j) ≥ `minArcKm` (a real excursion, not adjacent vertices),
 *   2. the endpoints rejoin: `metersBetween(coords[i], coords[j]) ≤ rejoinM`,
 *   3. the excursion is there-and-back-shaped: arc(i→j) ≥ EXCURSION_RATIO × straight(i→j), AND
 *   4. the interior actually RETRACES: midpoints of the outbound half sit within `bandM` of the
 *      return half (a Fréchet-style band). A 40–60 m-spaced hairpin (limbs offset) and a
 *      figure-eight crossing (lobes diverge) do NOT retrace, so both are preserved.
 * The interior `i+1..j-1` is then collapsed to a single pass-through.
 *
 * Guards: a single collapse may not remove > {@link MAX_COLLAPSE_FRAC} of the points (so a chance
 * self-approach can't amputate a whole lobe); the output is never < 4 points; and when
 * `shape==='loop'` the intended start/finish seam (both endpoints near `start`) is exempted. Uses
 * {@link cumulativeKm} for O(1) sub-arc lengths.
 */
export function dropBacktracks(coords: LatLng[], opts: DropBacktracksOpts = {}): LatLng[] {
  const rejoinM = opts.rejoinM ?? 70;
  const bandM = opts.bandM ?? rejoinM;
  const minArcKm = opts.minArcKm ?? 0.3;
  if (coords.length < 4) return coords;

  // Seam-guard sizing: only meaningful for a true loop with a known start.
  const seamGuard = opts.shape === 'loop' && opts.start != null;
  const seamRadiusKm = opts.loopCloseKm ?? 2.0;

  let pts = coords;
  let cum = cumulativeKm(pts);

  let j = pts.length - 1;
  while (j >= 0) {
    let collapsed = false;
    for (let i = 0; i < j - 1; i++) {
      const arc = cum[j] - cum[i];
      if (arc < minArcKm) continue; // earliest i is the largest excursion; once arc<min, no further i qualifies
      if (metersBetween(pts[i], pts[j]) > rejoinM) continue;

      // Loop closure seam: the deliberate start↔finish rejoin must not be collapsed.
      if (seamGuard) {
        const di = haversine(pts[i], opts.start!);
        const dj = haversine(pts[j], opts.start!);
        if (di <= seamRadiusKm && dj <= seamRadiusKm) continue;
      }

      const straight = haversine(pts[i], pts[j]);
      if (arc < EXCURSION_RATIO * straight) continue; // not there-and-back shaped (e.g. a broad loop)

      if (!retraces(pts, i, j, bandM)) continue; // hairpin / figure-eight: limbs don't overlap → keep

      const removeCount = j - i - 1;
      if (removeCount > MAX_COLLAPSE_FRAC * pts.length) continue; // too big a bite — refuse to amputate
      if (pts.length - removeCount < 4) continue; // never drop below the 4-point floor

      pts = [...pts.slice(0, i + 1), ...pts.slice(j)];
      cum = cumulativeKm(pts);
      j = i; // the rejoin vertex is now at index i; continue scanning earlier excursions
      collapsed = true;
      break;
    }
    if (!collapsed) j--;
  }
  return pts;
}

/**
 * Whether the outbound half of arc `i→j` retraces the return half: each sampled midpoint of the
 * outbound limb has a near neighbour (within `bandM`) on the return limb. This is the Fréchet-style
 * band {@link cleanCoords} uses (its 30 m retrace test), generalized to a rejoin pair. A hairpin
 * with offset limbs and a figure-eight whose lobes cross both FAIL this, so they are preserved.
 */
function retraces(pts: LatLng[], i: number, j: number, bandM: number): boolean {
  const mid = Math.floor((i + j) / 2);
  // Outbound limb = (i, mid), return limb = (mid, j); the apex `mid` is shared and excluded from
  // both so a U-turn vertex can't trivially "match itself".
  let checked = 0;
  for (let a = i + 1; a < mid; a++) {
    let near = false;
    for (let b = mid + 1; b < j; b++) {
      if (metersBetween(pts[a], pts[b]) <= bandM) { near = true; break; }
    }
    if (!near) return false;
    checked++;
  }
  return checked > 0;
}

/**
 * Offset a polyline perpendicular to its direction of travel by `meters`, consistently to one side
 * (the sign picks the side). Approximate — each vertex is shifted along the average normal of its
 * adjacent segments, with cos-lat correction so the offset is a true ground distance. This is a
 * DRAWING helper only (to lay an out-and-back's retrace return beside the outbound line so the
 * round trip reads as two passes); it is never used for navigation geometry. Returns the input
 * unchanged for fewer than 2 points.
 */
export function offsetPath(coords: LatLng[], meters: number): LatLng[] {
  if (coords.length < 2) return coords;
  const degPerM = 1 / 111320; // latitude degrees per metre
  const out: LatLng[] = [];
  for (let i = 0; i < coords.length; i++) {
    // Tangent = average of the incoming and outgoing ground vectors (one of them at the ends).
    const prev = coords[i - 1];
    const next = coords[i + 1];
    const here = coords[i];
    let tx = 0; // latitude axis
    let ty = 0; // east axis (cos-lat scaled)
    if (prev) { const v = groundVector(prev, here); tx += v[0]; ty += v[1]; }
    if (next) { const v = groundVector(here, next); tx += v[0]; ty += v[1]; }
    const mag = Math.hypot(tx, ty);
    if (mag === 0) { out.push(here); continue; }
    tx /= mag; ty /= mag;
    // Right-hand normal (rotate the tangent −90°): (x, y) → (y, −x).
    const nx = ty;
    const ny = -tx;
    const cos = Math.cos((here[0] * Math.PI) / 180) || 1;
    const d = meters * degPerM;
    out.push([here[0] + nx * d, here[1] + (ny * d) / cos]);
  }
  return out;
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
