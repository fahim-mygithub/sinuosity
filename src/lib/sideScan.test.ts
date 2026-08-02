import { describe, it, expect } from 'vitest';
import { sideOf, sideScanPoints, sideScanWeighted } from './sideScan';
import { bearing, offsetPath, pathLength, type LatLng } from './geometry';
import { flipSides, RESAMPLE_M, WINDOW_M, type RoadWindow } from './reelTypes';
import { OPEN_WATER_W, type WeightedTell } from './sceneryTells';

// These tests check KNOWN GEOMETRY, not what the implementation happens to return. Every expected
// value below is derivable on paper: "heading north, due east is on your right"; the left/right
// boundary for a due-east feature is the pair of bearings that point at and away from it; and for a
// circular arc of radius R traversed with a feature D from the centre, the signed cross product is
// exactly R - D*sin(theta), so the side flips at sin(theta) = R/D and nowhere else.
//
// The failure modes are tested by name, because each one is a bug that would still produce
// plausible-looking scores: a flipped sign (silently swaps every left and right downstream), a
// missing cos-latitude correction (only misclassifies features near the travel axis, ~22% of the
// frame at this latitude), filtering by weight AFTER taking the nearest tell instead of before (a
// ditch hides the lake behind it), and rebuilding the tell array per call (correct answers, dead
// spatial index, unusable scan time).

const LAT0 = 42.9;
const LON0 = -78.85;
// haversine's sphere radius, so a feature placed "100 m east" here measures 100 m under the SAME
// metric the implementation uses. WGS84's 111320 m/deg would be 0.11% off, which the metre-level
// assertions below would see.
const M_PER_DEG = (6371 * 1000 * Math.PI) / 180;
const LON_SCALE = Math.cos(LAT0 * (Math.PI / 180));

/** Local flat projection: metres east / north of (LAT0, LON0). */
function at(eastM: number, northM: number): LatLng {
  return [LAT0 + northM / M_PER_DEG, LON0 + eastM / (M_PER_DEG * LON_SCALE)];
}

function windowOf(pts: LatLng[]): RoadWindow {
  return {
    id: 'test@0',
    roadId: 'test',
    roadName: 'Test Rd',
    pts,
    startM: 0,
    lengthM: pathLength(pts) * 1000,
    mid: pts[Math.floor(pts.length / 2)],
    bearingDeg: pts.length > 1 ? bearing(pts[0], pts[pts.length - 1]) : 0,
  };
}

/** A due-north road of WINDOW_M at the contract's RESAMPLE_M spacing: 17 points, 400 m. */
const N_SAMPLES = WINDOW_M / RESAMPLE_M + 1;
function straightNorth(): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < N_SAMPLES; i++) out.push(at(0, i * RESAMPLE_M));
  return out;
}

const weigh = (pts: LatLng[], w: number): WeightedTell[] => pts.map((pt) => ({ pt, w }));

describe('sideOf — cardinal directions from first principles', () => {
  const here = at(0, 0);
  const dueEast = at(100, 0);
  const dueWest = at(-100, 0);
  const dueNorth = at(0, 100);
  const dueSouth = at(0, -100);

  it('puts a feature due east on the right when heading north, and the left heading south', () => {
    expect(sideOf(0, here, dueEast)).toBe('right');
    expect(sideOf(180, here, dueEast)).toBe('left');
  });

  it('puts a feature due west on the left when heading north, and the right heading south', () => {
    expect(sideOf(0, here, dueWest)).toBe('left');
    expect(sideOf(180, here, dueWest)).toBe('right');
  });

  it('puts a feature due north on the left heading east, and the right heading west', () => {
    expect(sideOf(90, here, dueNorth)).toBe('left');
    expect(sideOf(270, here, dueNorth)).toBe('right');
  });

  it('puts a feature due south on the right heading east, and the left heading west', () => {
    expect(sideOf(90, here, dueSouth)).toBe('right');
    expect(sideOf(270, here, dueSouth)).toBe('left');
  });

  it('classifies a feature on the travel axis deterministically', () => {
    // Riding straight at (or straight away from) the feature: it is on neither side, so WHICH side
    // comes back is meaningless. The requirement is only that it never changes — a flickering side
    // would make a backdrop score depend on floating-point noise. This caught a real one: without
    // normalising the bearing, Math.cos(90 deg) and Math.cos(-270 deg) straddle zero at 1e-16 and
    // the same ride reported opposite sides depending on how the bearing had been arrived at.
    const ahead = sideOf(90, here, dueEast);
    for (const b of [90, 90 + 360, 90 - 360, 90 + 720]) expect(sideOf(b, here, dueEast)).toBe(ahead);
    const behind = sideOf(270, here, dueEast);
    for (const b of [270, 270 + 360, 270 - 360, -90]) expect(sideOf(b, here, dueEast)).toBe(behind);
  });

  it('resolves correctly either side of that axis', () => {
    // The degenerate case above is measure-zero; one metre off the axis the answer must be the
    // physical one. Heading east: a feature slightly north is on the left, slightly south the right.
    expect(sideOf(90, here, at(100, 1))).toBe('left');
    expect(sideOf(90, here, at(100, -1))).toBe('right');
  });
});

describe('sideOf — the cos(latitude) correction is present and load-bearing', () => {
  it('uses ground angles, not raw lat/lon deltas', () => {
    // At 42.9N a degree of longitude is 0.733 of a degree of latitude on the ground. Pick a feature
    // whose RAW deltas (+0.0010 lat, +0.0012 lon) put it at 50.2 deg — right of a 45 deg heading —
    // but whose GROUND vector is at 41.4 deg, i.e. left of it. Without the correction this is
    // misclassified, and it is misclassified silently: only features within ~12 deg of the travel
    // axis flip, so a scan would still look entirely plausible.
    const from: LatLng = [LAT0, LON0];
    const to: LatLng = [LAT0 + 0.001, LON0 + 0.0012];
    expect(sideOf(45, from, to)).toBe('left');

    // The uncorrected cross product, computed here so the test states what it is guarding against.
    const naiveCross =
      Math.cos(45 * (Math.PI / 180)) * (to[1] - from[1]) -
      Math.sin(45 * (Math.PI / 180)) * (to[0] - from[0]);
    expect(naiveCross).toBeGreaterThan(0); // i.e. the uncorrected frame says 'right'
  });
});

describe('sideOf — agrees with offsetPath, so the two conventions cannot drift', () => {
  // offsetPath's own comment calls its normal "right-hand", but it applies the (x,y) -> (y,-x)
  // rotation to components ordered (latitude, east), where that rotation is the LEFT normal:
  // offsetting a northbound line by +50 m moves it WEST. Pinning the two here means a future edit
  // to either file that changes a sign breaks a test instead of quietly swapping every reel's
  // filmable side.
  const road = straightNorth();

  it('offsetPath(+m) lays its copy on the rider left, offsetPath(-m) on the right', () => {
    const left = offsetPath(road, 50);
    const right = offsetPath(road, -50);
    for (let i = 0; i < road.length; i++) {
      expect(sideOf(0, road[i], left[i])).toBe('left');
      expect(sideOf(0, road[i], right[i])).toBe('right');
    }
  });

  it('holds on a curving road, where the normal turns with the tangent', () => {
    // A quarter circle of radius 200 m, so every vertex has a different tangent and a fixed global
    // bearing could not pass this.
    const R = 200;
    const arc: LatLng[] = [];
    for (let deg = 0; deg <= 90; deg += 5) {
      const t = deg * (Math.PI / 180);
      arc.push(at(R * Math.cos(t), R * Math.sin(t)));
    }
    const left = offsetPath(arc, 40);
    for (let i = 1; i < arc.length - 1; i++) {
      // Local tangent from the neighbours, computed independently of the implementation.
      expect(sideOf(bearing(arc[i - 1], arc[i + 1]), arc[i], left[i])).toBe('left');
    }
  });

  it('a whole offset path scans as frac 1.0 on that side and 0 on the other', () => {
    const w = windowOf(road);
    const offset = offsetPath(road, 50);
    const res = sideScanPoints(w, offset, 100);
    expect(res.left.frac).toBe(1);
    expect(res.right.frac).toBe(0);
    expect(res.left.nearestM).toBeCloseTo(50, 0);
    expect(res.right.nearestM).toBeNull();
  });
});

describe('sideOf — stable across the 0/360 wrap', () => {
  const here = at(0, 0);
  const dueEast = at(100, 0);

  it('is unchanged by adding or subtracting whole turns', () => {
    // Including 90 and 270, the two bearings that point straight at and straight away from the
    // feature. Those are the ones the wrap can actually break, because they are the only ones whose
    // answer rests on the sign of a number that should be zero.
    for (const b of [0, 37, 90, 180, 270, 271, 359]) {
      expect(sideOf(b + 360, here, dueEast)).toBe(sideOf(b, here, dueEast));
      expect(sideOf(b - 360, here, dueEast)).toBe(sideOf(b, here, dueEast));
      expect(sideOf(b + 720, here, dueEast)).toBe(sideOf(b, here, dueEast));
    }
  });

  it('flips exactly at the two bearings that point at and away from the feature', () => {
    // For a due-east feature the cross product reduces to cos(bearing): right for bearings that
    // have any northward component, left for any southward one, with the boundary at due east
    // (90, straight at it) and due west (270, straight away). No other flip may exist, and in
    // particular none at the 0/360 seam.
    for (let b = 0; b < 360; b++) {
      const expected = b < 90 || b > 270 ? 'right' : 'left';
      if (b === 90 || b === 270) continue; // the axis itself — tested for determinism, not side
      expect(sideOf(b, here, dueEast)).toBe(expected);
    }
  });
});

describe('sideScanPoints — coverage and the hard distance cutoff', () => {
  const road = straightNorth();
  const w = windowOf(road);
  const east100 = road.map((_, i) => at(100, i * RESAMPLE_M));
  const east500 = road.map((_, i) => at(500, i * RESAMPLE_M));

  it('reads a line of features 100 m east as frac 1.0 on the right', () => {
    const res = sideScanPoints(w, east100, 400);
    expect(res.right.frac).toBe(1);
    expect(res.right.nearestM).toBeCloseTo(100, 0);
    expect(res.left.frac).toBe(0);
    expect(res.left.nearestM).toBeNull();
  });

  it('reads the same features from the other direction as frac 1.0 on the left', () => {
    // Same road, same features, ridden the other way. This is the deliverable the category is
    // built on: the backdrop changes side, so the mark is a different mark.
    const reversed = windowOf([...road].reverse());
    const res = sideScanPoints(reversed, east100, 400);
    expect(res.left.frac).toBe(1);
    expect(res.right.frac).toBe(0);
    expect(res).toEqual(flipSides(sideScanPoints(w, east100, 400)));
  });

  it('reads NOTHING at 500 m under a 400 m cutoff — a hard threshold, not a decay', () => {
    // Under exp(-d/tau) this would return a small non-zero value on the right and the window would
    // still rank above a window with nothing at all. That is precisely the behaviour that makes a
    // decay unable to localise a moment (adjacent 400 m windows differ by 3.5%), so a zero here is
    // the whole point.
    const res = sideScanPoints(w, east500, 400);
    expect(res.left.frac).toBe(0);
    expect(res.right.frac).toBe(0);
    expect(res.left.nearestM).toBeNull();
    expect(res.right.nearestM).toBeNull();
  });

  it('counts every window point in the denominator, not just the ones that hit', () => {
    // One feature 100 m east of the middle sample. A point at along-road offset d sees it at
    // sqrt(100^2 + d^2), so with a 150 m cutoff it is visible for |d| <= 111.8 m — four samples
    // either side of the middle at RESAMPLE_M spacing, nine of seventeen.
    const one = [at(100, 8 * RESAMPLE_M)];
    const res = sideScanPoints(w, one, 150);
    expect(res.right.frac).toBeCloseTo(9 / 17, 6);
    expect(res.left.frac).toBe(0);
    expect(res.right.nearestM).toBeCloseTo(100, 0);
  });

  it('never double-counts a point across the two sides', () => {
    const both = [...east100, ...road.map((_, i) => at(-100, i * RESAMPLE_M))];
    const res = sideScanPoints(w, both, 400);
    expect(res.left.frac + res.right.frac).toBeLessThanOrEqual(1);
  });
});

describe('sideScanPoints — a road that curves past a feature splits its window', () => {
  // A semicircle of radius R = 150 m, ridden counter-clockwise from due-east round to due-west,
  // with a single feature D = 400 m north of the centre — outside the arc, beyond the apex.
  //
  // On paper: at arc angle theta the position is (R cos t, R sin t), the tangent is (-sin t, cos t),
  // and the cross product with the vector to the feature is exactly R - D*sin(theta). So the
  // feature is on the right precisely while sin(theta) > R/D = 0.375, i.e. theta in
  // (22.02 deg, 157.98 deg). Sampling every 5 deg puts 27 of 37 points inside that band.
  //
  // This is the case a window's MEAN bearing gets wrong: the mean of a semicircle points nowhere
  // the rider ever faces, and scoring against it would hand the whole window to one side.
  const R = 150;
  const D = 400;
  const STEP_DEG = 5;
  const arc: LatLng[] = [];
  for (let deg = 0; deg <= 180; deg += STEP_DEG) {
    const t = deg * (Math.PI / 180);
    arc.push(at(R * Math.cos(t), R * Math.sin(t)));
  }
  const w = windowOf(arc);
  const feature = [at(0, D)];
  // Farthest point of the arc from the feature is an endpoint, sqrt(R^2 + D^2) = 427 m.
  const MAX_M = 450;

  it('reports a fractional frac on both sides, at the angle theory predicts', () => {
    const flipDeg = Math.asin(R / D) * (180 / Math.PI); // 22.02
    let expectRight = 0;
    for (let deg = 0; deg <= 180; deg += STEP_DEG) {
      if (deg > flipDeg && deg < 180 - flipDeg) expectRight++;
    }
    expect(expectRight).toBe(27);

    const res = sideScanPoints(w, feature, MAX_M);
    expect(res.right.frac).toBeCloseTo(expectRight / arc.length, 6);
    expect(res.left.frac).toBeCloseTo((arc.length - expectRight) / arc.length, 6);
    // Neither 0 nor 1 — the thing a single global bearing could not produce.
    expect(res.right.frac).toBeGreaterThan(0);
    expect(res.right.frac).toBeLessThan(1);
    expect(res.left.frac).toBeGreaterThan(0);
    // Closest approach is at the apex: D - R = 250 m.
    expect(res.right.nearestM).toBeCloseTo(D - R, 0);
  });

  it('swaps sides exactly when the arc is ridden the other way', () => {
    const reversed = windowOf([...arc].reverse());
    expect(sideScanPoints(reversed, feature, MAX_M)).toEqual(
      flipSides(sideScanPoints(w, feature, MAX_M)),
    );
  });
});

describe('sideScanWeighted — minWeight selects the candidates, not the answer', () => {
  const road = straightNorth();
  const w = windowOf(road);

  // A minor watercourse close in on the LEFT, open water further out on the RIGHT. This is the
  // Heim Rd shape: a screened creek in the ditch is nearer than the lake, and it is the lake that
  // is in frame. Filtering by weight AFTER taking the nearest tell would report the creek's side
  // and then discard it, scoring this window as having no open water at all.
  const creekWest = road.map((_, i) => at(-50, i * RESAMPLE_M));
  const lakeEast = road.map((_, i) => at(300, i * RESAMPLE_M));
  const tells: WeightedTell[] = [...weigh(creekWest, 0.3), ...weigh(lakeEast, 1.0)];

  it('takes the nearest of ANY weight when the threshold admits everything', () => {
    const res = sideScanWeighted(w, tells, 400, 0);
    expect(res.left.frac).toBe(1);
    expect(res.left.nearestM).toBeCloseTo(50, 0);
    expect(res.right.frac).toBe(0);
  });

  it('reaches past the disqualified creek to the open water behind it', () => {
    const res = sideScanWeighted(w, tells, 400, OPEN_WATER_W);
    expect(res.right.frac).toBe(1);
    expect(res.right.nearestM).toBeCloseTo(300, 0);
    expect(res.left.frac).toBe(0);
    expect(res.left.nearestM).toBeNull();
  });

  it('reports nothing when the threshold excludes every tell', () => {
    const res = sideScanWeighted(w, weigh(creekWest, 0.3), 400, OPEN_WATER_W);
    expect(res.left.frac).toBe(0);
    expect(res.right.frac).toBe(0);
  });

  it('gives the same answer on the grid path as on the brute-force path', () => {
    // sceneryTells switches from a linear scan to the spatial grid above 512 tells, and the two
    // must agree — a ring-search bound that stopped at the first in-range tell rather than the
    // nearest one would only show up here, and only on the big-corpus path that ships.
    const filler: WeightedTell[] = [];
    for (let i = 0; i < 600; i++) filler.push({ pt: at(10000 + i, i * 3), w: 1 });
    const big = [...tells, ...filler];
    expect(big.length).toBeGreaterThan(512);
    expect(sideScanWeighted(w, big, 400, OPEN_WATER_W)).toEqual(
      sideScanWeighted(w, tells, 400, OPEN_WATER_W),
    );
  });
});

describe('the stable-array contract', () => {
  // The grid inside nearestWithinM is cached on array IDENTITY. Memoising the derived arrays is
  // what keeps that cache alive across windows; these assert the memo is a pure cache and cannot
  // return a stale or partial view.
  const road = straightNorth();
  const w = windowOf(road);
  const east100 = road.map((_, i) => at(100, i * RESAMPLE_M));
  const tells = weigh(east100, 1.0);

  it('gives the same answer when the same array is passed twice', () => {
    const a = sideScanPoints(w, east100, 400);
    const b = sideScanPoints(w, east100, 400);
    expect(b).toEqual(a);

    const c = sideScanWeighted(w, tells, 400, OPEN_WATER_W);
    const d = sideScanWeighted(w, tells, 400, OPEN_WATER_W);
    expect(d).toEqual(c);
  });

  it('gives the same answer for an identical array that is a different object', () => {
    const copy = east100.map((p) => [p[0], p[1]] as LatLng);
    expect(sideScanPoints(w, copy, 400)).toEqual(sideScanPoints(w, east100, 400));

    const tellsCopy = tells.map((t) => ({ pt: t.pt, w: t.w }));
    expect(sideScanWeighted(w, tellsCopy, 400, OPEN_WATER_W)).toEqual(
      sideScanWeighted(w, tells, 400, OPEN_WATER_W),
    );
  });

  it('keeps different minWeight thresholds separate on the same array', () => {
    const mixed = [...weigh(east100, 0.3), ...weigh(road.map((_, i) => at(-100, i * RESAMPLE_M)), 1)];
    const loose = sideScanWeighted(w, mixed, 400, 0.2);
    const strict = sideScanWeighted(w, mixed, 400, OPEN_WATER_W);
    expect(loose.right.frac).toBe(1); // the 0.3 tells at 100 m east win on distance
    expect(strict.left.frac).toBe(1); // …and are excluded outright at 0.7
    // Re-asking the loose question must not return the cached strict subset.
    expect(sideScanWeighted(w, mixed, 400, 0.2)).toEqual(loose);
  });
});

describe('degenerate windows', () => {
  it('falls back to the window bearing when there is no chord to take a tangent from', () => {
    const single: RoadWindow = {
      id: 'p@0',
      roadId: 'p',
      roadName: 'Point',
      pts: [at(0, 0)],
      startM: 0,
      lengthM: 0,
      mid: at(0, 0),
      bearingDeg: 0, // heading north, so a feature due east is on the right
    };
    expect(sideScanPoints(single, [at(100, 0)], 400).right.frac).toBe(1);
    expect(sideScanPoints({ ...single, bearingDeg: 180 }, [at(100, 0)], 400).left.frac).toBe(1);
  });

  it('returns zeros rather than NaN for an empty window or an empty feature set', () => {
    const w = windowOf(straightNorth());
    const empty = sideScanPoints({ ...w, pts: [] }, [at(100, 0)], 400);
    expect(empty.left.frac).toBe(0);
    expect(empty.right.frac).toBe(0);
    expect(sideScanPoints(w, [], 400).right.frac).toBe(0);
    expect(sideScanPoints(w, [at(100, 0)], 0).right.frac).toBe(0);
  });
});
