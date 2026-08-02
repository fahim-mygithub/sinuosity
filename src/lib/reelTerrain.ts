// The DEM half of `backdrop`: does the ground FALL AWAY to one side of this road, and which side?
// That is the geometry that puts an open view behind a rider filmed side-on — a rim road with the
// valley out to the right films; the same relief out to the left films a hillside. It is also only
// HALF of backdrop, because the DEM cannot see water at all (a lake surface is flat, and the Lake
// Erie shore returned 0 m of lateral fall), so the other mechanism has to come from OSM polygons.
//
// Split into a pure scoring half — {@link probePoints}, {@link readFall}, {@link terrain10} — and an
// I/O half, {@link fetchLateralFall}, which is batching, a cache, and a slice. The cache is the only
// part of the I/O half carrying logic worth testing, and it is exactly the part the budget below
// depends on, so it is tested against a stubbed transport rather than left to integration.
//
// BUDGET, and it is a real constraint rather than a nicety. Open-Meteo was measured returning HTTP
// 429 at roughly 10–15 requests inside 2 minutes, and `fetchElevations` packs 100 points into each
// request. Nine probes per window over ~30 shortlisted windows is 270 points ≈ 3 requests, which
// sits comfortably inside that. Probing every window of every road does not: 8 rides × 22 km at a
// 200 m stride × 2 sides × 4 distances is 7,040 points ≈ 71 requests, an order of magnitude past
// the 700-point `ELEV_POINT_BUDGET` that overpass.ts already works to. So this module caps itself
// at {@link MAX_PROBE_WINDOWS} windows and takes the first N AS GIVEN — the caller is expected to
// have shortlisted on the cheap dimensions (cleanliness, drama, light) first, since those cost
// nothing. Dropping windows is logged, never silent: a silent truncation reads to the rider as "we
// checked everywhere and found nothing", which is a different and much worse claim than "we did
// not look".
//
// AND THE CAP ALONE IS NOT ENOUGH, which is why {@link fetchLateralFall} caches. The cap bounds ONE
// call at 40 × 9 = 360 points ≈ 4 requests; it does nothing about the caller running the pipeline
// again. Every change of shoot time or camera aim re-scores every mark, and terrain DOES NOT DEPEND
// ON EITHER — the probe geometry is a function of the window and only of the window. Uncached, four
// nudges of a time input are 16 requests inside a couple of seconds, past the measured 429
// threshold, and `fetchElevations` nulls the WHOLE call on its first failing batch (elevation.ts),
// so every mark loses terrain at once — the stronger of the two backdrop mechanisms, gone, silently.
// With the cache the same four nudges cost ZERO requests, because window ids are stable
// (`roadId@startM`) and every one of those 360 coordinates has already been asked for.

import { fetchElevations } from './elevation';
import type { LatLng } from './geometry';
import { tangentBearingAt } from './reelGeometry';
import {
  FULL_FALL_M,
  PROBE_DISTANCES_M,
  type LateralFall,
  type PerSide,
  type RoadWindow,
} from './reelTypes';

/**
 * Most windows one call will probe. 40 × 9 = 360 points ≈ 4 Open-Meteo requests, against a measured
 * 429 threshold of ~10–15 requests per 2 minutes — so a Reel scan can still afford a second pass
 * (a re-probe after the rider changes area, say) inside the same rate window. The number is chosen,
 * not measured: the measurement bounds it from above, and 40 marks is already more than a rider
 * will read.
 */
export const MAX_PROBE_WINDOWS = 40;

/** Probes on ONE side of the road. */
const PROBES_PER_SIDE = PROBE_DISTANCES_M.length;

/** Length of one window's aligned probe/elevation array — the road point plus both sides. */
const PROBE_COUNT = 1 + 2 * PROBES_PER_SIDE;

/** Same sphere as `haversine` (R = 6371 km), so a probe's measured distance equals its requested
 *  one instead of drifting by whichever radius each function happened to pick. */
const EARTH_RADIUS_M = 6_371_000;

const D2R = Math.PI / 180;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Spherical direct formula: the point `distM` from `from` along initial bearing `bearingDeg`.
 *
 * Not a degree offset. `lon += m / 111320` is short by a factor of cos(latitude) — 26% at 42°N —
 * and the error is symmetric between the two sides, so it would NOT show up as a left/right bias
 * where it would be caught. It shows up as a probe distance that depends on which way the road
 * runs: 200 m due north but 149 m due east. `atM` reports the scale of the landform, so that would
 * make the reported scale a function of the road's bearing, which is nonsense.
 */
function destination(from: LatLng, bearingDeg: number, distM: number): LatLng {
  const lat1 = from[0] * D2R;
  const brg = bearingDeg * D2R;
  const delta = distM / EARTH_RADIUS_M;
  const sinLat2 = Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(brg);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const lon2 =
    from[1] * D2R +
    Math.atan2(
      Math.sin(brg) * Math.sin(delta) * Math.cos(lat1),
      Math.cos(delta) - Math.sin(lat1) * sinLat2,
    );
  // Normalise longitude to (-180, 180] so a probe taken across the antimeridian stays a valid
  // coordinate rather than a 181 that the elevation API rejects.
  return [lat2 / D2R, ((lon2 / D2R + 540) % 360) - 180];
}

/**
 * The axis the probes are taken perpendicular to: the LOCAL TANGENT AT THE MIDPOINT, not the window
 * chord (`w.bearingDeg`).
 *
 * The probes are taken at `w.mid` and nowhere else, so the only direction that can be meant by "the
 * side of the road" at that point is the direction the road runs THERE. The chord is a different
 * quantity — it is the mean direction of the whole window, which is right for the sun geometry and
 * wrong here. On a window that curves the two disagree by up to 18 deg (measured on a window with a
 * 90 deg bend in its last quarter), and that disagreement was not merely an inaccuracy: sideScan
 * classifies WATER off the local tangent, `BackdropReading.score10` is `max(terrain10, water10)`,
 * and a feature inside the wedge between the two axes was therefore attributed to OPPOSITE SIDES by
 * the two mechanisms and then merged as if they agreed.
 */
function probeAxisDeg(w: RoadWindow): number {
  const pts = w.pts;
  // Nearest sample to `w.mid`. On the 17-sample windows `cutWindows` emits this is EXACT — the mid
  // is sample 8 — and an even sample count puts it half an interval (12.5 m at RESAMPLE_M) past the
  // true middle, the same sub-degree bias `travelBearings` already accepts at a window's ends.
  const i = Math.round((pts.length - 1) / 2);
  // `tangentBearingAt` is a total function and answers 0 for a window that carries no direction at
  // all. 0 is a real bearing, so a directionless window has to be caught HERE or it gets probed
  // east-west by accident; the chord is the only direction such a window has. `resampleAlong` cannot
  // produce one (a zero-length path collapses to a single point), but a hand-built window can.
  const directed = pts.length > 1 && pts.some((p) => p[0] !== pts[0][0] || p[1] !== pts[0][1]);
  return directed ? tangentBearingAt(pts, i) : w.bearingDeg;
}

/**
 * Probe points for one window's MIDPOINT, in a FIXED order:
 *
 *     [0]      the road itself (`w.mid`)
 *     [1..4]   the LEFT side  ({@link probeAxisDeg} − 90), at PROBE_DISTANCES_M in ascending order
 *     [5..8]   the RIGHT side ({@link probeAxisDeg} + 90), at PROBE_DISTANCES_M in ascending order
 *
 * Length is exactly `1 + 2 * PROBE_DISTANCES_M.length` = 9.
 *
 * That order is part of the contract, not an implementation detail, because {@link readFall} reads
 * an elevation array aligned to it POSITIONALLY. A silent reordering would swap left and right,
 * which is the one error this module cannot survive: the output tells a rider which direction to
 * ride and which way to aim the boom, so a swap does not degrade the answer, it inverts it.
 *
 * Left and right are as seen by a rider travelling along that axis, matching `Side` in reelTypes,
 * `sideOf` in sideScan.ts, and the right-hand-normal convention `offsetPath` already uses.
 */
export function probePoints(w: RoadWindow): LatLng[] {
  const axis = probeAxisDeg(w);
  const pts: LatLng[] = [w.mid];
  for (const sign of [-1, 1]) {
    const brg = axis + sign * 90;
    for (const d of PROBE_DISTANCES_M) pts.push(destination(w.mid, brg, d));
  }
  return pts;
}

/** Relief on one side, from that side's probe elevations in PROBE_DISTANCES_M order. */
function sideFall(roadM: number, probes: number[]): LateralFall {
  let fallM = 0;
  let atM = 0;
  let riseM = 0;
  for (let i = 0; i < probes.length; i++) {
    const drop = roadM - probes[i];
    // Strictly greater, scanning outward, so a tie resolves to the NEAREST distance: if the ground
    // is already all the way down at 400 m and no lower at 800, the landform's scale is 400.
    // Judgement call — nothing measured distinguishes the two.
    if (drop > fallM) {
      fallM = drop;
      atM = PROBE_DISTANCES_M[i];
    }
    if (-drop > riseM) riseM = -drop;
  }
  // One decimal because GLO-90's vertical accuracy is metres; more digits would be invented.
  return { fallM: round1(fallM), atM, riseM: round1(riseM) };
}

/** No usable reading. `atM = 0` is a sentinel — it is not a member of PROBE_DISTANCES_M, so "no
 *  distance produced a fall" cannot be confused with "the fall peaked at 200 m". */
function noFall(): LateralFall {
  return { fallM: 0, atM: 0, riseM: 0 };
}

/**
 * Read lateral relief on both sides from an elevation array ALIGNED to `probePoints(w)`.
 *
 * `fallM` is the MAXIMUM over probe distances of (road elevation − probe elevation), and `atM`
 * records which distance produced it. Max-over-distances is measured and mandatory, because no
 * single distance works: Zoar Valley's signal lives at 200–800 m and VANISHES to 0 by 1500 m,
 * while Letchworth's grows monotonically all the way out (34 → 129 → 142 → 149 m). Probing only at
 * 1500 m scores Zoar zero; probing only at 200 m under-reads Letchworth by 4x. The distance where
 * the max occurs is the scale of the landform, recorded for free.
 *
 * Fall is FLOORED AT ZERO. Ground above the road is a wall, not a view, and a negative fall would
 * otherwise drag a side's score below a genuinely flat one. The wall is still reported, in
 * `riseM`: it is what frames the shot on the opposite side, and it is also what eats the low sun
 * that the light dimension assumes is there (sun.ts uses a flat-earth horizon).
 *
 * A short or non-finite array yields zeros on both sides and WARNS. Returning silent zeros would
 * be indistinguishable from a real reading of flat ground, and `w.id` is the only thing that makes
 * such a bug traceable back to a window — hence the parameter.
 */
export function readFall(w: RoadWindow, elevations: number[]): PerSide<LateralFall> {
  const usable =
    elevations.length >= PROBE_COUNT &&
    elevations.slice(0, PROBE_COUNT).every((e) => Number.isFinite(e));
  if (!usable) {
    console.warn(
      `reelTerrain: window ${w.id} got ${elevations.length} elevations, expected ${PROBE_COUNT} finite — no terrain signal`,
    );
    return { left: noFall(), right: noFall() };
  }
  const roadM = elevations[0];
  return {
    left: sideFall(roadM, elevations.slice(1, 1 + PROBES_PER_SIDE)),
    right: sideFall(roadM, elevations.slice(1 + PROBES_PER_SIDE, PROBE_COUNT)),
  };
}

/**
 * Map one side's fall onto the 0–10 backdrop-terrain scale: magnitude only, saturating at
 * {@link FULL_FALL_M}.
 *
 * NOT a thresholded count of probes or segments over some drop. That was tried and it fails in the
 * direction that matters: counting segments over 15 m produced two false positives in flat
 * farmland (50% and 20% of segments over threshold) whose MEAN fall was still only 11.6 and 10.3 m
 * — country a rider would describe as flat. Magnitude keeps both of those well under
 * `BACKDROP_MIN`, where they belong.
 */
export function terrain10(f: LateralFall): number {
  return round1(clamp01(f.fallM / FULL_FALL_M) * 10);
}

/**
 * Readings per WINDOW, keyed by `RoadWindow.id` — bounded and LRU-evicted in the shape `featureCache`
 * (features.ts), `scanCache` (overpass.ts) and `builtCache` (reelTells.ts) already use.
 *
 * The id is a legitimate key for the GEOMETRY, not merely for the request. `roadId@startM` is an OSM
 * way id plus an offset along that way, so two windows sharing an id are the same 400 m of the same
 * road — including across two different scan areas that both cover it, which is a cache hit the
 * area-keyed caches above cannot get. The one thing it cannot see is OSM re-digitizing that way
 * mid-session, and that is the same staleness those three accept for the same reason: a session is
 * short and a re-digitized way is not.
 *
 * The cap is this module's unit for the 16 areas those caches hold: 16 full probe runs.
 */
const fallCache = new Map<string, PerSide<LateralFall>>();
const FALL_CACHE_CAP = MAX_PROBE_WINDOWS * 16;

/** Drop all cached lateral-fall readings (used by tests; harmless to call at runtime). */
export function clearLateralFallCache(): void {
  fallCache.clear();
}

/**
 * Fetch lateral relief for up to {@link MAX_PROBE_WINDOWS} windows, keyed by `RoadWindow.id`.
 *
 * ONLY UNCACHED WINDOWS ARE FETCHED, and if every window is already known this issues no request at
 * all. That is the difference between the feature working and the feature 429ing itself off the air:
 * terrain is a function of the window alone, so re-running the pipeline for a new shoot time or a
 * new camera aim — which is what the caller's controls do on every keystroke — must cost nothing.
 * See the budget note in the module header for the arithmetic.
 *
 * Whatever IS fetched goes into ONE call to `fetchElevations`, which chunks at 100 points per
 * request and runs the chunks in parallel — issuing a request per window instead would be ~40
 * requests and a guaranteed 429.
 *
 * Never throws. A failure is NOT cached: a 429 or a dead mirror is a property of the minute, not of
 * the road, and caching it would deny those windows their terrain for the rest of the session (the
 * same reasoning `fetchBuiltIndex` records for its own failures). The consequence is the good one —
 * a retry re-asks only for the windows that actually failed.
 *
 * Returns `null` only when the call knows NOTHING: the fetch failed and no window was cached. A
 * failure that still has cache hits returns those hits, because a map that does not cover every
 * window is already normal here — {@link MAX_PROBE_WINDOWS} truncation produces exactly that, and
 * `reelScore` already reads a missing window as "no terrain reading" rather than as flat ground.
 * Throwing away 39 known readings because the 40th could not be fetched would be strictly worse for
 * the rider and no simpler to reason about.
 */
export async function fetchLateralFall(
  windows: RoadWindow[],
  signal?: AbortSignal,
): Promise<Map<string, PerSide<LateralFall>> | null> {
  const probed = windows.slice(0, MAX_PROBE_WINDOWS);
  const dropped = windows.length - probed.length;
  if (dropped > 0) {
    console.warn(
      `reelTerrain: probing the first ${MAX_PROBE_WINDOWS} of ${windows.length} windows; ` +
        `${dropped} carry no terrain signal (Open-Meteo 429s at ~10–15 requests / 2 min)`,
    );
  }
  if (!probed.length) return new Map();

  const out = new Map<string, PerSide<LateralFall>>();
  const missing: RoadWindow[] = [];
  for (const w of probed) {
    const cached = fallCache.get(w.id);
    if (cached) {
      // Refresh recency (cheap LRU) so a window the rider keeps re-scoring survives eviction.
      fallCache.delete(w.id);
      fallCache.set(w.id, cached);
      out.set(w.id, cached);
    } else {
      missing.push(w);
    }
  }
  if (!missing.length) return out;

  const all: LatLng[] = [];
  for (const w of missing) all.push(...probePoints(w));

  const elev = await fetchElevations(all, signal);
  // The length check is redundant against today's `fetchElevations` (it returns null rather than a
  // short array), but everything below indexes positionally, so a future short-return there would
  // silently shift every window's probes one side to the left. Cheap insurance on the one failure
  // this module cannot survive.
  if (!elev || elev.length !== all.length) return out.size ? out : null;

  for (let i = 0; i < missing.length; i++) {
    const base = i * PROBE_COUNT;
    const reading = readFall(missing[i], elev.slice(base, base + PROBE_COUNT));
    out.set(missing[i].id, reading);
    fallCache.set(missing[i].id, reading);
  }
  while (fallCache.size > FALL_CACHE_CAP) fallCache.delete(fallCache.keys().next().value!);
  return out;
}
