// Directional ("which side of the rider") feature scanning for the Reel category.
//
// This is the primitive the whole category rests on. Every signal in `measureRubric` is RADIAL —
// `corridorSignal`, `weightedSignal` and `fractionInside` all answer "how much water is near this
// route", and not one of them can answer "is the water on my LEFT or my RIGHT". With the camera
// boom out to the right that distinction IS the feature: ride the same road the other way and the
// lake moves behind the camera instead of into frame. The rubric's grid internals are also
// module-private, so none of this could be derived from `greenContain` or any other existing
// export — it had to be built, and `nearestWithinM` had to be added beside `anyWithinM` to build it.
//
// Pure: no network, no Overpass, no DEM. The only cost is one grid-accelerated nearest-feature
// lookup per resampled window point.

import { type LatLng } from './geometry';
import { chordBearingDeg } from './reelGeometry';
import { nearestWithinM, type WeightedTell } from './sceneryTells';
import type { PerSide, RoadWindow, Side } from './reelTypes';

const D2R = Math.PI / 180;

/** What one side of a window saw. */
export interface SideHits {
  /**
   * Fraction of the window's resampled points whose nearest qualifying feature was on this side.
   *
   * This is the field that makes a sustained shoreline outrank a single pond glimpsed once. A mean
   * distance cannot tell those apart — a 400 m window running 80 m off a lake and a 400 m window
   * that clips one pond at 80 m have the same minimum — and "how long is it in frame" is exactly
   * what a 45-second edit is buying.
   */
  frac: number;
  /** Closest qualifying feature seen on this side (m), or null when none was within `maxM`. */
  nearestM: number | null;
}

/**
 * Which side of a rider travelling on `travelBearingDeg` at `from` the point `to` sits on.
 *
 * The sign of the cross product of the travel vector with the vector to the feature, taken in a
 * LOCAL EQUIRECTANGULAR frame with the cos(latitude) correction — the same frame `groundVector`
 * establishes in geometry.ts (that helper is private, so the three lines are repeated rather than
 * imported). The correction is not cosmetic: meridians converge, so without it the frame is
 * stretched ~22% east-west at this latitude and every feature within roughly 12 deg of the travel
 * axis lands on the wrong side.
 *
 * SIGN CONVENTION, and it is worth reading before trusting anything downstream, because a flip
 * here silently swaps left and right everywhere and every score would still look plausible.
 * `offsetPath` in geometry.ts is the codebase's existing normal convention and this MATCHES it —
 * but not by copying its formula. `offsetPath` builds its normal as `(x, y) -> (y, -x)` over
 * components ordered (latitude, east), and that rotation is the right-hand normal only in the usual
 * (east, north) ordering; applied to (north, east) it is the LEFT normal. Verified by construction:
 * offsetting a northbound line by +50 m moves it WEST, i.e. onto the rider's left. So
 * `offsetPath(path, +m)` lays its copy on the side this function calls `'left'`, and sideScan.test.ts
 * asserts exactly that so the two conventions cannot drift apart. What this function returns is the
 * physical truth — heading north, due east is on your right — because that is what the right-boom
 * rig actually sees.
 *
 * A feature lying exactly on the travel axis is on NEITHER side, and this returns a side anyway
 * because the caller needs a total function. Which side it picks there is decided by the last bits
 * of `Math.cos`/`Math.sin` rather than by any geometry, and is meaningless — but it is at least
 * deterministic, which matters: a flickering side would make a backdrop score depend on
 * floating-point noise. The bearing is normalised to [0, 360) first purely so that determinism
 * survives the wrap. Without it `sideOf(90, …)` and `sideOf(-270, …)` disagree on the axis case,
 * because `Math.cos` of the two representations straddles zero at the 1e-16 level.
 */
export function sideOf(travelBearingDeg: number, from: LatLng, to: LatLng): Side {
  const lonScale = Math.cos(((from[0] + to[0]) / 2) * D2R);
  const north = to[0] - from[0];
  const east = (to[1] - from[1]) * lonScale;
  const b = (((travelBearingDeg % 360) + 360) % 360) * D2R;
  // Travel unit vector is (north, east) = (cos b, sin b); this is its cross product with (north,
  // east) of the feature, signed so that positive is the rider's right. Trig of the raw bearing
  // makes the 0/360 wrap a non-event.
  const cross = Math.cos(b) * east - Math.sin(b) * north;
  return cross > 0 ? 'right' : 'left';
}

/**
 * Direction of travel at each of a window's resampled points, in the window's stored order.
 *
 * The LOCAL tangent (a central difference over the neighbouring samples, ~50 m at `RESAMPLE_M`
 * spacing), not the window's mean `bearingDeg`. The mean is the right headline for a whole window
 * and it is what the sun aim uses, but it is not where the rider is pointing: `FULL_HEADING_CHANGE_DEG`
 * says 150 deg of turning inside 400 m is the *target* case, and the mean bearing of a switchback
 * pair points in a direction the rider never faces at any moment of it. Classifying a lakeshore
 * against that mean would put it on the wrong side for half the window.
 *
 * `bearingDeg` is the fallback for the two degenerate cases — a one-point window, and a repeated
 * point that leaves no chord to take a direction from.
 *
 * The chord bearing comes from reelGeometry.ts. This file used to carry a private copy for the
 * reason that module's docstring gives — `bearing()` in geometry.ts rounds to whole degrees, and the
 * half-degree quantum sits exactly on the left/right boundary `sideOf` decides. Both files wanted
 * the same unrounded equirectangular chord and were written in parallel, so both grew one; they are
 * now the one function. The ranges differ ([0, 360) there, (-180, 180] in the copy this replaced)
 * and that is invisible here, because `sideOf` normalises its argument before taking any trig.
 */
function travelBearings(w: RoadWindow): number[] {
  const pts = w.pts;
  const out: number[] = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    // Clamped rather than wrapped: the first and last samples have only one neighbour, so they take
    // a one-sided chord. On a curve that biases them by half a sample interval (~1 deg at 25 m on
    // anything a motorcycle can ride), which is far below the accuracy this classification needs.
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    // Coincidence is tested HERE rather than read off a null return: `chordBearingDeg` is total and
    // answers 0 for a zero-length chord — a phantom due north, which would classify sides against a
    // direction the rider is not facing instead of falling back to the window bearing.
    out[i] = a[0] === b[0] && a[1] === b[1] ? w.bearingDeg : chordBearingDeg(a, b);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Stable derived arrays.
//
// `nearestWithinM` caches its spatial grid on ARRAY IDENTITY, and the design doc names the
// alternative explicitly: building a fresh array per window defeats `gridCache` (and `bboxCache`,
// and `waterSplitCache`) and is dramatically slower than passing the full stable array. A
// tile-sourced Buffalo scan carries ~255,000 water vertices, so a rebuild per window is not a
// constant factor, it is the whole budget.
//
// Two derived arrays are nevertheless unavoidable here, so both are memoised on the identity of
// their source and therefore built at most once per scan rather than once per window:
//
//  - `asTells` wraps a plain LatLng[], because `nearestWithinM` is the only grid-accelerated
//    nearest-feature search in the codebase and it takes WeightedTell[].
//  - `qualifying` applies `minWeight`. The brief asked for this to be applied at the distance
//    comparison instead, so that no derived array exists at all — but the ring search that would
//    have to carry the predicate is private to sceneryTells.ts, and applying the weight test AFTER
//    `nearestWithinM` returns is not the same function: a screened creek at 50 m would hide the
//    lake at 300 m that is the actual backdrop. Memoising the filter is the shape `waterSplit`
//    already uses for OPEN_WATER_W/MINOR_WATER_W in that same file, it preserves the property that
//    matters (one grid per (array, minWeight), not one per window), and at query time it is
//    strictly cheaper than a predicate would have been, because the grid then indexes only the
//    qualifying features and the ring search terminates sooner. Recorded here because it is a
//    deliberate departure from the brief rather than an oversight.
// ------------------------------------------------------------------------------------------------

const wrapCache = new WeakMap<LatLng[], WeightedTell[]>();

function asTells(pts: LatLng[]): WeightedTell[] {
  let tells = wrapCache.get(pts);
  if (!tells) wrapCache.set(pts, (tells = pts.map((pt) => ({ pt, w: 1 }))));
  return tells;
}

const qualifyCache = new WeakMap<WeightedTell[], Map<number, WeightedTell[]>>();

function qualifying(tells: WeightedTell[], minWeight: number): WeightedTell[] {
  // Every real weight is positive (WATER_SIZE bottoms out at 0.3), so a non-positive threshold
  // excludes nothing and the caller is better served by the original array — it shares its grid
  // with every other caller that holds the same reference.
  //
  // PREFER THAT PATH FOR WATER. sceneryTells exports `waterSplit`, which caches exactly the
  // `w >= OPEN_WATER_W` subset that `measureRubric` already indexes; a caller that wants open water
  // should pass `waterSplit(waterPts).open` with a threshold of 0 rather than handing the full array
  // to the filter below. Both routes return the same points, but the filter below returns a
  // DIFFERENT ARRAY OBJECT, and one more array object here means one more spatial grid over ~18,500
  // points for the rest of the scan. reelScore.scoreBackdrop is the call site that gets this right.
  if (!(minWeight > 0)) return tells;
  let byWeight = qualifyCache.get(tells);
  if (!byWeight) qualifyCache.set(tells, (byWeight = new Map()));
  let subset = byWeight.get(minWeight);
  if (!subset) byWeight.set(minWeight, (subset = tells.filter((t) => t.w >= minWeight)));
  return subset;
}

/**
 * The scan itself: for each resampled point take the nearest tell within `maxM`, put it on a side,
 * and accumulate.
 *
 * `maxM` is a HARD cutoff and must stay one — never `exp(-d/tau)`. Water is the only sharp signal
 * in the existing rubric precisely because `alongFrac` uses the 120 m `WATER_SIGHT_M` cutoff rather
 * than a decay: measured, adjacent 400 m windows under a decay term differ by only 3.5%, so a decay
 * cannot localise a moment, and localising a moment is the one thing this feature exists to do.
 */
function scanTells(w: RoadWindow, tells: WeightedTell[], maxM: number): PerSide<SideHits> {
  const out: PerSide<SideHits> = {
    left: { frac: 0, nearestM: null },
    right: { frac: 0, nearestM: null },
  };
  const pts = w.pts;
  if (!pts.length || !tells.length || !(maxM > 0)) return out;

  const bearings = travelBearings(w);
  let leftHits = 0;
  let rightHits = 0;
  for (let i = 0; i < pts.length; i++) {
    const hit = nearestWithinM(tells, pts[i], maxM);
    if (!hit) continue;
    const side = sideOf(bearings[i], pts[i], hit.tell.pt);
    const acc = out[side];
    if (acc.nearestM === null || hit.distM < acc.nearestM) acc.nearestM = hit.distM;
    if (side === 'left') leftHits++;
    else rightHits++;
  }
  out.left.frac = leftHits / pts.length;
  out.right.frac = rightHits / pts.length;
  return out;
}

/**
 * Per-side coverage of a plain point set over one window, in the window's STORED direction of
 * travel. For the reverse direction, flip the result with `flipSides` rather than re-scanning — the
 * geometry is identical and only the labels move.
 *
 * Each window point contributes to at most ONE side, the side of its single nearest feature, so
 * `left.frac + right.frac <= 1` and a causeway with water on both sides reads about 0.5/0.5 instead
 * of 1.0/1.0. That under-read is accepted deliberately: a second per-side query would double the
 * cost of the one primitive the whole category runs inside, and the nearest feature is the one that
 * fills the frame. Callers reading a near-even split should treat it as "both sides", not as "half
 * as good on each".
 *
 * Pass a STABLE array. It is wrapped for the grid search and the wrapper is memoised on this
 * array's identity, so a freshly-built list per window rebuilds the spatial index per window.
 */
export function sideScanPoints(
  w: RoadWindow,
  pts: LatLng[],
  maxM: number,
): PerSide<SideHits> {
  return scanTells(w, asTells(pts), maxM);
}

/**
 * As {@link sideScanPoints}, but over weighted tells and counting only those with `t.w >= minWeight`.
 *
 * The threshold is what lets a caller ask for OPEN water (`OPEN_WATER_W` = 0.7) rather than a
 * screened creek, and the distinction is not academic — the Heim Rd Street View audit found 0.25 ha
 * unnamed ponds behind houses and a creek in a wooded gully driving a 7.6 water score with no
 * visible water at all. A backdrop that cannot be seen is not a backdrop.
 *
 * The filter is applied to the candidate set, not to the answer: the nearest tell overall may be a
 * ditch, and the lake 300 m out behind it is still the thing in frame.
 *
 * Pass a STABLE array — see {@link sideScanPoints}.
 */
export function sideScanWeighted(
  w: RoadWindow,
  tells: WeightedTell[],
  maxM: number,
  minWeight: number,
): PerSide<SideHits> {
  return scanTells(w, qualifying(tells, minWeight), maxM);
}
