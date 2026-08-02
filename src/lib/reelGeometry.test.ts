import { describe, it, expect } from 'vitest';
import {
  resampleAlong,
  headingChangeDeg,
  drama10,
  cutWindows,
  suppressNearby,
  chordBearingDeg,
  tangentBearingAt,
} from './reelGeometry';
import { bearing, flowCurvature, haversine, pathLength, type LatLng } from './geometry';
import { sampleAlong } from './elevation';
import {
  FULL_HEADING_CHANGE_DEG,
  NMS_RADIUS_M,
  RESAMPLE_M,
  STRIDE_M,
  WINDOW_M,
  type RoadWindow,
} from './reelTypes';

// Every expectation below is derived from geometry rather than read off a run of this code. Two
// closed forms do most of the work:
//
//  1. A polyline inscribed in a circular arc of total turn THETA at N points has N-1 chords whose
//     bearings are equally spaced by THETA/(N-1), hence N-2 junctions, hence total unsigned turning
//     of exactly THETA*(N-2)/(N-1). The missing THETA/(N-1) is the half-chord at each end, which
//     carries turning but has no junction to record it at. So a quarter circle at 8 points reads
//     77.1 and NOT 90 — a test asserting 90 there would be asserting a wish.
//  2. `bearing()` rounds to whole degrees, but over a monotone turn the summed deltas telescope to
//     round(last) - round(first), so the quantization error of a whole window is ~1 deg no matter
//     how many samples it holds. Tolerances below are 1.5 deg on that basis. That applies to
//     `headingChangeDeg`, which still uses `bearing()` because a telescoping total is where the
//     rounding is provably harmless. `chordBearingDeg`, `tangentBearingAt` and `RoadWindow.bearingDeg`
//     do NOT round — they are angles that get compared against other angles — so their tolerances
//     below are hundredths of a degree and come from the equirectangular frame, not from rounding.
//
// Test geometry is built in metres east/north of a WNY origin, converted with the SAME sphere
// radius `haversine` uses, so a constructed 400 m leg measures 400 m to within a millimetre and the
// expected sample counts are exact rather than approximate.

const R_M = 6371000;
const M_PER_DEG = (R_M * Math.PI) / 180;
const ORIGIN: LatLng = [42.9, -78.85];
const LON_SCALE = Math.cos((ORIGIN[0] * Math.PI) / 180);
const D2R = Math.PI / 180;

/** A point `eastM` east and `northM` north of {@link ORIGIN}. */
function pt(eastM: number, northM: number): LatLng {
  return [ORIGIN[0] + northM / M_PER_DEG, ORIGIN[1] + eastM / (M_PER_DEG * LON_SCALE)];
}

/** Ground distance in metres, so expectations can be stated in the same units they were built in. */
const distM = (a: LatLng, b: LatLng): number => haversine(a, b) * 1000;

/**
 * Assert a total turning against its closed form. The tolerance is 1.5 deg everywhere and does NOT
 * scale with sample count: `bearing()` rounds to whole degrees, but over a monotone turn the summed
 * deltas telescope to round(last) - round(first), so a 91-point arc is quantized no worse than a
 * 3-point corner. Measured against the closed forms below the residual runs ~0.8 deg.
 */
function expectDeg(actual: number, expected: number, tolDeg = 1.5): void {
  expect(actual).toBeGreaterThan(expected - tolDeg);
  expect(actual).toBeLessThan(expected + tolDeg);
}

/**
 * Separation between two bearings (deg), in [0, 180]. Bearings live on a circle, so 359.99 and 0.01
 * are 0.02 apart and not 359.98 — and an unrounded bearing landing a hair either side of due north
 * is exactly the case where a plain subtraction lies.
 */
function bearingGapDeg(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

/** Perpendicular distance (m) from `p` to the infinite line through a→b. Zero iff p is collinear. */
function crossTrackM(a: LatLng, b: LatLng, p: LatLng): number {
  const v = [(b[0] - a[0]) * M_PER_DEG, (b[1] - a[1]) * M_PER_DEG * LON_SCALE];
  const w = [(p[0] - a[0]) * M_PER_DEG, (p[1] - a[1]) * M_PER_DEG * LON_SCALE];
  return Math.abs(v[0] * w[1] - v[1] * w[0]) / Math.hypot(v[0], v[1]);
}

/**
 * `n` points evenly spaced around a right-hand circular arc: starting at (startEastM, startNorthM)
 * travelling on compass `headingDeg`, turning `sweepDeg` in total on radius `radiusM`. Arc length is
 * radiusM * sweepDeg in radians, which is how the radii below were chosen to hit a target length.
 */
function arcPoints(
  startEastM: number,
  startNorthM: number,
  headingDeg: number,
  sweepDeg: number,
  radiusM: number,
  n: number,
): LatLng[] {
  const cx = startEastM + radiusM * Math.cos(headingDeg * D2R);
  const cy = startNorthM - radiusM * Math.sin(headingDeg * D2R);
  const out: LatLng[] = [];
  for (let k = 0; k < n; k++) {
    const h = (headingDeg + (sweepDeg * k) / (n - 1)) * D2R;
    out.push(pt(cx - radiusM * Math.cos(h), cy + radiusM * Math.sin(h)));
  }
  return out;
}

/** Two legs of `legM` each meeting at a `turnDeg` corner, starting due north. */
function kink(turnDeg: number, legM: number): LatLng[] {
  return [
    pt(0, 0),
    pt(0, legM),
    pt(legM * Math.sin(turnDeg * D2R), legM + legM * Math.cos(turnDeg * D2R)),
  ];
}

/** A straight road digitized every `stepM` with `sigmaM` of lateral noise, deterministic per seed. */
function jitteredLine(seed: number, stepM: number, count: number, sigmaM: number): LatLng[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: LatLng[] = [];
  for (let k = 0; k < count; k++) out.push(pt((rand() * 2 - 1) * sigmaM, k * stepM));
  return out;
}

describe('resampleAlong — interpolates by ground distance', () => {
  it('cuts a 1000 m line into 11 points 100 m apart, endpoints exact', () => {
    // Three vertices, so the segment cursor has to cross one on the way.
    const line: LatLng[] = [pt(0, 0), pt(0, 370), pt(0, 1000)];
    const out = resampleAlong(line, 100);
    expect(out.length).toBe(11);
    expect(out[0]).toEqual(line[0]);
    expect(out[10]).toEqual(line[2]);
    for (let i = 1; i < out.length; i++) {
      expect(distM(out[i - 1], out[i])).toBeGreaterThan(99);
      expect(distM(out[i - 1], out[i])).toBeLessThan(101);
    }
  });

  it('returns 17 points for a TWO-POINT 400 m segment — where sampleAlong returns 2', () => {
    // The headline case. Half of real 400 m windows hold fewer than three OSM vertices, so a
    // resampler that snaps to vertices cannot resolve them at all.
    const seg: LatLng[] = [pt(0, 0), pt(0, 400)];
    const out = resampleAlong(seg, RESAMPLE_M);
    expect(out.length).toBe(17);
    expect(new Set(out.map((p) => p.join(','))).size).toBe(17);

    expect(sampleAlong(seg, { spacingKm: 0.025, minN: 17, maxN: 17 }).length).toBe(2);
  });

  it('resolves a 3-vertex window that sampleAlong can only see 3 places in', () => {
    const win: LatLng[] = [pt(0, 0), pt(0, 200), pt(0, 400)];
    const snapped = sampleAlong(win, { spacingKm: 0.025, minN: 17, maxN: 17 });
    expect(snapped.length).toBe(17);
    // 17 entries, 3 distinct — and averaging them weights the three vertices 1 : 8 : 8.
    expect(new Set(snapped.map((p) => p.join(','))).size).toBe(3);

    expect(new Set(resampleAlong(win, RESAMPLE_M).map((p) => p.join(','))).size).toBe(17);
  });

  it('places interpolated points ON the segment, at the right distances', () => {
    const a = pt(0, 0);
    const b = pt(300, 400); // 3-4-5: exactly 500 m
    const out = resampleAlong([a, b], 25);
    expect(out.length).toBe(21);
    out.forEach((p, i) => {
      expect(crossTrackM(a, b, p)).toBeLessThan(0.05);
      expect(distM(a, p)).toBeCloseTo(25 * i, 1);
    });
  });

  it('survives degenerate input without dividing by zero', () => {
    const p = pt(0, 0);
    expect(resampleAlong([], 25)).toEqual([]);
    expect(resampleAlong([p], 25)).toEqual([p]);
    // Every vertex coincident: no length, no direction, one place.
    expect(resampleAlong([p, p, p], 25)).toEqual([p]);

    const withDup: LatLng[] = [pt(0, 0), pt(0, 200), pt(0, 200), pt(0, 400)];
    const out = resampleAlong(withDup, 25);
    expect(out.length).toBe(17);
    for (const q of out) {
      expect(Number.isFinite(q[0])).toBe(true);
      expect(Number.isFinite(q[1])).toBe(true);
    }
    for (let i = 1; i < out.length; i++) expect(distM(out[i - 1], out[i])).toBeCloseTo(25, 1);
  });

  it('falls back to the two endpoints when the spacing exceeds the path', () => {
    const line: LatLng[] = [pt(0, 0), pt(0, 100)];
    expect(resampleAlong(line, 250)).toEqual(line);
    expect(resampleAlong(line, 0)).toEqual(line);
  });
});

describe('headingChangeDeg — total unsigned turning', () => {
  it('is 0 on a straight line', () => {
    expect(headingChangeDeg(resampleAlong([pt(0, 0), pt(0, 1000)], 25))).toBe(0);
    // ...including one that is not axis-aligned, where every bearing is 37 deg rather than 0.
    expect(headingChangeDeg(resampleAlong([pt(0, 0), pt(300, 400)], 25))).toBeLessThan(1);
  });

  it('reads a right-angle corner as 90', () => {
    expectDeg(headingChangeDeg([pt(0, 0), pt(0, 200), pt(200, 200)]), 90);
  });

  it('reads a quarter circle at 8 points as 90 * 6/7, converging to 90 when sampled finely', () => {
    // The (N-2)/(N-1) deficit is a property of measuring turning at junctions of an inscribed
    // polygon, not an error: the first and last half-chords turn but have no junction.
    expectDeg(headingChangeDeg(arcPoints(0, 0, 0, 90, 200, 8)), (90 * 6) / 7);
    expectDeg(headingChangeDeg(arcPoints(0, 0, 0, 90, 200, 91)), (90 * 89) / 90);
  });

  it('reads a 180-degree hairpin at its full magnitude', () => {
    expectDeg(headingChangeDeg(arcPoints(0, 0, 0, 180, 50, 37)), (180 * 35) / 36);
  });

  it('wraps across north: 350 deg then 010 deg is a 20 deg turn, not 340', () => {
    const crossing: LatLng[] = [
      pt(0, 0),
      pt(200 * Math.sin(350 * D2R), 200 * Math.cos(350 * D2R)),
      pt(0, 2 * 200 * Math.cos(10 * D2R)),
    ];
    expectDeg(headingChangeDeg(crossing), 20);
  });

  it('reads an 80-degree kink as 80 — FLOW_MAX_TURN makes flowCurvature call it 0.0', () => {
    // An 80 deg kink is the most filmable corner there is. `flowCurvature` drops any turn over 75
    // deg as a junction, so the best corner on the road scores identically to a dead straight.
    const corner = kink(80, 200);
    expectDeg(headingChangeDeg(corner), 80);
    expect(flowCurvature(corner)).toBe(0);
  });

  it('ignores coincident points instead of reading them as a swing to north', () => {
    const p = pt(0, 100);
    expect(headingChangeDeg([pt(0, 0), p, p, pt(0, 200)])).toBe(0);
  });

  it('returns 0 for fewer than two segments', () => {
    expect(headingChangeDeg([])).toBe(0);
    expect(headingChangeDeg([pt(0, 0)])).toBe(0);
    expect(headingChangeDeg([pt(0, 0), pt(0, 100)])).toBe(0);
  });
});

describe('headingChangeDeg — survives the resampling that FLOW_MIN_TURN cannot', () => {
  // A 45 deg arc ~400 m long: the road Reel must be able to see inside a single window.
  const R45 = 400 / (45 * D2R);
  const coarse = arcPoints(0, 0, 0, 45, R45, 9); // ~50 m vertices, as OSM might digitize it
  const fine = arcPoints(0, 0, 0, 45, R45, 17); // the same road at Reel's 25 m sampling

  it('holds its total turning when the same arc is sampled twice as finely', () => {
    expectDeg(headingChangeDeg(coarse), (45 * 7) / 8);
    expectDeg(headingChangeDeg(fine), (45 * 15) / 16);
    // Both readings describe the same road, and everything that separates them is accounted for:
    // the end deficit shrinks from 45/8 to 45/16 as the sampling doubles (2.8 deg), plus up to a
    // degree of bearing quantization in each reading. Nothing else may creep in.
    expect(Math.abs(headingChangeDeg(fine) - headingChangeDeg(coarse)))
      .toBeLessThan(45 * (1 / 8 - 1 / 16) + 2);
  });

  it('while flowCurvature falls from 6.9 to 0.0 on that same refinement', () => {
    // 45/8 = 5.6 deg per vertex clears FLOW_MIN_TURN; 45/16 = 2.8 deg does not, so every scrap of
    // turning is discarded as digitizer jitter. This is why resampling could not be bolted onto
    // flowCurvature — refining the sampling destroys the signal instead of sharpening it.
    expect(flowCurvature(coarse)).toBeGreaterThan(5);
    expect(flowCurvature(fine)).toBe(0);
  });

  it('is preserved when resampleAlong re-cuts a polyline at a non-aligned spacing', () => {
    // Turning lives at the vertices; resampling either lands on one (angle kept whole) or steps
    // over it (angle split between two junctions summing to the same). 17 m divides neither the
    // 50 m vertex spacing nor the 400 m length, so no alignment is doing the work here.
    expectDeg(headingChangeDeg(resampleAlong(coarse, 17)), headingChangeDeg(coarse));
  });

  it('attenuates digitizer jitter by resampling, which is the only floor it has', () => {
    // Removing FLOW_MIN_TURN means lateral digitizing noise now counts as turning. The replacement
    // filter is DISTANCE (25 m resampling), which leaves a real sweeper intact where an angle floor
    // would not. The +/-1 m noise amplitude here is INVENTED as a stand-in for GPS-trace scatter —
    // the claim under test is only the direction and rough scale of the effect, not a calibration.
    const raw = jitteredLine(20260801, 10, 41, 1);
    const rawTurn = headingChangeDeg(raw);
    const resampledTurn = headingChangeDeg(resampleAlong(raw, RESAMPLE_M));
    // A dead straight road read at 10 m vertices totals hundreds of degrees, i.e. saturated drama.
    expect(rawTurn).toBeGreaterThan(100);
    // Junction count falls ~2.5x and each junction's angle falls ~2.5x, so ~1/6 of the raw reading.
    expect(resampledTurn).toBeLessThan(rawTurn / 2);
  });
});

describe('drama10', () => {
  it('is not structurally 0 on a 200 m window — flowCurvature\'s dist floor makes it so', () => {
    const short = kink(60, 100); // 200 m of road with a 60 deg corner in the middle
    expect(pathLength(short)).toBeCloseTo(0.2, 2);
    expect(drama10(short)).toBeCloseTo((60 / FULL_HEADING_CHANGE_DEG) * 10, 1);
    expect(flowCurvature(short)).toBe(0); // dist < 0.3 km, so every window under 300 m reads 0
  });

  it('does not divide by length: one 60 deg corner scores the same over 200 m and 400 m', () => {
    const short = kink(60, 100);
    const long = kink(60, 200);
    expect(drama10(short)).toBeCloseTo(4, 1);
    expect(drama10(long)).toBeCloseTo(4, 1);
    // The same corner through flowCurvature: 0.0 at 200 m and saturated at 400 m. Dividing by
    // distance is what leaves its usable range at window scale as essentially {0, 10}.
    expect(flowCurvature(short)).toBe(0);
    expect(flowCurvature(long)).toBe(10);
  });

  it('maps 0 / FULL_HEADING_CHANGE_DEG / beyond onto 0 / 10 / 10', () => {
    expect(drama10(resampleAlong([pt(0, 0), pt(0, 400)], 25))).toBe(0);
    // A sweep of exactly FULL_HEADING_CHANGE_DEG, sampled finely enough that the end deficit is
    // under a degree, must reach the top of the scale without exceeding it.
    expect(drama10(arcPoints(0, 0, 0, 152, 150, 200))).toBe(10);
    expect(drama10(arcPoints(0, 0, 0, 300, 100, 61))).toBe(10);
  });

  it('lands a 90 deg bend at 6 and rounds to one decimal', () => {
    const v = drama10([pt(0, 0), pt(0, 200), pt(200, 200)]);
    expect(v).toBeGreaterThanOrEqual(5.9);
    expect(v).toBeLessThanOrEqual(6.1);
    expect(v * 10).toBeCloseTo(Math.round(v * 10), 6);
  });
});

describe('chordBearingDeg — unrounded, which bearing() is not', () => {
  it('reads the four cardinals exactly', () => {
    expect(chordBearingDeg(pt(0, 0), pt(0, 100))).toBe(0);
    expect(chordBearingDeg(pt(0, 0), pt(100, 0))).toBeCloseTo(90, 6);
    expect(chordBearingDeg(pt(0, 0), pt(0, -100))).toBeCloseTo(180, 6);
    expect(chordBearingDeg(pt(0, 0), pt(-100, 0))).toBeCloseTo(270, 6);
  });

  it('keeps the fractional degrees that bearing() throws away', () => {
    // 100 m east per 1000 m north. atan2(100, 1000) = 5.710593 deg by hand; bearing() says 6.
    const a = pt(0, 0);
    const b = pt(100, 1000);
    expect(chordBearingDeg(a, b)).toBeCloseTo(Math.atan2(100, 1000) / D2R, 2);
    expect(bearing(a, b)).toBe(6);
    // Half a degree is the quantum, and it is exactly the size of the error that decides which side
    // of the rider a feature 0.3 deg off the travel axis is on.
    expect(Math.abs(chordBearingDeg(a, b) - bearing(a, b))).toBeGreaterThan(0.28);
  });

  it('stays within 0.002 deg of the great-circle bearing over a window-length chord', () => {
    // The price of the equirectangular frame, measured rather than assumed: half the meridian
    // convergence, worst at due east, ~300x smaller than the 0.5 deg quantum it removes.
    let worst = 0;
    for (let deg = 0; deg < 360; deg++) {
      const b = pt(WINDOW_M * Math.sin(deg * D2R), WINDOW_M * Math.cos(deg * D2R));
      const delta = bearingGapDeg(chordBearingDeg(pt(0, 0), b), bearing(pt(0, 0), b));
      // bearing() is rounded, so its own half-degree is subtracted before the frames are compared.
      worst = Math.max(worst, Math.max(0, delta - 0.5));
    }
    expect(worst).toBeLessThan(0.002);
  });

  it('returns 0 for coincident points rather than NaN', () => {
    // atan2(0, 0) is 0, i.e. a phantom due north. The signature is total on purpose; callers that
    // care test for coincidence themselves.
    expect(chordBearingDeg(pt(0, 0), pt(0, 0))).toBe(0);
  });

  it('never returns 360', () => {
    // A hair west of north wraps to just under 360, and a caller bucketing by compass point would
    // land outside the array if it ever came back as exactly 360.
    for (const eastM of [-1e-6, -1e-9, -1e-12]) {
      const v = chordBearingDeg(pt(0, 0), pt(eastM, 1000));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(360);
    }
  });
});

describe('tangentBearingAt — the LOCAL direction of travel, not the window chord', () => {
  // A quarter circle at 9 points: 8 chords, each turning 90/8 = 11.25 deg. On a circular arc the
  // chord from sample k to k+1 bisects the tangents at its ends, so chord k has bearing
  // 5.625 + 11.25k and the mean of the two chords either side of an interior sample is that
  // sample's true tangent, 90k/8, exactly. All hand-derived; none of it read off a run.
  const arc = arcPoints(0, 0, 0, 90, 200, 9);

  it('returns the true tangent at every interior sample of a quarter circle', () => {
    for (let i = 1; i <= 7; i++) expect(tangentBearingAt(arc, i)).toBeCloseTo((90 * i) / 8, 2);
    // The midpoint especially: 45 deg, which is also where it coincides with the chord.
    expect(tangentBearingAt(arc, 4)).toBeCloseTo(45, 2);
  });

  it('differs from the window chord by 45 deg at the ends of a quarter arc', () => {
    // This is the whole reason the function exists: reelTerrain aims its probes off the chord while
    // sideScan classifies off the local tangent, so on a curving window the two mechanisms put the
    // same feature on opposite sides. A quarter arc is the extreme — the chord bisects the sweep.
    const chord = chordBearingDeg(arc[0], arc[arc.length - 1]);
    expect(chord).toBeCloseTo(45, 2);
    // A one-sided chord at the ends lags the true tangent by half a step (11.25/2 = 5.625 deg), so
    // the measured divergence is 45 - 5.625 = 39.375 rather than the full 45.
    expect(tangentBearingAt(arc, 0)).toBeCloseTo(5.625, 2);
    expect(tangentBearingAt(arc, 8)).toBeCloseTo(90 - 5.625, 2);
    expect(Math.abs(tangentBearingAt(arc, 0) - chord)).toBeCloseTo(39.375, 2);
    expect(Math.abs(tangentBearingAt(arc, 8) - chord)).toBeCloseTo(39.375, 2);
  });

  it('shrinks the end bias to half a step as the sampling refines', () => {
    // 181 points is 0.5 deg per chord, so the end bias is 0.25 deg and the endpoint divergence from
    // the chord converges on the true 45.
    const fine = arcPoints(0, 0, 0, 90, 200, 181);
    expect(tangentBearingAt(fine, 0)).toBeCloseTo(0.25, 2);
    expect(Math.abs(tangentBearingAt(fine, 0) - chordBearingDeg(fine[0], fine[180])))
      .toBeCloseTo(44.75, 2);
  });

  it('is the line bearing at every sample of a straight road', () => {
    const line = resampleAlong([pt(0, 0), pt(100, 1000)], RESAMPLE_M);
    const trueDeg = Math.atan2(100, 1000) / D2R;
    for (let i = 0; i < line.length; i++) expect(tangentBearingAt(line, i)).toBeCloseTo(trueDeg, 2);
  });

  it('wraps across north instead of averaging to south', () => {
    // Chords of 350 and 010 deg average to 0, not to 180. A naive mean of the two numbers gives
    // exactly the direction the rider is travelling AWAY from.
    const pts: LatLng[] = [
      // 100 m back down a bearing of 350, so the chord INTO the middle point runs at 350...
      pt(-100 * Math.sin(350 * D2R), -100 * Math.cos(350 * D2R)),
      pt(0, 0),
      // ...and 100 m on at 010, so the chord OUT of it runs at 010.
      pt(100 * Math.sin(10 * D2R), 100 * Math.cos(10 * D2R)),
    ];
    expect(chordBearingDeg(pts[0], pts[1])).toBeCloseTo(350, 1);
    expect(chordBearingDeg(pts[1], pts[2])).toBeCloseTo(10, 1);
    // Compared on the circle: the answer is due north to within 1e-4 deg, and the range is [0, 360),
    // so it may legitimately come back as 359.9999 rather than 0.0001.
    expect(bearingGapDeg(tangentBearingAt(pts, 1), 0)).toBeLessThan(0.05);
  });

  it('steps over coincident neighbours instead of reading them as due north', () => {
    // `atan2(0, 0)` is 0. A duplicated vertex beside an east-west road would otherwise swing the
    // local direction 45 deg towards north.
    const p = pt(100, 0);
    const pts: LatLng[] = [pt(0, 0), p, p, pt(200, 0)];
    expect(tangentBearingAt(pts, 1)).toBeCloseTo(90, 2);
    expect(tangentBearingAt(pts, 2)).toBeCloseTo(90, 2);
  });

  it('clamps the index and survives inputs with no direction at all', () => {
    const line = resampleAlong([pt(0, 0), pt(0, 400)], RESAMPLE_M);
    expect(tangentBearingAt(line, -5)).toBe(tangentBearingAt(line, 0));
    expect(tangentBearingAt(line, 999)).toBe(tangentBearingAt(line, line.length - 1));
    expect(tangentBearingAt([], 0)).toBe(0);
    expect(tangentBearingAt([pt(0, 0)], 0)).toBe(0);
    const p = pt(0, 0);
    expect(tangentBearingAt([p, p, p], 1)).toBe(0);
  });
});

describe('cutWindows', () => {
  const road = (id: string, coords: LatLng[]) => ({ id, name: `${id} Rd`, coords });

  it('cuts a 1000 m road into windows every STRIDE_M, every one of them full length', () => {
    // 1000 m resamples to 41 points exactly 25 m apart, so windows start at indices 0/8/16/24. The
    // index-32 window would run only to the road end, 200 m away, and 200 m is not a score that can
    // be compared with a 400 m one.
    const ws = cutWindows(road('A', [pt(0, 0), pt(0, 1000)]));
    expect(ws.map((w) => Math.round(w.startM))).toEqual([0, 200, 400, 600]);
    expect(ws.map((w) => Math.round(w.lengthM))).toEqual([400, 400, 400, 400]);
    expect(ws.map((w) => w.id)).toEqual(['A@0', 'A@200', 'A@400', 'A@600']);
    for (const w of ws) {
      expect(w.roadId).toBe('A');
      expect(w.roadName).toBe('A Rd');
      expect(w.bearingDeg).toBe(0); // due north
    }
  });

  it('never emits a window shorter than 0.9 x WINDOW_M, at any road length', () => {
    // C6. The floor used to be WINDOW_M/2: on the real 83-tile corpus that admitted 1,669 windows
    // of which 16.2% were under 380 m and 5.0% were at or under 260 m, minimum 200 m. Two of the
    // four scored dimensions are then length-biased in OPPOSITE directions, so the error does not
    // even wash out — `drama10` is an undivided total and a 200 m window can only accumulate half
    // the turning, while `junctionsPerKm` divides by lengthM and reads one physical junction as
    // 5.0/km instead of 2.5/km (cleanliness 1.7 against 5.8, and only the short window earns the
    // `urban` tag). Sweeping the road length in 25 m steps walks the stride through every phase
    // against the road end, so no length can hide a short tail.
    for (let roadM = 300; roadM <= 1500; roadM += 25) {
      const ws = cutWindows(road(`S${roadM}`, [pt(0, 0), pt(0, roadM)]));
      for (const w of ws) expect(w.lengthM).toBeGreaterThanOrEqual(WINDOW_M * 0.9 - 1e-9);
    }
  });

  it('loses at most MIN_WINDOW_M - STRIDE_M of road to the dropped tail', () => {
    // The other half of C6: dropping the tail is free. The window before it already overlaps the
    // last STRIDE_M of road, so the unscored ground is bounded by 0.9*400 - 200 = 160 m, and it is
    // the far end of a stretch that has already been looked at.
    for (let roadM = 400; roadM <= 1500; roadM += 25) {
      const ws = cutWindows(road(`T${roadM}`, [pt(0, 0), pt(0, roadM)]));
      expect(ws.length).toBeGreaterThan(0);
      const last = ws[ws.length - 1];
      expect(roadM - (last.startM + last.lengthM)).toBeLessThan(WINDOW_M * 0.9 - STRIDE_M + 1e-6);
    }
  });

  it('keeps a clipped tail window that is still within 10% of full length', () => {
    // 975 m is exactly 39 steps of 25 m, so the index-24 window is clipped to 375 m — short, but
    // inside the tolerance the resampler itself needs (a whole number of samples puts a nominal
    // 400 m window anywhere in 387.5–412.5 m). The index-32 window would be 175 m and is dropped.
    const ws = cutWindows(road('B', [pt(0, 0), pt(0, 975)]));
    expect(ws.map((w) => Math.round(w.startM))).toEqual([0, 200, 400, 600]);
    expect(ws.map((w) => Math.round(w.lengthM))).toEqual([400, 400, 400, 375]);
  });

  it('drops a 300 m trailing window that the old WINDOW_M/2 floor kept', () => {
    // 900 m: the index-24 window runs 600–900 m. It used to be emitted and scored against full
    // windows, so `drama10` could see at most three quarters of the turning it should have.
    const ws = cutWindows(road('B2', [pt(0, 0), pt(0, 900)]));
    expect(ws.map((w) => Math.round(w.startM))).toEqual([0, 200, 400]);
    expect(ws.map((w) => Math.round(w.lengthM))).toEqual([400, 400, 400]);
  });

  it('yields nothing for a road under 0.9 x WINDOW_M, or with no length', () => {
    expect(cutWindows(road('C', [pt(0, 0), pt(0, 150)]))).toEqual([]);
    // 350 m clears the old WINDOW_M/2 floor and used to produce a single 350 m window.
    expect(cutWindows(road('C2', [pt(0, 0), pt(0, 350)]))).toEqual([]);
    // 380 m clears 0.9 x WINDOW_M, so the road itself is one window.
    expect(cutWindows(road('C3', [pt(0, 0), pt(0, 380)])).map((w) => Math.round(w.lengthM)))
      .toEqual([380]);
    expect(cutWindows(road('D', [pt(0, 0)]))).toEqual([]);
    expect(cutWindows(road('E', []))).toEqual([]);
    expect(cutWindows(road('F', [pt(0, 0), pt(0, 0)]))).toEqual([]);
  });

  it('spaces every window\'s points at RESAMPLE_M', () => {
    // 1000 m is a whole number of 25 m steps, so the spacing is exactly RESAMPLE_M. 1013 m is not:
    // the resampler stretches its interval so both road endpoints land on samples, giving
    // 1013/41 = 24.71 m. That deviation is bounded by half a step over the sample count, i.e. under
    // 2% here, and it is why startM is derived from the spacing actually used rather than assumed.
    for (const [id, lengthM, tolM] of [['G', 1000, 0.05], ['H', 1013, 0.5]] as const) {
      for (const w of cutWindows(road(id, [pt(0, 0), pt(0, lengthM)]))) {
        for (let i = 1; i < w.pts.length; i++) {
          expect(Math.abs(distM(w.pts[i - 1], w.pts[i]) - RESAMPLE_M)).toBeLessThan(tolM);
        }
        expect(w.pts.length).toBe(Math.round(w.lengthM / RESAMPLE_M) + 1);
      }
    }
  });

  it('anchors mid at the middle of the road, not the middle of the array', () => {
    const ws = cutWindows(road('I', [pt(0, 0), pt(0, 975)]));
    expect(distM(ws[0].mid, pt(0, 200))).toBeLessThan(0.5);
    expect(distM(ws[1].mid, pt(0, 400))).toBeLessThan(0.5);
    // The clipped tail window runs 600–975 m, so its midpoint sits at 787.5 m — an even sample
    // count, so it is interpolated between two samples rather than read off one.
    expect(distM(ws[3].mid, pt(0, 787.5))).toBeLessThan(0.5);
  });

  it('takes bearingDeg from the chord, which is the only direction a rider travels', () => {
    // A hairpin: 300 m north, then back south-ish to (20 m east, 100 m north). The first window
    // covers 400 m of that, ending ~100 m down the return leg at (10 m, 200 m) — a chord bearing of
    // atan2(10, 200) = 3 deg. Averaging the per-segment bearings instead gives ~44 deg, a heading
    // that points off across the hairpin and that nobody ever rides.
    const w = cutWindows(road('J', [pt(0, 0), pt(0, 300), pt(20, 100)]))[0];
    expect(w.bearingDeg).toBeLessThan(10);
    expect(w.bearingDeg).toBe(chordBearingDeg(w.pts[0], w.pts[w.pts.length - 1]));

    let naive = 0;
    for (let i = 1; i < w.pts.length; i++) naive += bearing(w.pts[i - 1], w.pts[i]);
    expect(naive / (w.pts.length - 1)).toBeGreaterThan(30);
  });

  it('reports bearingDeg UNROUNDED, where bearing() would quantise it to a whole degree', () => {
    // S1. A road running 100 m east for every 1000 m north: atan2(100, 1000) = 5.7106 deg,
    // hand-computed from the metres the road was built in and not read off this code. `bearing()`
    // returns 6, and sideScan.ts refuses that same rounding for its own chord bearing because half a
    // degree of quantisation sits exactly on the left/right boundary — so the terrain half was
    // carrying the error the water half was written to avoid.
    const trueDeg = Math.atan2(100, 1000) / D2R;
    expect(trueDeg).toBeCloseTo(5.7106, 4);
    const ws = cutWindows(road('L', [pt(0, 0), pt(100, 1000)]));
    expect(ws.length).toBeGreaterThan(1);
    for (const w of ws) {
      // Within a hundredth of a degree: the residual is the cos(mean latitude) of each window's own
      // chord against the fixed cos used to build the test frame, ~7e-4 deg over 1 km of northing.
      expect(w.bearingDeg).toBeCloseTo(trueDeg, 2);
      // The fractional part is the whole point, and it is 0.29 deg away from what bearing() returns.
      expect(w.bearingDeg).not.toBe(Math.round(w.bearingDeg));
      expect(bearing(w.pts[0], w.pts[w.pts.length - 1])).toBe(6);
    }
  });

  it('makes adjacent windows overlap by half, so no stretch straddles a boundary unseen', () => {
    const ws = cutWindows(road('K', [pt(0, 0), pt(0, 1000)]));
    expect(ws[1].startM - ws[0].startM).toBeCloseTo(STRIDE_M, 6);
    // The second half of window 0 is byte-identical to the first half of window 1: the road is
    // resampled once and the windows are index slices of it, so overlapping windows cannot disagree
    // about the ground they share.
    const strideIdx = STRIDE_M / RESAMPLE_M;
    expect(ws[0].pts.slice(strideIdx)).toEqual(ws[1].pts.slice(0, WINDOW_M / RESAMPLE_M - strideIdx + 1));
  });
});

describe('suppressNearby', () => {
  const mark = (
    roadId: string,
    eastM: number,
    northM: number,
    score: number,
    bearingDeg = 0,
  ) => ({
    window: {
      id: `${roadId}@${northM}`,
      roadId,
      roadName: roadId,
      pts: [],
      startM: northM,
      lengthM: WINDOW_M,
      mid: pt(eastM, northM),
      bearingDeg,
    } satisfies RoadWindow,
    score,
  });

  it('keeps the strongest mark and drops a weaker one inside the radius', () => {
    const kept = suppressNearby([mark('A', 0, 0, 4), mark('A', 0, 100, 9)]);
    expect(kept.map((m) => m.score)).toEqual([9]);
  });

  it('keeps a mark beyond the radius', () => {
    // Default radius is NMS_RADIUS_M (400 m), so 500 m of separation is a different moment.
    const kept = suppressNearby([mark('A', 0, 0, 4), mark('A', 0, 500, 9)]);
    expect(kept.map((m) => m.score)).toEqual([9, 4]);
    expect(NMS_RADIUS_M).toBeLessThan(500);
  });

  it('never suppresses across a CROSSROADS, however close the two roads are', () => {
    // Two roads point different ways at different backdrops, and a rider cannot film both from one
    // place, so deleting either would be silently discarding a real shot. 5 m apart and 90 deg
    // apart: the collinearity test fails, the original rule holds.
    const kept = suppressNearby([mark('A', 0, 0, 9, 0), mark('B', 5, 5, 4, 90), mark('A', 0, 10, 8, 0)]);
    expect(kept.map((m) => m.window.roadId)).toEqual(['A', 'B']);
  });

  it('collapses one road split across two OSM ways — the near-parallel case', () => {
    // S2, measured on a real top-40: scan-83666787 and "Como Lake Park#scan-83666795" sat 152 m
    // apart with bearings 5 deg apart. OSM splits ways at TAG changes and not only at junctions, so
    // one physical road carries several ids and the roadId-only rule could never see it. Both marks
    // are the same shot and they consumed two shortlist slots.
    const kept = suppressNearby([
      mark('scan-83666787', 0, 0, 9, 20),
      mark('Como Lake Park#scan-83666795', 0, 152, 6, 25),
    ]);
    expect(kept.map((m) => m.window.roadId)).toEqual(['scan-83666787']);
  });

  it('collapses one road split across two OSM ways — the ANTIPARALLEL case', () => {
    // The second measured pair: scan-83666787 and scan-106973377, 210 m apart with a 157 deg
    // bearing difference, i.e. 23 deg off antiparallel. Way direction in OSM is arbitrary, so two
    // halves of one road are routinely digitized nose-to-nose; antiparallel is the same road ridden
    // the other way and must count as collinear.
    const kept = suppressNearby([
      mark('scan-83666787', 0, 0, 9, 20),
      mark('scan-106973377', 0, 210, 6, 177),
    ]);
    expect(kept.map((m) => m.window.roadId)).toEqual(['scan-83666787']);
  });

  it('keeps two nearby roads whose bearings are not collinear either way', () => {
    // The tolerance is 30 deg, set by that 23-deg-off-antiparallel measurement. A fork at 40 deg, a
    // crossroads at 90 and an oblique crossing at 140 are all different shots and all survive.
    for (const bearingDeg of [40, 90, 140]) {
      expect(suppressNearby([mark('A', 0, 0, 9, 0), mark('B', 0, 50, 4, bearingDeg)])).toHaveLength(2);
    }
  });

  it('applies the radius to collinear roads too — 500 m apart is still two moments', () => {
    expect(suppressNearby([mark('A', 0, 0, 9, 0), mark('B', 0, 500, 4, 0)])).toHaveLength(2);
  });

  it('suppresses two marks on ONE road whatever their bearings', () => {
    // The collinearity test is only reached across roadIds. Two limbs of a hairpin on one way are
    // 90 deg apart and 60 m apart on the ground, and they are still the same moment.
    expect(suppressNearby([mark('A', 0, 0, 9, 0), mark('A', 0, 60, 8, 90)])).toHaveLength(1);
  });

  it('honours an explicit radius', () => {
    const marks = [mark('A', 0, 0, 9), mark('A', 0, 100, 8)];
    expect(suppressNearby(marks, 50).length).toBe(2);
    expect(suppressNearby(marks, 150).length).toBe(1);
  });

  it('returns marks strongest-first and leaves the input untouched', () => {
    // A three-way junction at one point: 60 deg apart, so no pair is collinear and ordering is the
    // only thing under test.
    const marks = [mark('A', 0, 0, 3, 0), mark('B', 0, 0, 7, 60), mark('C', 0, 0, 5, 120)];
    const kept = suppressNearby(marks);
    expect(kept.map((m) => m.score)).toEqual([7, 5, 3]);
    expect(marks.map((m) => m.score)).toEqual([3, 7, 5]);
  });

  it('chains suppression through kept marks only', () => {
    // 0 m / 300 m / 600 m on one road at descending scores. The 600 m mark is 600 m from the winner
    // but only 300 m from the 300 m mark — which was itself suppressed, so it cannot suppress in
    // turn. Greedy NMS compares against KEPT marks, so the 600 m mark survives.
    const kept = suppressNearby([mark('A', 0, 0, 9), mark('A', 0, 300, 8), mark('A', 0, 600, 7)]);
    expect(kept.map((m) => m.score)).toEqual([9, 7]);
  });
});
