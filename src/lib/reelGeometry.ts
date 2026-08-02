// Window geometry for the Reel category: an interpolating resampler, the window cutter, and the
// curvature measure that replaces `flowCurvature` at window scale.
//
// Pure — no network, no I/O. Every tunable the rest of Reel can see lives in reelTypes.ts alongside
// the measurement that justifies it; the two thresholds defined below are internal to one rule each
// and carry their measurements inline.
//
// One idea explains nearly every difference from geometry.ts: Reel scores a FIXED-LENGTH window.
// Because the length is fixed, a total is already a density, so nothing below divides by distance.
// And because a 400 m window is frequently shorter than the gap between two OSM vertices (50% of
// real windows hold fewer than three vertices, 11% hold none), nothing below may snap to a vertex.

import { bearing, haversine, pathLength, type LatLng } from './geometry';
import {
  FULL_HEADING_CHANGE_DEG,
  NMS_RADIUS_M,
  RESAMPLE_M,
  STRIDE_M,
  WINDOW_M,
  type RoadWindow,
} from './reelTypes';

const round1 = (x: number): number => Math.round(x * 10) / 10;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const samePoint = (a: LatLng, b: LatLng): boolean => a[0] === b[0] && a[1] === b[1];

/**
 * Point a fraction `t` of the ground distance along the segment a→b.
 *
 * The cos(latitude) correction `groundVector` applies to turn lat/lon deltas into a metric frame is
 * a fixed diagonal scaling over one short segment, so it cancels here: scaling longitude by
 * cos(lat) to place the point and unscaling it to emit a coordinate multiply and divide by the same
 * number. What actually makes `t` a TRUE ground fraction is that the segment length it is measured
 * against comes from `haversine`, not from raw degree deltas — get that from degrees and a
 * north-south segment and an east-west segment of equal ground length would be walked at different
 * rates. The residual (cos(lat) is not perfectly constant along the segment) is ~1e-9 of a 25 m
 * segment at this latitude.
 */
function lerpGround(a: LatLng, b: LatLng, t: number): LatLng {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Resample a polyline to points spaced ~`spacingM` apart, INTERPOLATING between the bracketing
 * vertices rather than snapping to them.
 *
 * This is the piece `sampleAlong` (elevation.ts) cannot do and the reason it is not reused. It
 * advances a cursor to the first vertex at or after the target distance and emits that VERTEX, so
 * asking it for 17 samples of a three-vertex window returns 17 entries drawn from three distinct
 * places — and downstream code then averages the duplicates as if they were independent
 * observations. Measured, the same window scored at 3 vs 17 samples moves by up to 4.4 points out
 * of 10, so this is a correctness fix and not a refinement.
 *
 * The interval is `total / round(total / spacingM)`, i.e. spacing is stretched or squeezed slightly
 * so that both endpoints land exactly on samples. Endpoints are copied through unchanged rather
 * than interpolated at t=0/t=1, so a caller comparing `out[0]` to `coords[0]` gets an exact match.
 *
 * Degenerate inputs return the least surprising thing rather than throwing: an empty path returns
 * empty, and a path with no length (one point, or every vertex coincident) returns the single place
 * it occupies — emitting two coincident points instead would hand every downstream consumer a
 * segment with no direction.
 */
export function resampleAlong(coords: LatLng[], spacingM: number): LatLng[] {
  if (coords.length === 0) return [];
  const first: LatLng = [coords[0][0], coords[0][1]];
  const lastIn = coords[coords.length - 1];
  const last: LatLng = [lastIn[0], lastIn[1]];
  if (coords.length === 1) return [first];

  // Walk by ground distance, never by vertex index — OSM digitizes densely through towns and
  // sparsely through the countryside, which is exactly backwards from where the detail is wanted.
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]) * 1000);
  }
  const total = cum[cum.length - 1];
  if (!(total > 0)) return [first];
  if (!(spacingM > 0)) return [first, last];

  const n = Math.max(1, Math.round(total / spacingM)); // intervals, so n + 1 points
  const step = total / n;
  const out: LatLng[] = [first];
  let seg = 0;
  for (let k = 1; k < n; k++) {
    const target = k * step;
    // `<=` rather than `<` so a run of duplicate vertices (zero-length segments) is stepped over
    // instead of trapping the cursor; the final segment is never left, so `seg + 1` stays in range.
    while (seg < coords.length - 2 && cum[seg + 1] <= target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    out.push(lerpGround(coords[seg], coords[seg + 1], segLen > 0 ? (target - cum[seg]) / segLen : 0));
  }
  out.push(last);
  return out;
}

/** Wrap a bearing difference into (-180, 180], so a road crossing north reads as a small turn and
 *  not as a 340-degree one. */
function wrapDeg(deg: number): number {
  let d = deg % 360;
  if (d <= -180) d += 360;
  else if (d > 180) d -= 360;
  return d;
}

/**
 * Bearing (deg, 0 = N) of the chord a→b, UNROUNDED, in the local equirectangular frame with the
 * cos(latitude) correction — the same frame `sideOf` classifies sides in.
 *
 * Deliberately not `bearing()` from geometry.ts, which rounds to whole degrees. Rounding is harmless
 * inside a TOTAL that telescopes (see {@link headingChangeDeg}) and it is not harmless in an angle
 * that is later COMPARED against another angle: the half-degree quantum sits exactly on the
 * left/right boundary that decides which side of the rider a backdrop is on. sideScan.ts used to
 * keep its own private copy for that same reason; the two were the same geometry and are now
 * unified on this one, which `travelBearings` there imports.
 *
 * Equirectangular rather than great-circle: over a chord of at most {@link WINDOW_M} the two differ
 * by half the meridian convergence, measured by sweeping a 400 m chord through all 360 headings at
 * 42.9°N at 0.0017 deg worst case (at due east; zero due north) — ~300x below the 0.5 deg quantum
 * being removed, and in exchange every bearing here shares one frame with the side classifier
 * instead of two frames that disagree at the boundary.
 *
 * Range is [0, 360), matching `bearing()`, so one can be swapped for the other. sideScan's private
 * copy returns (-180, 180]; both feed `sideOf`, which normalises, so there the difference is
 * invisible.
 *
 * Coincident points have no direction and return 0 — `atan2(0, 0)`, i.e. a phantom due north —
 * because the signature is total. Callers that care must test for coincidence; {@link
 * tangentBearingAt} does.
 */
export function chordBearingDeg(a: LatLng, b: LatLng): number {
  const lonScale = Math.cos(((a[0] + b[0]) / 2) * D2R);
  const north = b[0] - a[0];
  const east = (b[1] - a[1]) * lonScale;
  return (Math.atan2(east, north) * R2D + 360) % 360;
}

/**
 * The LOCAL direction of travel at sample `i` (deg, 0 = N, unrounded): the circular mean of the
 * chord into the sample and the chord out of it.
 *
 * Why a local tangent exists beside `RoadWindow.bearingDeg`: `bearingDeg` is the window CHORD, and
 * on a curving window the chord is not the direction anyone is pointing. For a quarter-circle window
 * the chord sits 45 deg off the tangent at each end. That matters because Reel's two backdrop
 * mechanisms currently disagree about it — reelTerrain aims its lateral probes off the chord while
 * sideScan classifies water off the local tangent — so a feature inside the wedge between them is
 * attributed to OPPOSITE SIDES by two readings that are then combined with max().
 *
 * The mean of the two chords rather than a one-sided chord, because on a uniformly resampled arc the
 * mean is EXACT: the incoming chord lags the true tangent by half the per-sample turn and the
 * outgoing chord leads it by the same half, so the errors cancel. They cannot cancel at the first
 * and last sample, which have only one chord, so those carry a known bias of half the per-sample
 * turn — 5.6 deg on a quarter circle cut into 8 chords, 0.5 deg at 1 deg per chord. Clamping rather
 * than wrapping there matches `travelBearings` in sideScan.ts.
 *
 * Coincident neighbours are stepped over rather than read, for the reason {@link headingChangeDeg}
 * gives: `atan2(0, 0)` is a phantom swing to north. A sample with no distinct neighbour on either
 * side has no direction at all and returns 0. A sample where the road exactly doubles back (the two
 * chords 180 deg apart) has two equally good answers and takes the one wrapping positive — arbitrary
 * but deterministic, which is what a side classification needs.
 */
export function tangentBearingAt(pts: LatLng[], i: number): number {
  const n = pts.length;
  if (n < 2) return 0;
  const at = Math.min(n - 1, Math.max(0, Math.trunc(i)));
  const here = pts[at];

  let prev = -1;
  for (let k = at - 1; k >= 0; k--) if (!samePoint(pts[k], here)) { prev = k; break; }
  let next = -1;
  for (let k = at + 1; k < n; k++) if (!samePoint(pts[k], here)) { next = k; break; }

  if (prev < 0 && next < 0) return 0;
  if (prev < 0) return chordBearingDeg(here, pts[next]);
  if (next < 0) return chordBearingDeg(pts[prev], here);
  const into = chordBearingDeg(pts[prev], here);
  const outOf = chordBearingDeg(here, pts[next]);
  return (into + wrapDeg(outOf - into) / 2 + 360) % 360;
}

/**
 * Total UNSIGNED heading change over the points, in degrees.
 *
 * Deliberately has none of the three corrections in `flowCurvature`, each of which is documented
 * under FULL_HEADING_CHANGE_DEG as a defect at this scale:
 *
 *  - No minimum-turn floor. `FLOW_MIN_TURN` (4 deg) discards the per-vertex turning of a finely
 *    sampled arc, so resampling — which Reel requires — would DESTROY the signal rather than
 *    sharpen it. The low-pass that keeps digitizer jitter out is the 25 m resampling itself, which
 *    filters by DISTANCE and therefore leaves a genuine sweeper intact.
 *  - No maximum-turn ceiling. `FLOW_MAX_TURN` (75 deg) reads an 80 deg kink as zero turning, and an
 *    80 deg kink is the most filmable corner there is.
 *  - No division by distance. Callers score fixed WINDOW_M windows, so the total IS the density.
 *
 * Exactly coincident consecutive points are skipped: `bearing(a, a)` is atan2(0, 0) = 0, which
 * would inject a phantom swing to north and back. No distance epsilon beyond exact equality is
 * applied, because a "too short to trust" threshold is a minimum-turn floor arriving by the back
 * door.
 *
 * `bearing()` rounds to whole degrees. That quantization is harmless while turning holds one sign:
 * the summed deltas telescope to `round(last) - round(first)`, so the error over a monotone stretch
 * is bounded by 1 deg regardless of how many samples it contains, and only an inflection can add
 * another degree. The pathological case — a true bearing dithering across a half-degree boundary —
 * needs sub-0.5 deg wobble, i.e. under 22 cm of lateral offset per 25 m, far below the digitizing
 * noise it would be hiding inside.
 */
export function headingChangeDeg(pts: LatLng[]): number {
  let total = 0;
  let prev: number | null = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (samePoint(a, b)) continue;
    const h = bearing(a, b);
    if (prev !== null) total += Math.abs(wrapDeg(h - prev));
    prev = h;
  }
  return total;
}

/**
 * Drama on the 0–10 rubric scale: total heading change against {@link FULL_HEADING_CHANGE_DEG}.
 *
 * No division by length. The windows this scores are a fixed WINDOW_M long, which is the entire
 * reason the fixed window exists — 150 deg of turning is a switchback pair whether the code divides
 * or not, and dividing is what pinned `flowCurvature`'s usable range at 400 m to essentially
 * {0, 10}.
 */
export function drama10(pts: LatLng[]): number {
  const turn = headingChangeDeg(pts) / FULL_HEADING_CHANGE_DEG;
  return round1(Math.max(0, Math.min(1, turn)) * 10);
}

/**
 * Shortest window that may be scored (m). Not a free tunable — it is {@link WINDOW_M} with a
 * tolerance, and the tolerance is what the resampler needs: `winIdx` is a whole number of samples,
 * so a full window measures WINDOW_M +/- half a sample interval (387.5–412.5 m at
 * {@link RESAMPLE_M}), and the resampler additionally stretches its interval by a few percent so
 * both road endpoints land on samples.
 *
 * 0.9 rather than 0.5, which is what this was. Measured on the 83-tile corpus, the old threshold
 * admitted 1,669 windows of which 16.2% were under 380 m, 5.0% at or under 260 m, and the shortest
 * was 200 m — and two of the four scored dimensions are length-biased, in opposite directions.
 * `drama10` is an unnormalised total, so a 200 m window can only accumulate half the turning and
 * under-reads by up to 2x. `junctionsPerKm` divides by `lengthM`, so ONE physical junction reads
 * 5.0/km on a 200 m window against 2.5/km on a 400 m one — cleanliness 1.7 against 5.8, and only the
 * short window earns the `urban` tag. At 0.9 the worst surviving bias is 1/0.9 = 1.11x on both.
 */
const MIN_WINDOW_M = WINDOW_M * 0.9;

/** The point halfway along an evenly-resampled window, interpolating when the sample count is even
 *  so the anchor is the middle of the ROAD rather than the middle of the array. */
function midpointOf(pts: LatLng[]): LatLng {
  const f = (pts.length - 1) / 2;
  const i = Math.floor(f);
  const next = pts[i + 1] ?? pts[i];
  return lerpGround(pts[i], next, f - i);
}

/**
 * Cut a road into overlapping fixed-length windows, resampled at {@link RESAMPLE_M}.
 *
 * The road is resampled ONCE and the windows are index slices of that, so every window inherits the
 * same uniform spacing and adjacent windows share their samples exactly. The consequence worth
 * knowing: the resampler stretches its interval so both road endpoints land on samples, so on a
 * road whose length is not a multiple of {@link RESAMPLE_M} the real spacing — and therefore
 * `startM` and `lengthM` — can sit a few percent off the nominal 25 / 200 / 400. That is honest
 * rather than fudged; `startM` is derived from the spacing actually used.
 *
 * A window shorter than {@link MIN_WINDOW_M} is dropped wherever it occurs, not only at the tail:
 * the FIXED LENGTH is the whole reason an undivided total means anything. `drama10` sums turning and
 * never divides, so a short window can only accumulate a proportionally smaller total; and
 * `junctionsPerKm` in reelScore.ts divides by `lengthM`, so a short window inflates the same
 * physical junction. A road under {@link MIN_WINDOW_M} long therefore yields nothing at all.
 *
 * Dropping the tail costs almost nothing: the dropped window overlapped its predecessor by a full
 * {@link STRIDE_M}, so the ground that goes unscored is bounded by
 * {@link MIN_WINDOW_M} - {@link STRIDE_M} = 160 m, and it is the far end of a stretch that has
 * already been looked at.
 */
export function cutWindows(road: { id: string; name: string; coords: LatLng[] }): RoadWindow[] {
  const line = resampleAlong(road.coords, RESAMPLE_M);
  if (line.length < 2) return [];
  const totalM = pathLength(line) * 1000;
  if (!(totalM > 0)) return [];
  const spacingM = totalM / (line.length - 1);

  const winIdx = Math.max(1, Math.round(WINDOW_M / spacingM));
  const strideIdx = Math.max(1, Math.round(STRIDE_M / spacingM));

  const out: RoadWindow[] = [];
  for (let i = 0; i < line.length - 1; i += strideIdx) {
    const j = Math.min(i + winIdx, line.length - 1);
    const lengthM = (j - i) * spacingM;
    // Windows only ever get shorter once the end of the road starts clipping them, so the first
    // one that fails is the last one there will be.
    if (lengthM < MIN_WINDOW_M) break;
    const pts = line.slice(i, j + 1);
    const startM = i * spacingM;
    out.push({
      id: `${road.id}@${Math.round(startM)}`,
      roadId: road.id,
      roadName: road.name,
      pts,
      startM,
      lengthM,
      mid: midpointOf(pts),
      // Chord from first to last point, NOT an average of the per-segment bearings. On a hairpin
      // the naive mean of 0 deg and 174 deg is 87 deg — a direction pointing straight across the
      // hairpin that nobody ever travels — while the vector mean (which on a uniformly resampled
      // window is the chord anyway) collapses to a near-zero-length sum with an ill-conditioned
      // angle. The chord is what a rider means by "which way this bit goes", and it is what the sun
      // geometry needs on the other side of this contract.
      //
      // UNROUNDED — `bearing()` would quantise this to whole degrees, and sideScan.ts refuses that
      // same rounding for its own chord bearing because a half-degree quantum lands on the left/right
      // boundary. Both halves of the backdrop now read direction off the same unrounded definition.
      bearingDeg: chordBearingDeg(pts[0], pts[pts.length - 1]),
    });
  }
  return out;
}

/**
 * Half-width of the "same line" bearing test for cross-road suppression (deg).
 *
 * Set by the two false pairs it exists to collapse, not tuned independently. Measured on a real
 * top-40: `scan-83666787` <-> `Como Lake Park#scan-83666795`, 152 m apart at a 5 deg bearing
 * difference; and `scan-83666787` <-> `scan-106973377`, 210 m apart at 157 deg, i.e. 23 deg off
 * antiparallel. So the threshold has to clear 23. The case it must NOT catch is a crossroads, which
 * sits near 90 deg. 30 is the round number with margin on both sides — anything from ~25 to ~60
 * behaves identically on those measurements.
 */
const CROSS_ROAD_COLLINEAR_DEG = 30;

/**
 * True when two window bearings describe the same LINE: parallel (delta ~0) or antiparallel
 * (delta ~180). Antiparallel has to count, because OSM way direction is arbitrary — one road
 * digitized as two ways meeting nose-to-nose reads as a ~180 deg difference, and it is still one
 * road ridden the other way.
 */
function nearCollinear(aDeg: number, bDeg: number, tolDeg: number): boolean {
  const d = Math.abs(wrapDeg(aDeg - bDeg));
  return d <= tolDeg || d >= 180 - tolDeg;
}

/**
 * Non-max suppression over scored marks: keep the strongest, then drop anything close to something
 * already kept.
 *
 * Two marks on the SAME road always suppress each other inside the radius — they are one stretch
 * seen twice, which is exactly what the overlapping stride produces.
 *
 * Two marks on DIFFERENT roads suppress each other only when they are also near-COLLINEAR, because
 * "different roadId, close together" is two different physical situations:
 *
 *  - A CROSSROADS is two genuinely different shots. The rider cannot film both by standing in one
 *    place, because they are riding, and the two roads point different ways at different backdrops.
 *    Their bearings differ by a lot, the collinearity test fails, and both survive. This is what the
 *    original roadId-only rule was written for and it is preserved intact.
 *  - ONE PHYSICAL ROAD SPLIT ACROSS SEVERAL OSM WAYS is one shot listed twice. OSM splits ways at
 *    TAG changes, not only at junctions, so a name or surface change gives the same tarmac two ids,
 *    and a roadId-only rule can never collapse them. Measured on a real top-40, two such pairs
 *    consumed shortlist slots with the same shot (see {@link CROSS_ROAD_COLLINEAR_DEG}). Their
 *    bearings agree within a few degrees, or differ by ~180 where the two ways were digitized
 *    nose-to-nose, so the collinearity test catches both.
 *
 * The test is on bearing alone and not on perpendicular offset, so two parallel roads a block apart
 * would also collapse. That is accepted: {@link NMS_RADIUS_M} is 400 m and the stronger of two
 * parallel shots 400 m apart really is the one to shoot.
 *
 * Proximity is straight-line distance between window midpoints, not distance along the road. Two
 * shots 100 m apart on the ground are the same location even when the road takes 800 m of hairpin
 * to get from one to the other.
 *
 * Ties are broken by input order (Array.prototype.sort is stable), so a caller passing windows in
 * along-road order gets a deterministic result.
 */
export function suppressNearby<T extends { window: RoadWindow; score: number }>(
  marks: T[],
  radiusM: number = NMS_RADIUS_M,
): T[] {
  const kept: T[] = [];
  for (const m of [...marks].sort((a, b) => b.score - a.score)) {
    let suppressed = false;
    for (const k of kept) {
      if (
        k.window.roadId !== m.window.roadId &&
        !nearCollinear(k.window.bearingDeg, m.window.bearingDeg, CROSS_ROAD_COLLINEAR_DEG)
      ) {
        continue;
      }
      // Strictly closer than the radius, matching NMS_RADIUS_M's "closer than this are the same
      // moment"; a mark exactly at the radius survives.
      if (haversine(k.window.mid, m.window.mid) * 1000 < radiusM) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) kept.push(m);
  }
  return kept;
}
