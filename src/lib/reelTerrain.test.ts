import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearLateralFallCache,
  fetchLateralFall,
  probePoints,
  readFall,
  terrain10,
  MAX_PROBE_WINDOWS,
} from './reelTerrain';
import { BACKDROP_MIN, FULL_FALL_M, PROBE_DISTANCES_M, type RoadWindow } from './reelTypes';
import { bearing, haversine, type LatLng } from './geometry';

// These tests check geometry against first principles — great-circle distance, the sign of a cross
// product, "east is on your right when you ride north" — and check the readers against synthetic
// profiles whose answer is known before the code runs. Nothing here asserts what the
// implementation happens to return. Where a number comes from the validation pass (Letchworth
// 130.3 m, Zoar 23.3 m, the flat-farmland control at 7.9 m) it is cited in the test that uses it.

const BUFFALO_LAT = 42.9; // the app's home region, and the latitude every DEM measurement was made at

/** Only the RATIO between the two axes below sets a bearing, and both use this same number, so its
 *  exact value never enters an assertion — it sets sample SPACING and nothing else. */
const M_PER_DEG_LAT = 111_320;

/**
 * The point `distM` from `from` along `bearingDeg`, in the local equirectangular frame.
 *
 * Deliberately NOT the module's spherical `destination`: fixtures built with the implementation's
 * own geometry cannot catch the implementation getting that geometry wrong. Over the ≤400 m these
 * fixtures span, the two differ by ~0.002 deg of bearing at this latitude — three orders below the
 * 18 deg chord/tangent gap the curving fixture exists to expose.
 */
function step(from: LatLng, bearingDeg: number, distM: number): LatLng {
  const b = (bearingDeg * Math.PI) / 180;
  return [
    from[0] + (Math.cos(b) * distM) / M_PER_DEG_LAT,
    from[1] + (Math.sin(b) * distM) / (M_PER_DEG_LAT * Math.cos((from[0] * Math.PI) / 180)),
  ];
}

/**
 * A STRAIGHT 400 m window — 17 samples at 25 m, the shape `cutWindows` emits.
 *
 * Straight on purpose: the chord and the local tangent at the midpoint are the same number here, so
 * this fixture deliberately cannot tell them apart and every assertion made on it holds under either
 * reading. `curvingWindow` is the fixture that separates the two.
 */
function windowAt(mid: LatLng, bearingDeg: number, id = 'road/1@0'): RoadWindow {
  const pts: LatLng[] = [];
  for (let k = -8; k <= 8; k++) pts.push(step(mid, bearingDeg, k * 25));
  return {
    id,
    roadId: 'road/1',
    roadName: 'Test Rd',
    pts,
    startM: 0,
    lengthM: 400,
    mid,
    bearingDeg,
  };
}

/** Aligned elevation array in `probePoints` order: road, then the four left, then the four right. */
function elevations(roadM: number, leftM: number[], rightM: number[]): number[] {
  return [roadM, ...leftM, ...rightM];
}

/**
 * (north, east) components of the ground vector a→b, with the cos-latitude correction so both axes
 * carry the same unit. Written out here rather than imported: geometry.ts keeps its version
 * private, and a test that reused the implementation's own helper would not independently check
 * the sign convention.
 */
function ground(a: LatLng, b: LatLng): [number, number] {
  const lonScale = Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return [b[0] - a[0], (b[1] - a[1]) * lonScale];
}

/** z of (travel × offset) in the (north, east) frame. Positive ⇒ the offset is to the RIGHT of
 *  travel; negative ⇒ to the left. Sign only — magnitude is not meaningful here. */
function sideSign(travelDeg: number, offset: [number, number]): number {
  const t: [number, number] = [Math.cos((travelDeg * Math.PI) / 180), Math.sin((travelDeg * Math.PI) / 180)];
  return Math.sign(t[0] * offset[1] - t[1] * offset[0]);
}

/** Unrounded bearing of a→b in the same (north, east) frame `ground` establishes. `bearing()` from
 *  geometry.ts rounds to whole degrees, which is fine for a ±90 assertion and not fine for reading a
 *  probe axis back out and then classifying a side against it. */
function bearingOf(a: LatLng, b: LatLng): number {
  const [n, e] = ground(a, b);
  return (Math.atan2(e, n) * 180) / Math.PI;
}

/** Signed bearing difference in (-180, 180]. */
function signedDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

const metresBetween = (a: LatLng, b: LatLng) => haversine(a, b) * 1000;

describe('probePoints — shape and order', () => {
  const w = windowAt([BUFFALO_LAT, -78.85], 0);

  it('returns 1 + 2 x PROBE_DISTANCES_M points, road first', () => {
    const pts = probePoints(w);
    expect(pts.length).toBe(1 + 2 * PROBE_DISTANCES_M.length);
    expect(pts.length).toBe(9);
    expect(pts[0]).toEqual(w.mid);
  });

  it('lays each side out at PROBE_DISTANCES_M in ascending order', () => {
    // The contract is positional: readFall indexes 1..4 as left and 5..8 as right, so the distance
    // at each index has to be the documented one and not merely "the same set of distances".
    const pts = probePoints(w);
    for (let i = 0; i < PROBE_DISTANCES_M.length; i++) {
      expect(metresBetween(w.mid, pts[1 + i])).toBeCloseTo(PROBE_DISTANCES_M[i], 0);
      expect(metresBetween(w.mid, pts[1 + PROBE_DISTANCES_M.length + i])).toBeCloseTo(PROBE_DISTANCES_M[i], 0);
    }
  });

  it('measures ground distances within 1% of the requested ones', () => {
    // A naive degree offset (lon += m / 111320) is short by 1/cos(lat) — 26% at 42.9°N — so this
    // tolerance is far tighter than that failure and would catch it at every bearing.
    for (const brg of [0, 37, 90, 183, 271, 350]) {
      const pts = probePoints(windowAt([BUFFALO_LAT, -78.85], brg));
      for (let i = 1; i < pts.length; i++) {
        const want = PROBE_DISTANCES_M[(i - 1) % PROBE_DISTANCES_M.length];
        const got = metresBetween(pts[0], pts[i]);
        expect(Math.abs(got - want) / want).toBeLessThan(0.01);
      }
    }
  });
});

describe('probePoints — the left/right swap guard', () => {
  it('puts the two sides on OPPOSITE sides of the road at every bearing', () => {
    // This is the error the module cannot survive: a swap does not degrade the answer, it inverts
    // it — the rider is sent down the road the wrong way with the boom aimed at the hillside.
    for (const brg of [0, 37, 90, 183, 271, 350]) {
      const w = windowAt([BUFFALO_LAT, -78.85], brg);
      const pts = probePoints(w);
      for (let i = 0; i < PROBE_DISTANCES_M.length; i++) {
        expect(sideSign(brg, ground(pts[0], pts[1 + i]))).toBe(-1); // left
        expect(sideSign(brg, ground(pts[0], pts[1 + PROBE_DISTANCES_M.length + i]))).toBe(1); // right
      }
    }
  });

  it('places probes perpendicular to travel, -90 for the left group and +90 for the right', () => {
    // Independent of the cross product above: geometry.ts's `bearing` inverts the destination
    // formula, so this is a round-trip check of the offset maths rather than of its sign alone.
    for (const brg of [0, 37, 90, 183, 271, 350]) {
      const w = windowAt([BUFFALO_LAT, -78.85], brg);
      const pts = probePoints(w);
      for (let i = 0; i < PROBE_DISTANCES_M.length; i++) {
        expect(signedDiff(bearing(pts[0], pts[1 + i]), brg)).toBeCloseTo(-90, 0);
        expect(signedDiff(bearing(pts[0], pts[1 + PROBE_DISTANCES_M.length + i]), brg)).toBeCloseTo(90, 0);
      }
    }
  });

  it('rides north with the east probes on the right', () => {
    // The plainest possible statement of the convention, in compass terms rather than vector ones.
    const w = windowAt([BUFFALO_LAT, -78.85], 0);
    const pts = probePoints(w);
    for (let i = 1; i <= PROBE_DISTANCES_M.length; i++) expect(pts[i][1]).toBeLessThan(w.mid[1]); // west = left
    for (let i = 5; i <= 8; i++) expect(pts[i][1]).toBeGreaterThan(w.mid[1]); // east = right
  });
});

describe('probePoints — aimed off the LOCAL tangent, not the chord', () => {
  /**
   * A window whose chord and midpoint tangent are different by a hand-computable amount.
   *
   * 17 samples at 25 m: twelve intervals due NORTH (300 m), then four due EAST (100 m) — the
   * reviewer's case, a 90 deg bend in the last quarter. Both quantities follow from that by hand
   * and neither is read off the implementation:
   *
   *   local tangent at the midpoint — sample 8 sits inside the north leg, and so do its neighbours
   *   7 and 9, so the tangent there is due north, 0 deg, exactly.
   *
   *   chord, first sample to last — 300 m north and 100 m east, so atan2(100, 300) = 18.435 deg.
   *
   * 18.4 deg is the whole finding: sideScan puts water on a side using the local tangent, this
   * module used the chord, and `max(terrain10, water10)` then merged two different side labels.
   */
  const START: LatLng = [BUFFALO_LAT, -78.85];
  const CHORD_DEG = 18.4349; // atan2(100, 300) in degrees — what cutWindows would store
  const TANGENT_DEG = 0; // due north: samples 7, 8 and 9 are all in the north leg

  function curvingWindow(): RoadWindow {
    const pts: LatLng[] = [START];
    for (let k = 0; k < 12; k++) pts.push(step(pts[pts.length - 1], 0, 25));
    for (let k = 0; k < 4; k++) pts.push(step(pts[pts.length - 1], 90, 25));
    return {
      id: 'road/2@0',
      roadId: 'road/2',
      roadName: 'Bendy Rd',
      pts,
      startM: 0,
      lengthM: 400,
      mid: pts[8],
      bearingDeg: CHORD_DEG,
    };
  }

  it('confirms the fixture really does separate the two by ~18 degrees', () => {
    // If this drifts the test below stops proving anything, so it is asserted rather than assumed.
    const w = curvingWindow();
    expect(w.pts.length).toBe(17);
    // atan2(100 m east, 300 m north) = 18.4349 deg, computed here from the fixture's own points
    // rather than taken on trust — and unrounded, because `bearing()` would report a flat 18.
    expect(signedDiff(bearingOf(w.pts[0], w.pts[16]), TANGENT_DEG)).toBeCloseTo(CHORD_DEG, 2);
    expect(Math.abs(signedDiff(w.bearingDeg, TANGENT_DEG))).toBeGreaterThan(15);
  });

  it('places the probes perpendicular to the TANGENT at the midpoint', () => {
    // Hand-computed: the tangent at the midpoint is due north, so the left group runs due west
    // (270) and the right group due east (90). Off the chord they would be 288.4 and 108.4.
    const w = curvingWindow();
    const pts = probePoints(w);
    for (let i = 0; i < PROBE_DISTANCES_M.length; i++) {
      expect(signedDiff(bearing(pts[0], pts[1 + i]), TANGENT_DEG)).toBeCloseTo(-90, 0);
      expect(signedDiff(bearing(pts[0], pts[1 + PROBE_DISTANCES_M.length + i]), TANGENT_DEG)).toBeCloseTo(90, 0);
    }
  });

  it('does NOT place them perpendicular to the chord', () => {
    // The same claim stated as the failure, so a regression to `w.bearingDeg` cannot pass by
    // widening a tolerance somewhere: every probe must sit ~18.4 deg away from where the chord
    // would have put it.
    const w = curvingWindow();
    const pts = probePoints(w);
    for (let i = 1; i < pts.length; i++) {
      const fromChord = signedDiff(bearing(pts[0], pts[i]), w.bearingDeg);
      expect(Math.abs(Math.abs(fromChord) - 90)).toBeGreaterThan(15);
    }
  });

  it('falls back to the chord for a window that carries no direction of its own', () => {
    // `tangentBearingAt` is total and answers 0 for a directionless window, and 0 is a real bearing
    // — so a single-point (or all-coincident) window has to be recognised rather than probed
    // north/south by accident. `resampleAlong` cannot emit one, but a caller assembling a window by
    // hand can, and the chord is the only direction such a window has.
    const mid: LatLng = [BUFFALO_LAT, -78.85];
    const flatOnly: RoadWindow = { ...windowAt(mid, 37), pts: [mid], bearingDeg: 37 };
    const pts = probePoints(flatOnly);
    expect(signedDiff(bearingOf(pts[0], pts[1]), 37)).toBeCloseTo(-90, 1);
    expect(signedDiff(bearingOf(pts[0], pts[5]), 37)).toBeCloseTo(90, 1);
  });

  it('puts a feature in the chord/tangent wedge on the side sideScan puts it', () => {
    // The defect stated as the thing it breaks. The two axes disagree about every feature whose
    // bearing from the midpoint falls between them — here (0, 18.4) and (180, 198.4). A feature at
    // 10 deg is 10 deg off the nose of a rider heading due north, so it is on the RIGHT, and that is
    // what sideScan (local tangent) says. The chord axis called the same feature LEFT. Then
    // `BackdropReading.score10 = max(terrain10, water10)` merged the two as if they agreed.
    const w = curvingWindow();
    const axis = bearingOf(w.mid, probePoints(w)[5]) - 90; // the +90 right probe, back to the axis
    const inWedge = step(w.mid, 10, 300);

    expect(sideSign(axis, ground(w.mid, inWedge))).toBe(1); // right, off the probe axis
    expect(sideSign(w.bearingDeg, ground(w.mid, inWedge))).toBe(-1); // left, off the chord
    // And nothing outside the wedge moved: due east is on the right under either reading.
    expect(sideSign(axis, ground(w.mid, step(w.mid, 90, 300)))).toBe(1);
  });
});

describe('probePoints — every probe clears the DEM cell', () => {
  it('lands at least 140 m off-axis, so it is in a different cell than the road', () => {
    // Copernicus GLO-90 as served by Open-Meteo has a MEASURED cell of ~69 m at 42°N (a 600 m
    // transect at 10 m steps returned identical-value runs of mean length 6.0). A probe closer than
    // ~140 m therefore samples the SAME CELL as the road and returns a structural zero no matter
    // what the terrain does — which is exactly why revision 1's 30–50 m near-field probe measured
    // nothing at all. Near-field openness has to come from OSM polygons instead.
    for (const brg of [0, 37, 90, 183, 271, 350]) {
      const pts = probePoints(windowAt([BUFFALO_LAT, -78.85], brg));
      for (let i = 1; i < pts.length; i++) {
        expect(metresBetween(pts[0], pts[i])).toBeGreaterThanOrEqual(140);
      }
    }
  });
});

describe('readFall — sides, flooring, and where the max lives', () => {
  const w = windowAt([BUFFALO_LAT, -78.85], 0);

  it('reads a one-sided drop on that side only, and floors the other at zero', () => {
    // Ground rising to the left, falling to the right. Falls on the right are 20 / 50 / 60 / 40,
    // so the peak is 60 m at 800 m out.
    const f = readFall(w, elevations(300, [305, 310, 312, 315], [280, 250, 240, 260]));
    expect(f.right.fallM).toBe(60);
    expect(f.right.atM).toBe(800);
    expect(f.left.fallM).toBe(0); // floored — a wall is not a negative view
    expect(f.left.atM).toBe(0); // sentinel: no distance produced a fall
    expect(f.left.riseM).toBe(15); // the wall is reported, just not scored
    expect(f.right.riseM).toBe(0);
  });

  it('attributes a drop east of a north-bound window to the RIGHT side', () => {
    // Closes the loop between geometry and indexing: the swap guard above proves indices 5..8 are
    // geographically east of a north-bound window, and this proves readFall calls them `right`.
    const f = readFall(w, elevations(300, [300, 300, 300, 300], [250, 250, 250, 250]));
    expect(f.right.fallM).toBeGreaterThan(0);
    expect(f.left.fallM).toBe(0);
  });

  it('finds the Zoar-shaped gorge that peaks at 800 m and is gone by 1500 m', () => {
    // Zoar Valley: measured 23.3 m of lateral fall, living at 200–800 m and VANISHING to 0 at
    // 1500 m. A single-distance probe at 1500 m scores this road zero, which is the entire reason
    // for max-over-distances.
    const elev = elevations(400, [400, 400, 400, 400], [382, 378, 376.7, 400]);
    const f = readFall(w, elev);
    expect(f.right.atM).toBe(800);
    expect(f.right.fallM).toBeCloseTo(23.3, 1);
    // Spelled out, so the regression would be loud: probing only at 1500 m sees nothing here.
    expect(elev[0] - elev[8]).toBe(0);
  });

  it('follows Letchworth all the way out to 1500 m', () => {
    // The opposite failure to Zoar. Letchworth Park Rd's measured profile grows monotonically:
    // 34 → 129 → 142 → 149 m. A probe fixed at 200 m under-reads it by more than 4x.
    const f = readFall(w, elevations(500, [500, 500, 500, 500], [466, 371, 358, 351]));
    expect(f.right.atM).toBe(1500);
    expect(f.right.fallM).toBe(149);
  });

  it('breaks a tie toward the nearer distance', () => {
    // Falls 40 / 40 / 20 / 0: the ground is already all the way down at 200 m, so that is the
    // landform's scale. Judgement call, documented in the module.
    const f = readFall(w, elevations(100, [100, 100, 100, 100], [60, 60, 80, 100]));
    expect(f.right.fallM).toBe(40);
    expect(f.right.atM).toBe(200);
  });

  it('reads flat ground as zero on both sides', () => {
    const f = readFall(w, elevations(212, [212, 212, 212, 212], [212, 212, 212, 212]));
    expect(f.left).toEqual({ fallM: 0, atM: 0, riseM: 0 });
    expect(f.right).toEqual({ fallM: 0, atM: 0, riseM: 0 });
  });
});

describe('readFall — degrades loudly, never into NaN', () => {
  const w = windowAt([BUFFALO_LAT, -78.85], 0, 'road/9@1200');

  it('returns zeros and warns on a short array', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = readFall(w, [300, 250, 240]);
    expect(f.left.fallM).toBe(0);
    expect(f.right.fallM).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('road/9@1200'); // traceable to the window
    warn.mockRestore();
  });

  it('returns zeros rather than NaN when an elevation is not finite', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = readFall(w, elevations(300, [300, 300, 300, 300], [NaN, 250, 240, 260]));
    expect(Number.isFinite(f.right.fallM)).toBe(true);
    expect(f.right.fallM).toBe(0);
    warn.mockRestore();
  });
});

describe('terrain10 — magnitude, not a threshold count', () => {
  const fall = (fallM: number) => ({ fallM, atM: 800, riseM: 0 });

  it('saturates near 10 for Letchworth and scores the flat-farmland control under 1', () => {
    // Letchworth Park Rd: 130.3 m mean lateral fall. Flat farmland negative control: 7.9 m (three
    // longest ways in each of two flat boxes, no name filter, no cherry-picking) — a 16x
    // separation, and the pair this scale was calibrated against.
    expect(terrain10(fall(130.3))).toBe(10);
    expect(terrain10(fall(7.9))).toBeLessThan(1);
  });

  it('keeps the false positives that a threshold count produced below BACKDROP_MIN', () => {
    // Counting segments over 15 m flagged two flat-farmland roads (50% and 20% of segments over
    // threshold) whose MEAN fall was only 11.6 and 10.3 m. Magnitude puts both nowhere near being
    // called a backdrop; a count called them one. This test exists so nobody re-adds the count.
    expect(terrain10(fall(11.6))).toBeLessThan(BACKDROP_MIN);
    expect(terrain10(fall(10.3))).toBeLessThan(BACKDROP_MIN);
  });

  it('is linear below saturation and clamped above it', () => {
    expect(terrain10(fall(0))).toBe(0);
    expect(terrain10(fall(FULL_FALL_M / 2))).toBe(5);
    expect(terrain10(fall(FULL_FALL_M))).toBe(10);
    expect(terrain10(fall(FULL_FALL_M * 10))).toBe(10);
  });

  it('ranks the measured sites in the order the validation pass found them', () => {
    // Letchworth 130.3 > Zoar 23.3 > Lake Erie shore 17.7 > flat farmland 7.9. The ordering is the
    // claim; the gaps between the middle three are only 2.2–2.9x, which is why the design calls
    // modest relief a hint rather than a finding.
    const scores = [130.3, 23.3, 17.7, 7.9].map((m) => terrain10(fall(m)));
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1]);
  });

  it('reports one decimal, since the DEM cannot support more', () => {
    for (const m of [7.9, 11.6, 23.3, 61.7, 130.3]) {
      const s = terrain10(fall(m));
      expect(s).toBe(Math.round(s * 10) / 10);
    }
  });
});

describe('MAX_PROBE_WINDOWS — the request budget', () => {
  it('keeps a full probe run inside the measured Open-Meteo rate limit', () => {
    // fetchElevations packs 100 points per request; Open-Meteo was measured returning HTTP 429 at
    // roughly 10–15 requests inside 2 minutes. A capped run must leave room for a second pass.
    const points = MAX_PROBE_WINDOWS * (1 + 2 * PROBE_DISTANCES_M.length);
    expect(Math.ceil(points / 100)).toBeLessThanOrEqual(5);
  });

  it('is far below the naive every-window cost that motivated the cap', () => {
    // Probing every window of every road measured 7,040 points ≈ 71 requests, ten times over the
    // 700-point ELEV_POINT_BUDGET overpass.ts already works to.
    expect(MAX_PROBE_WINDOWS * 9).toBeLessThan(700);
  });
});

// ------------------------------------------------------------------------------------------------
// The cache. These are the only tests here that touch I/O, and they exist because the cap alone does
// not keep this module inside its measured budget — see the module header.
// ------------------------------------------------------------------------------------------------

const round5 = (n: number): number => Math.round(n * 1e5) / 1e5; // elevation.ts rounds URL coords to 5 dp

/**
 * One window's aligned probe elevations: flat to the left, and to the right a drop that PEAKS at
 * 800 m — the Zoar-shaped profile, so `right.fallM` reads back as exactly `fallM`.
 */
function fallProfile(fallM: number): number[] {
  return [
    300,
    300,
    300,
    300,
    300,
    300 - fallM / 3,
    300 - (2 * fallM) / 3,
    300 - fallM,
    300 - fallM / 2,
  ];
}

interface ElevStub {
  /** Every URL the module asked for. Length IS the request count the 429 budget is denominated in. */
  calls: string[];
  /** Window ids whose probe group appeared in a request, in request order. */
  fetched: string[];
  /** Probe groups whose first point was not any known window's midpoint — must stay empty. */
  unknown: string[];
  /** Flip to make every later request fail the way Open-Meteo does when it rate-limits. */
  fail: boolean;
}

/**
 * Stand in for Open-Meteo, identifying each 9-point probe group by its FIRST coordinate — which
 * `probePoints` documents as the road point, i.e. the window's own midpoint.
 *
 * That identification is what makes "fetches only the new windows" a real assertion rather than a
 * count: the stub records WHICH windows were asked for, so a call that re-asked for a cached window
 * and simply issued fewer requests would still fail.
 */
function installElevationStub(known: { w: RoadWindow; fallM: number }[]): ElevStub {
  const byMid = new Map(known.map((k) => [`${round5(k.w.mid[0])},${round5(k.w.mid[1])}`, k]));
  const stub: ElevStub = { calls: [], fetched: [], unknown: [], fail: false };
  vi.stubGlobal('fetch', async (url: string | URL) => {
    stub.calls.push(String(url));
    if (stub.fail) return { ok: false, status: 429, json: async () => ({}) };
    const params = new URL(String(url)).searchParams;
    const lats = params.get('latitude')!.split(',').map(Number);
    const lons = params.get('longitude')!.split(',').map(Number);
    const elevation: number[] = [];
    for (let i = 0; i < lats.length; i += 9) {
      const key = `${lats[i]},${lons[i]}`;
      const hit = byMid.get(key);
      // Recorded rather than thrown: fetchElevations swallows exceptions into `null`, which would
      // turn a stub misconfiguration into a silently passing degradation test.
      if (!hit) {
        stub.unknown.push(key);
        elevation.push(...fallProfile(0));
        continue;
      }
      stub.fetched.push(hit.w.id);
      elevation.push(...fallProfile(hit.fallM));
    }
    return { ok: true, json: async () => ({ elevation }) };
  });
  return stub;
}

describe('fetchLateralFall — the cache IS the request budget', () => {
  // Letchworth 130.3 m, Zoar 23.3 m, the Lake Erie shore 17.7 m: the three measured sites, so a
  // reading that comes back wrong comes back recognisably wrong.
  const wA = windowAt([BUFFALO_LAT, -78.85], 0, 'road/7@0');
  const wB = windowAt([BUFFALO_LAT + 0.01, -78.86], 0, 'road/7@200');
  const wC = windowAt([BUFFALO_LAT + 0.02, -78.87], 0, 'road/7@400');
  const sites = [
    { w: wA, fallM: 130.3 },
    { w: wB, fallM: 23.3 },
    { w: wC, fallM: 17.7 },
  ];

  beforeEach(() => clearLateralFallCache());
  afterEach(() => vi.unstubAllGlobals());

  it('issues NO request on a repeat call, and returns the same readings', async () => {
    // The concrete break this pins: terrain depends on the window and on nothing else, so changing
    // the shoot time must cost zero requests. Uncached, four nudges of a time input re-probe all 40
    // windows four times = 16 requests in a couple of seconds, past the measured Open-Meteo ceiling
    // of ~10-15 per 2 minutes — and `fetchElevations` nulls the WHOLE call on its first failing
    // batch, so one 429 takes terrain away from every mark at once.
    const stub = installElevationStub(sites);
    const first = await fetchLateralFall([wA, wB]);
    expect(stub.calls.length).toBe(1);
    expect(first?.get('road/7@0')?.right.fallM).toBeCloseTo(130.3, 1);
    expect(first?.get('road/7@200')?.right.fallM).toBeCloseTo(23.3, 1);

    for (let nudge = 0; nudge < 4; nudge++) {
      expect(await fetchLateralFall([wA, wB])).toEqual(first);
    }
    expect(stub.calls.length).toBe(1); // still one — the four nudges were free
    expect(stub.unknown).toEqual([]);
  });

  it('fetches only the windows it does not already hold', async () => {
    const stub = installElevationStub(sites);
    await fetchLateralFall([wA, wB]);
    expect(stub.fetched).toEqual(['road/7@0', 'road/7@200']);

    const out = await fetchLateralFall([wA, wB, wC]);
    expect(stub.calls.length).toBe(2);
    expect(stub.fetched.slice(2)).toEqual(['road/7@400']); // the new one, and only the new one

    // Denominated in coordinates as well as in requests, because the budget is really a point count:
    // one window's nine probes, not three windows' twenty-seven.
    const lats = new URL(stub.calls[1]).searchParams.get('latitude')!.split(',');
    expect(lats.length).toBe(9);

    expect(out?.size).toBe(3);
    expect(out?.get('road/7@0')?.right.fallM).toBeCloseTo(130.3, 1); // served from cache
    expect(out?.get('road/7@400')?.right.fallM).toBeCloseTo(17.7, 1); // freshly fetched
    expect(stub.unknown).toEqual([]);
  });

  it('does not cache a failure, so a retry still gets the reading', async () => {
    // A 429 or a dead mirror is a property of the minute, not of the road. Caching it would deny
    // that window its terrain for the rest of the session — the same reasoning fetchBuiltIndex
    // records for its own failures.
    const stub = installElevationStub(sites);
    stub.fail = true;
    expect(await fetchLateralFall([wA])).toBeNull();

    stub.fail = false;
    const out = await fetchLateralFall([wA]);
    expect(out?.get('road/7@0')?.right.fallM).toBeCloseTo(130.3, 1);
    expect(stub.calls.length).toBe(2); // it really did go back to the network
  });

  it('keeps the readings it already holds when a later fetch fails', async () => {
    // A partial map is already a normal outcome here (MAX_PROBE_WINDOWS truncation produces one),
    // so discarding 39 known readings because the 40th 429'd would be a pure loss.
    const stub = installElevationStub(sites);
    await fetchLateralFall([wA]);
    stub.fail = true;

    const out = await fetchLateralFall([wA, wC]);
    expect(out?.get('road/7@0')?.right.fallM).toBeCloseTo(130.3, 1);
    expect(out?.has('road/7@400')).toBe(false); // no reading is better than an invented one
  });

  it('clearLateralFallCache actually drops the readings', async () => {
    const stub = installElevationStub(sites);
    await fetchLateralFall([wA]);
    await fetchLateralFall([wA]);
    expect(stub.calls.length).toBe(1);

    clearLateralFallCache();
    await fetchLateralFall([wA]);
    expect(stub.calls.length).toBe(2);
  });

  it('asks for nothing at all when handed no windows', async () => {
    const stub = installElevationStub(sites);
    expect(await fetchLateralFall([])).toEqual(new Map());
    expect(stub.calls.length).toBe(0);
  });
});
