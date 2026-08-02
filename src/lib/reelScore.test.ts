import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LatLng } from './geometry';
import type { ScannedRoad, ScoredRoad } from '../data/types';
import type { AreaScan, OverpassElement } from './overpass';
import { cutWindows } from './reelGeometry';
import { countBuiltWays, fetchBuiltIndex } from './reelTells';
import { fetchLateralFall, terrain10 } from './reelTerrain';
import { lightAt } from './reelPlan';
import { solarPosition } from './sun';
import { OPEN_WATER_W, WATER_SIZE, type WeightedTell } from './sceneryTells';
import {
  BACKDROP_MIN,
  BACKDROP_WATER_M,
  FULL_FALL_M,
  FULL_JUNCTION_DENSITY,
  FULL_JUNCTION_PER_KM,
  REEL_WEIGHTS,
  RESAMPLE_M,
  WINDOW_M,
  flipSides,
  type LateralFall,
  type PerSide,
  type ReelMetrics,
  type RoadWindow,
} from './reelTypes';
import {
  BUILT_RADIUS_M,
  FULL_WATER_FRAC,
  WATER_BANDS,
  buildMarks,
  enrichMarks,
  junctionDensityNear,
  junctionsPerKm,
  reelComposite,
  scoreBackdrop,
  scoreClean,
  scoreWindows,
  selectMarks,
  type ReelOptions,
} from './reelScore';

// Every expectation below is derived on paper before the code runs, not read back off the
// implementation. The recurring arguments are: "heading north, due east is on your right"; a lake
// 150 m from every sample of a window covers all of it and sits inside three of the four distance
// bands, so its side reads full strength; at solar noon the sun is due south in the northern
// hemisphere and due north in the southern one, so the planner's "put the sun behind you" tiebreak
// sends the rider north in Buffalo and south in Sydney; and the composite is a weighted mean, so a
// single all-ten dimension is worth exactly its weight.
//
// The failure modes named in the design doc are tested by name, because each of them would leave
// every number on the card looking entirely reasonable: a `backdropSide` that disagrees with the
// mark's `direction` (the whole category inverts), a `direction` that ignores which verge the
// backdrop is on (the boom films the wrong side of the road, at an identical score), averaging the
// two backdrop mechanisms instead of taking the stronger (a gorge with no lake is halved), a
// `buildMarks` that reaches for the network (the ~20-25 s dispatch cost the two-stage split exists
// to avoid), an `enrichMarks` that loses the ranking when its enrichments fail, and a re-weight that
// re-sorts a shortlist the OLD weights chose.

// ------------------------------------------------------------------------------------------------
// Network seams. The two enrichment calls are mocked at the module boundary rather than at `fetch`,
// because that boundary IS the contract: both are documented to return null on failure, and null is
// exactly what the graceful-degradation test has to deliver. Everything else in both modules —
// `terrain10`, `builtDensityNear`, `countBuiltWays` — stays real.
// ------------------------------------------------------------------------------------------------

vi.mock('./reelTerrain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reelTerrain')>();
  return { ...actual, fetchLateralFall: vi.fn(async () => null) };
});

vi.mock('./reelTells', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reelTells')>();
  return { ...actual, fetchBuiltIndex: vi.fn(async () => null) };
});

const mockFall = vi.mocked(fetchLateralFall);
const mockBuilt = vi.mocked(fetchBuiltIndex);

beforeEach(() => {
  mockFall.mockReset().mockResolvedValue(null);
  mockBuilt.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------

/** haversine's sphere (R = 6371 km), so "200 m east" here measures 200 m under the same metric the
 *  implementation uses. WGS84's 111320 m/deg would be 0.11% off, which the metre-level assertions
 *  on `waterM` would see. */
const M_PER_DEG = (6371 * 1000 * Math.PI) / 180;

/** Local flat projection: metres east / north of an origin. */
function projector(lat0: number, lon0: number) {
  const lonScale = Math.cos((lat0 * Math.PI) / 180);
  return (eastM: number, northM: number): LatLng => [
    lat0 + northM / M_PER_DEG,
    lon0 + eastM / (M_PER_DEG * lonScale),
  ];
}

const BUFFALO = projector(42.9, -78.85); // the app's home region
const SYDNEY = projector(-33.87, 151.21); // the same geometry with the sun on the other side

/** Solar noon at each place on the June solstice, refined below by an explicit precondition rather
 *  than trusted: the tests need only "which half-plane is the sun in", not a precise instant. */
const NOON_BUFFALO = new Date('2026-06-21T17:15:00Z');
const NOON_SYDNEY = new Date('2026-06-21T01:56:00Z');

function makeRoad(
  id: string,
  name: string,
  coords: LatLng[],
  extra: Partial<ScoredRoad> = {},
): ScoredRoad {
  return {
    id,
    name,
    curveDensity: 0,
    sinuosity: 0,
    score: 0,
    coords,
    rubric: { curvature: 0, scenery: 0, greenery: 0, water: 0, notability: 0 },
    ...extra,
  };
}

interface ScanParts {
  roads: ScoredRoad[];
  corpus?: ScannedRoad[];
  waterPts?: WeightedTell[];
  greenAreas?: LatLng[][];
  uglyAreas?: LatLng[][];
  center?: LatLng;
}

function makeScan(p: ScanParts): AreaScan {
  return {
    roads: p.roads,
    catalog: {
      tells: {
        waterPts: p.waterPts ?? [],
        waterAreas: [],
        greenAreas: p.greenAreas ?? [],
        greenPts: [],
        uglyAreas: p.uglyAreas ?? [],
        uglyPts: [],
        view: [],
        peak: [],
        notable: [],
      },
      pois: [],
    },
    center: p.center ?? p.roads[0].coords[0],
    radiusKm: 30,
    // Real scans put every candidate road in the corpus too, so the default mirrors that: a road's
    // own two endpoints are in the index and must not count as junctions with itself.
    corpus: p.corpus ?? p.roads,
  };
}

/** A due-north road of `lengthM` starting at (eastM, 0) in the given projection. */
function northRoad(at: ReturnType<typeof projector>, eastM: number, lengthM: number): LatLng[] {
  return [at(eastM, 0), at(eastM, lengthM)];
}

/**
 * Lateral offset (m) of the standing lake fixture.
 *
 * 150 m, chosen against the band structure rather than picked: water is graded by which of the four
 * nested radii reach it, so a lake at 150 m is inside three of the four and reads full strength
 * (0.75 of magnitude against FULL_WATER_FRAC = 0.6), with ~50 m of clearance from either band
 * boundary so no assertion here is balanced on one. It is also a realistic distance for a road
 * running along a shore.
 */
const LAKE_OFFSET_M = 150;

/** Open-water tells (lake weight, above OPEN_WATER_W) in a line `eastM` east of a north road. */
function lakeEastOf(
  at: ReturnType<typeof projector>,
  roadEastM: number,
  offsetM: number,
  lengthM: number,
  w = WATER_SIZE.lake,
): WeightedTell[] {
  const out: WeightedTell[] = [];
  for (let n = 0; n <= lengthM; n += RESAMPLE_M) out.push({ pt: at(roadEastM + offsetM, n), w });
  return out;
}

const flat = (): LateralFall => ({ fallM: 0, atM: 0, riseM: 0 });
const drop = (fallM: number): LateralFall => ({ fallM, atM: 400, riseM: 0 });

/** The module's own rounding, so an expectation derived on paper lands on the same quantum. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

const opts = (over: Partial<ReelOptions> = {}): ReelOptions => ({
  at: NOON_BUFFALO,
  aim: 'side',
  ...over,
});

/** The first window of a road, as the mark builder would cut it. */
function firstWindow(road: ScoredRoad): RoadWindow {
  const ws = cutWindows(road);
  expect(ws.length).toBeGreaterThan(0);
  return ws[0];
}

// ------------------------------------------------------------------------------------------------

describe('reelComposite — a weighted mean on a 0-100 axis', () => {
  const all = (v: number): ReelMetrics => ({ backdrop: v, cleanliness: v, light: v, drama: v });

  it('maps all-ten to 100 and all-zero to 0 under the default weights', () => {
    expect(reelComposite(all(10))).toBe(100);
    expect(reelComposite(all(0))).toBe(0);
  });

  it('maps all-ten to 100 and all-zero to 0 under custom weights that do not sum to 1', () => {
    // Normalisation is the property under test: a rider dragging sliders has no reason to keep them
    // summing to one, and a perfect mark must still read 100 when they do not.
    const lopsided: ReelMetrics = { backdrop: 3, cleanliness: 1, light: 0.5, drama: 7 };
    expect(reelComposite(all(10), lopsided)).toBe(100);
    expect(reelComposite(all(0), lopsided)).toBe(0);
  });

  it('pays each dimension exactly its default weight when it alone is perfect', () => {
    // REEL_WEIGHTS is 0.4 / 0.25 / 0.2 / 0.15, so a lone all-ten dimension is worth 40 / 25 / 20 / 15
    // and the four sum to the full 100. Derived from the constant, not from the function.
    expect(reelComposite({ backdrop: 10, cleanliness: 0, light: 0, drama: 0 })).toBe(40);
    expect(reelComposite({ backdrop: 0, cleanliness: 10, light: 0, drama: 0 })).toBe(25);
    expect(reelComposite({ backdrop: 0, cleanliness: 0, light: 10, drama: 0 })).toBe(20);
    expect(reelComposite({ backdrop: 0, cleanliness: 0, light: 0, drama: 10 })).toBe(15);
    expect(REEL_WEIGHTS.backdrop + REEL_WEIGHTS.cleanliness + REEL_WEIGHTS.light + REEL_WEIGHTS.drama).toBe(1);
  });

  it('ignores a dimension weighted zero', () => {
    const w: ReelMetrics = { backdrop: 1, cleanliness: 0, light: 0, drama: 0 };
    expect(reelComposite({ backdrop: 6, cleanliness: 10, light: 10, drama: 10 }, w)).toBe(60);
    expect(reelComposite({ backdrop: 6, cleanliness: 0, light: 0, drama: 0 }, w)).toBe(60);
  });

  it('falls back to the default weights rather than flattening everything to zero', () => {
    // A rider who has dragged every slider to the floor wants a ranking they can re-weight, not a
    // list of identical zeros. Same convention as compositeScore in composite.ts.
    const zeros: ReelMetrics = { backdrop: 0, cleanliness: 0, light: 0, drama: 0 };
    expect(reelComposite(all(10), zeros)).toBe(100);
    expect(reelComposite({ backdrop: 10, cleanliness: 0, light: 0, drama: 0 }, zeros)).toBe(40);
  });
});

describe('junctionsPerKm — the free cleanliness proxy', () => {
  const road = makeRoad('scan-1', 'Through Rd', northRoad(BUFFALO, 0, WINDOW_M));
  const w = firstWindow(road);

  /** A side road teeing into the through road `northM` along it, running `eastM` away. */
  const tee = (id: string, northM: number, eastM: number): ScannedRoad =>
    makeRoad(id, 'Side Rd', [BUFFALO(0, northM), BUFFALO(eastM, northM)]);

  it('is zero when nothing else touches the road', () => {
    expect(junctionsPerKm(w, [road])).toBe(0);
  });

  it('counts other ways teeing in, per km of window', () => {
    // Two tees on a 400 m window is 2 / 0.4 km = 5.0 per km, which is below the saturating
    // FULL_JUNCTION_PER_KM of 6 — i.e. busy, but not yet a grid.
    expect(w.lengthM).toBeCloseTo(WINDOW_M, 6);
    const n = junctionsPerKm(w, [road, tee('scan-2', 100, 200), tee('scan-3', 300, -200)]);
    expect(n).toBeCloseTo(5.0, 6);
    expect(n).toBeLessThan(FULL_JUNCTION_PER_KM);
  });

  it('does NOT count the window road\'s own two endpoints', () => {
    // Both ends of the through road lie on this window, at zero distance from a sample. If a road's
    // own termini counted, the two tees above would read 4 junctions instead of 2 and every long
    // rural road split into short OSM ways would look like suburbia.
    expect(junctionsPerKm(w, [road])).toBe(0);
    expect(junctionsPerKm(w, [road, tee('scan-2', 100, 200)])).toBeCloseTo(2.5, 6);
  });

  it('counts a crossroads once, not once per arm', () => {
    // Three ways ending at the same node is one junction. OSM ways split at a junction share that
    // node exactly, which is why the rounded-endpoint key from routeBuilder is reused verbatim.
    const east = tee('scan-2', 200, 200);
    const west = tee('scan-3', 200, -200);
    const north = makeRoad('scan-4', 'Spur', [BUFFALO(0, 200), BUFFALO(120, 320)]);
    expect(junctionsPerKm(w, [road, east, west, north])).toBeCloseTo(2.5, 6);
  });

  it('ignores endpoints that are merely nearby, not on the road', () => {
    // A way ending 200 m off the road is not a junction with it. The tolerance is tens of metres —
    // half a resample interval plus slack — so a parallel road's ends must not be swept in.
    const parallel = makeRoad('scan-9', 'Parallel Rd', [BUFFALO(200, 100), BUFFALO(200, 300)]);
    expect(junctionsPerKm(w, [road, parallel])).toBe(0);
  });

  it('returns zero for a window with no length rather than dividing by it', () => {
    expect(junctionsPerKm({ ...w, lengthM: 0 }, [road])).toBe(0);
  });
});

describe('scoreBackdrop — two mechanisms, neither of which can see the other', () => {
  const ROAD_LEN = WINDOW_M;
  const road = makeRoad('scan-1', 'Rim Rd', northRoad(BUFFALO, 0, ROAD_LEN));
  const w = firstWindow(road);
  const lakeScan = makeScan({
    roads: [road],
    waterPts: lakeEastOf(BUFFALO, 0, LAKE_OFFSET_M, ROAD_LEN),
  });
  const dryScan = makeScan({ roads: [road] });

  it('scores a lakeside road above zero with ZERO lateral fall — the DEM cannot see water', () => {
    // The Lake Erie shore returned 0 m of lateral fall: a lake surface is flat. If backdrop rested on
    // the DEM alone, every shoreline in the scan would read as flat farmland.
    const b = scoreBackdrop(w, lakeScan, { left: flat(), right: flat() });
    expect(b.right.terrain10).toBe(0);
    expect(b.right.water10).toBe(10);
    expect(b.right.score10).toBeGreaterThan(0);
    expect(b.right.score10).toBeGreaterThanOrEqual(BACKDROP_MIN);
  });

  it('scores a gorge road above zero with NO water — polygons cannot see a rim', () => {
    // Letchworth Park Rd measures 130.3 m of mean lateral fall and has no lake beside it. Against
    // FULL_FALL_M (120 m) that saturates the terrain term.
    const b = scoreBackdrop(w, dryScan, { left: flat(), right: drop(130.3) });
    expect(b.right.water10).toBe(0);
    expect(b.right.waterM).toBeNull();
    expect(b.right.terrain10).toBe(10);
    expect(b.right.score10).toBeGreaterThan(0);
  });

  it('takes the STRONGER of the two mechanisms, never their mean', () => {
    // A 130 m drop to the right with no lake is not half a backdrop. Averaging would score it 5.0.
    const b = scoreBackdrop(w, dryScan, { left: flat(), right: drop(FULL_FALL_M) });
    expect(b.right.score10).toBe(10);
    expect(b.right.score10).not.toBeCloseTo(5, 3);

    // And the other way round: a half-strength drop under a full lake reads 10, not 7.5.
    const both = scoreBackdrop(w, lakeScan, { left: flat(), right: drop(FULL_FALL_M / 2) });
    expect(both.right.terrain10).toBe(5);
    expect(both.right.water10).toBe(10);
    expect(both.right.score10).toBe(10);
  });

  it('puts the lake on the right of a northbound road and reports its distance', () => {
    const b = scoreBackdrop(w, lakeScan, null);
    expect(b.right.water10).toBe(10);
    expect(b.left.water10).toBe(0);
    expect(b.left.waterM).toBeNull();
    // Placed LAKE_OFFSET_M east of every sample, so the nearest is that, to within the projection's
    // own rounding — an independent check that the side scan measures in metres, not degrees.
    expect(b.right.waterM).toBeCloseTo(LAKE_OFFSET_M, 0);
  });

  it('ramps with COVERAGE and cuts off hard at BACKDROP_WATER_M', () => {
    // One lake vertex, 390 m east of the road's southern end. The cutoff is a hard 400 m radius, so
    // the samples that see it are those within sqrt(400^2 - 390^2) = 88.9 m along the road: n = 0,
    // 25, 50, 75, i.e. 4 of the window's 17 samples (the next, at 100 m, is 402.6 m away). All four
    // sit in the OUTERMOST band, so they are counted by one of the four nested radii and the
    // magnitude is (4/17)/4 = 0.0588 — 1.0 out of 10 against FULL_WATER_FRAC. A lake glimpsed at one
    // end of the window from 390 m away is not a shoreline, and it must not be able to name a
    // backdrop side. Under the coverage-only reading this scored 4.7 and cleared BACKDROP_MIN.
    const glimpse = makeScan({ roads: [road], waterPts: [{ pt: BUFFALO(390, 0), w: 0.8 }] });
    const b = scoreBackdrop(w, glimpse, null);
    expect(b.right.water10).toBeCloseTo(1.0, 6);
    expect(b.right.score10).toBeLessThan(BACKDROP_MIN);
    expect(b.left.water10).toBe(0);
    // The hard cutoff itself: one metre further out and nothing is seen at all. A decay term could
    // not localise a moment this way — adjacent 400 m windows under one differ by 3.5%.
    const beyond = makeScan({ roads: [road], waterPts: [{ pt: BUFFALO(BACKDROP_WATER_M + 1, 200), w: 0.8 }] });
    expect(scoreBackdrop(w, beyond, null).right.water10).toBe(0);
  });

  it('scores a NEAR lake above a FAR one at identical coverage', () => {
    // Both lakes run the whole length of the road, so both are seen by all 17 samples and the two
    // are indistinguishable by coverage — which is exactly what the reading used to be, and why both
    // scored 10. A lake at 50 m fills a 9:16 frame; the same lake at 350 m is a smudge behind the
    // rider. 50 m is inside the nearest of the four nested radii so it is counted by all of them
    // (magnitude 1.0); 350 m is inside only the outermost (magnitude 0.25).
    const near = makeScan({ roads: [road], waterPts: lakeEastOf(BUFFALO, 0, 50, ROAD_LEN) });
    const far = makeScan({ roads: [road], waterPts: lakeEastOf(BUFFALO, 0, 350, ROAD_LEN) });
    const bNear = scoreBackdrop(w, near, null);
    const bFar = scoreBackdrop(w, far, null);

    expect(bNear.right.waterM).toBeCloseTo(50, 0);
    expect(bFar.right.waterM).toBeCloseTo(350, 0);
    expect(bNear.right.water10).toBe(10);
    // 0.25 of magnitude against FULL_WATER_FRAC = 0.6 is 4.2 — present, and a long way from full.
    expect(bFar.right.water10).toBeCloseTo(round1((0.25 / FULL_WATER_FRAC) * 10), 6);
    expect(bFar.right.water10).toBeLessThan(bNear.right.water10);
  });

  it('cannot let a three-in-seventeen glimpse clear BACKDROP_MIN at ANY distance', () => {
    // The named C2 false positive, checked as arithmetic on the constants rather than on one
    // fixture: coverage is bounded by 1 in every band, so 3 of 17 samples can reach at most
    // 3/17 = 0.176 of magnitude however close the water is. Against FULL_WATER_FRAC that is 2.9.
    // At the old 0.5 it was exactly 3.5, i.e. it cleared the bar — which is the whole finding.
    const best = round1((3 / 17 / FULL_WATER_FRAC) * 10);
    expect(best).toBeLessThan(BACKDROP_MIN);
    expect(round1((3 / 17 / 0.5) * 10)).toBeGreaterThanOrEqual(BACKDROP_MIN);
  });

  it('reads the same magnitude for every band, so the staircase is uniform', () => {
    // The bands must partition the cutoff evenly, or "how far" would be graded finely near the road
    // and coarsely far from it for no stated reason. A lake sitting in band k scores k steps down.
    const stepM = BACKDROP_WATER_M / WATER_BANDS;
    for (let k = 1; k <= WATER_BANDS; k++) {
      // Mid-band, so the assertion is not balanced on a boundary.
      const offset = stepM * (k - 0.5);
      const scan = makeScan({ roads: [road], waterPts: lakeEastOf(BUFFALO, 0, offset, ROAD_LEN) });
      const expected = round1(Math.min(1, (WATER_BANDS - k + 1) / WATER_BANDS / FULL_WATER_FRAC) * 10);
      expect(scoreBackdrop(w, scan, null).right.water10).toBeCloseTo(expected, 6);
    }
  });

  it('outscores a stream with a lake at the SAME distance and the same coverage', () => {
    // The size axis, and where it lives: it is a HARD GATE at OPEN_WATER_W, not a graded term. A
    // stream centreline (WATER_SIZE.stream = 0.3) and a lake shore (0.8) here run identically —
    // same offset, same length, same coverage — and only the lake is a backdrop. The Heim Rd audit
    // is why: 0.25 ha ponds behind houses and a creek in a wooded gully drove a 7.6 water score with
    // no visible water anywhere, so what a stream needs is exclusion, not a smaller number.
    expect(WATER_SIZE.stream).toBeLessThan(OPEN_WATER_W);
    expect(WATER_SIZE.lake).toBeGreaterThanOrEqual(OPEN_WATER_W);
    const stream = makeScan({
      roads: [road],
      waterPts: lakeEastOf(BUFFALO, 0, LAKE_OFFSET_M, ROAD_LEN, WATER_SIZE.stream),
    });
    const bStream = scoreBackdrop(w, stream, null);
    const bLake = scoreBackdrop(w, lakeScan, null);
    expect(bStream.right.water10).toBe(0);
    expect(bStream.right.waterM).toBeNull();
    expect(bLake.right.water10).toBeGreaterThan(bStream.right.water10);
  });

  it('ignores water just below OPEN_WATER_W — the gate is on the weight, not on the name', () => {
    const creekWeight = OPEN_WATER_W - 0.1;
    const creek = makeScan({
      roads: [road],
      waterPts: lakeEastOf(BUFFALO, 0, LAKE_OFFSET_M, ROAD_LEN, creekWeight),
    });
    const b = scoreBackdrop(w, creek, null);
    expect(b.right.water10).toBe(0);
    expect(b.right.waterM).toBeNull();
  });

  it('flips exactly with flipSides, which is how the reverse direction is read', () => {
    const fwd = scoreBackdrop(w, lakeScan, { left: flat(), right: drop(130.3) });
    const rev = flipSides(fwd);
    expect(rev.left).toBe(fwd.right);
    expect(rev.right).toBe(fwd.left);
    expect(rev.left.score10).toBe(10);
  });

  it('reads water only when the DEM has not landed, without pretending the ground is flat', () => {
    const b = scoreBackdrop(w, lakeScan, null);
    expect(b.right.fall).toBeNull();
    expect(b.right.terrain10).toBe(0);
    expect(b.right.score10).toBe(10);
  });
});

describe('scoreClean — proxy, override, and the ugly penalty', () => {
  const road = makeRoad('scan-1', 'Rural Rd', northRoad(BUFFALO, 0, WINDOW_M));
  const w = firstWindow(road);

  /** `n` built-up ways on a lattice inside ±250 m of `centre`, as Overpass would return them. */
  function builtCluster(centre: LatLng, n: number): OverpassElement[] {
    const at = projector(centre[0], centre[1]);
    const side = Math.ceil(Math.sqrt(n));
    const out: OverpassElement[] = [];
    for (let i = 0; i < n; i++) {
      const e = -250 + (500 * (i % side)) / side;
      const s = -250 + (500 * Math.floor(i / side)) / side;
      out.push({ type: 'way', id: 1000 + i, geometry: [{ lat: at(e, s)[0], lon: at(e, s)[1] }] });
    }
    return out;
  }

  it('reads clean and PROVISIONAL when only the free proxies are available', () => {
    const c = scoreClean(w, makeScan({ roads: [road] }), null);
    expect(c.junctionsPerKm).toBe(0);
    expect(c.junctionDensity).toBe(0);
    expect(c.builtDensity).toBeNull();
    expect(c.provisional).toBe(true);
    expect(c.score10).toBe(10);
  });

  it('ranks two rural windows that both have ZERO junctions on them', () => {
    // The C2 finding, and the reason the disc reading exists beside the along-window count. Nothing
    // tees into either road, so `junctionsPerKm` is 0 for both and cannot separate them at all —
    // measured on a real 30 km scan it was 0 at both the 25th and the 50th percentile. What differs
    // is the fabric AROUND them: the second road sits among four other ways whose ends fall inside
    // the reading disc, 300 m off to the side so none of them touches the road itself.
    //
    // Eight distinct endpoints inside a disc of pi * 0.8^2 = 2.011 km^2 is 3.98 nodes/km^2, i.e.
    // 0.796 of the saturating FULL_JUNCTION_DENSITY — on the measured ladder that is a village.
    const lonely = makeRoad('scan-1', 'Lonely Rd', northRoad(BUFFALO, 0, WINDOW_M));
    const fringe = makeRoad('scan-2', 'Fringe Rd', northRoad(BUFFALO, 20000, WINDOW_M));
    const neighbours: ScannedRoad[] = [];
    for (let i = 0; i < 4; i++) {
      neighbours.push(
        makeRoad(`scan-${10 + i}`, 'Lane', [
          BUFFALO(20300, 100 * i),
          BUFFALO(20600, 100 * i),
        ]),
      );
    }
    const scan = makeScan({ roads: [lonely, fringe], corpus: [lonely, fringe, ...neighbours] });

    const cLonely = scoreClean(firstWindow(lonely), scan, null);
    const cFringe = scoreClean(firstWindow(fringe), scan, null);

    expect(cLonely.junctionsPerKm).toBe(0);
    expect(cFringe.junctionsPerKm).toBe(0);
    expect(cLonely.junctionDensity).toBe(0);
    expect(cFringe.junctionDensity).toBeCloseTo(8 / (Math.PI * 0.8 ** 2), 1);
    expect(cLonely.score10).toBe(10);
    expect(cFringe.score10).toBeLessThan(cLonely.score10);
    expect(cFringe.score10).toBeCloseTo(
      round1(10 * (1 - cFringe.junctionDensity / FULL_JUNCTION_DENSITY)),
      6,
    );
  });

  it('does not let a road\'s own endpoints make it look built-up', () => {
    // Same rule as `junctionsPerKm`, and it matters more here: OSM splits ways at TAG changes, so a
    // surface change in the middle of a rural road leaves two endpoints inside the disc that no
    // rider would call a junction. A lone road must read as empty country.
    const alone = makeScan({ roads: [road] });
    expect(junctionDensityNear(w, alone.corpus, BUILT_RADIUS_M)).toBe(0);
    // …and another road's ends in the same place do count, so the zero above is the exclusion rule
    // firing rather than the disc missing them.
    const other = makeRoad('scan-2', 'Other Rd', [BUFFALO(300, 0), BUFFALO(300, WINDOW_M)]);
    expect(
      junctionDensityNear(w, [road, other], BUILT_RADIUS_M),
    ).toBeCloseTo(2 / (Math.PI * 0.8 ** 2), 1);
  });

  it('saturates the proxy penalty at FULL_JUNCTION_PER_KM', () => {
    // Six junctions on a 400 m window is 15 per km, well past the saturating 6.
    const tees: ScannedRoad[] = [];
    for (let i = 1; i <= 6; i++) {
      tees.push(makeRoad(`scan-${i + 1}`, 'Side', [BUFFALO(0, i * 50), BUFFALO(200, i * 50)]));
    }
    const c = scoreClean(w, makeScan({ roads: [road], corpus: [road, ...tees] }), null);
    expect(c.junctionsPerKm).toBeGreaterThan(FULL_JUNCTION_PER_KM);
    expect(c.score10).toBe(0);
  });

  it('OVERRIDES the proxy with the measured built-up density, and clears provisional', () => {
    // The proxy sees no junctions at all here — this road has nothing teeing into it — while the
    // measured residential/service density says suburbia. That is exactly the gap the refinement
    // closes: `corpus` carries no residential or service ways, so an estate hanging off a rural road
    // is invisible to the proxy and visible to the query.
    const dense = countBuiltWays(builtCluster(w.mid, 1400));
    const c = scoreClean(w, makeScan({ roads: [road] }), dense);
    expect(c.junctionsPerKm).toBe(0);
    expect(c.provisional).toBe(false);
    expect(c.builtDensity).toBeGreaterThan(0);
    expect(c.score10).toBeLessThan(10);
  });

  it('reads a genuinely empty built-up index as clean, not as missing', () => {
    const empty = countBuiltWays([]);
    const c = scoreClean(w, makeScan({ roads: [road] }), empty);
    expect(c.builtDensity).toBe(0);
    expect(c.provisional).toBe(false);
    expect(c.score10).toBe(10);
  });

  it('lets the measurement overrule a proxy that cried wolf, rather than averaging with it', () => {
    // The proxy's characteristic false positive: a rural crossroads hamlet where several
    // through-roads meet, which reads as suburbia at 15 junctions/km and is nothing of the sort.
    // The measured residential/service density is the signal with 20.6x separation behind it, so it
    // REPLACES the stand-in. Blending the two would leave this window at half a penalty it has not
    // earned, and no coefficient exists that could be calibrated to say how much of a penalty that is.
    const tees: ScannedRoad[] = [];
    for (let i = 1; i <= 6; i++) {
      tees.push(makeRoad(`scan-${i + 1}`, 'Side', [BUFFALO(0, i * 50), BUFFALO(200, i * 50)]));
    }
    const scan = makeScan({ roads: [road], corpus: [road, ...tees] });
    expect(scoreClean(w, scan, null).score10).toBe(0);

    const measured = scoreClean(w, scan, countBuiltWays([]));
    expect(measured.junctionsPerKm).toBeGreaterThan(FULL_JUNCTION_PER_KM);
    expect(measured.builtDensity).toBe(0);
    expect(measured.score10).toBe(10);
  });

  it('ignores built-up ways beyond the reading radius', () => {
    const far = projector(w.mid[0], w.mid[1])(BUILT_RADIUS_M * 3, 0);
    const c = scoreClean(w, makeScan({ roads: [road] }), countBuiltWays(builtCluster(far, 1400)));
    expect(c.builtDensity).toBe(0);
    expect(c.score10).toBe(10);
  });

  it('zeroes a window wholly inside an ugly area, and leaves one wholly outside alone', () => {
    const box = (s: number, w0: number, n: number, e: number): LatLng[] => [
      BUFFALO(w0, s),
      BUFFALO(e, s),
      BUFFALO(e, n),
      BUFFALO(w0, n),
    ];
    const inside = scoreClean(w, makeScan({ roads: [road], uglyAreas: [box(-100, -100, 600, 100)] }), null);
    expect(inside.uglyFrac).toBe(1);
    expect(inside.score10).toBe(0);

    const outside = scoreClean(w, makeScan({ roads: [road], uglyAreas: [box(-100, 500, 600, 700)] }), null);
    expect(outside.uglyFrac).toBe(0);
    expect(outside.score10).toBe(10);
  });

  it('scales down proportionally when an ugly area covers part of the window', () => {
    // The northern half of the window sits in a quarry, so roughly half of it is not clean road.
    const half: LatLng[] = [BUFFALO(-100, 200), BUFFALO(100, 200), BUFFALO(100, 600), BUFFALO(-100, 600)];
    const c = scoreClean(w, makeScan({ roads: [road], uglyAreas: [half] }), null);
    expect(c.uglyFrac).toBeGreaterThan(0.4);
    expect(c.uglyFrac).toBeLessThan(0.6);
    expect(c.score10).toBeGreaterThan(0);
    expect(c.score10).toBeLessThan(10);
  });
});

describe('direction — the guard that everything else rests on', () => {
  const ROAD_LEN = WINDOW_M;

  /** A north-digitised road with open water to its EAST — so east is the rider's RIGHT going north
   *  and their LEFT going south. Nothing about the road changes between hemispheres. */
  function lakeRoadScan(at: ReturnType<typeof projector>): AreaScan {
    const road = makeRoad('scan-1', 'Shore Rd', northRoad(at, 0, ROAD_LEN));
    return makeScan({ roads: [road], waterPts: lakeEastOf(at, 0, LAKE_OFFSET_M, ROAD_LEN) });
  }

  /** A north-digitised road with nothing beside it at all, so no direction has a backdrop. */
  function bareRoadScan(at: ReturnType<typeof projector>): AreaScan {
    return makeScan({ roads: [makeRoad('scan-1', 'Plain Rd', northRoad(at, 0, ROAD_LEN))] });
  }

  it('scores the two directions of a window EXACTLY equal — the premise of every tiebreak', () => {
    // Not an implementation detail: it is why the tiebreak chain IS the mechanism rather than a
    // corner case. Both aim functions are symmetric about 90 degrees, so riding a road the other way
    // turns an off-axis angle of x into 180 - x and the light is unchanged; the elevation term is the
    // same instant at the same place; the scalar backdrop is the better of the two sides and so
    // survives a flip; cleanliness and drama have no direction at all. Asserted here against the
    // planner directly, so it cannot be satisfied by whatever `buildMarks` happens to return.
    for (const bearing of [0, 37, 90, 143, 180, 271, 359]) {
      const fwd = lightAt(NOON_BUFFALO, BUFFALO(0, 0), bearing, 'side');
      const rev = lightAt(NOON_BUFFALO, BUFFALO(0, 0), (bearing + 180) % 360, 'side');
      expect(rev.score10).toBe(fwd.score10);
      const metrics = (light: number): ReelMetrics => ({ backdrop: 10, cleanliness: 7, light, drama: 4 });
      expect(reelComposite(metrics(rev.score10))).toBe(reelComposite(metrics(fwd.score10)));
    }
  });

  it('breaks that tie toward the direction that puts the backdrop on the RIGHT', () => {
    // THE C1 GUARD, and the most important assertion in this file. The boom is mounted out to the
    // right, so `right` is the side the rig actually films and `left` is a reframe out of the 360
    // capture. The two directions score identically (above), so aiming the backdrop at the boom
    // costs the rider nothing at all — and before this rule existed, 17 of the top 40 marks on a real
    // 30 km Buffalo scan pointed it at the other verge, every one of them at an identical composite.
    //
    // Both hemispheres, because the sun's tiebreak wants OPPOSITE directions in the two and the
    // backdrop must overrule it in both. In Sydney reelPlan would send this rider south, which would
    // put the lake on their left; the answer is north in both places.
    for (const [at, place] of [[BUFFALO, NOON_BUFFALO], [SYDNEY, NOON_SYDNEY]] as const) {
      const marks = buildMarks(lakeRoadScan(at), opts({ at: place }));
      expect(marks).toHaveLength(1);
      expect(marks[0].direction).toBe('forward');
      expect(marks[0].travelBearingDeg).toBeCloseTo(0, 6);
      expect(marks[0].backdropSide).toBe('right');
      expect(marks[0].backdrop.right.water10).toBe(10);
      expect(marks[0].backdrop.left.water10).toBe(0);
    }
  });

  it('rides the OTHER way when the backdrop is on the other verge', () => {
    // The converse, and the one that proves the rule is about the backdrop's side rather than about
    // the road's digitisation: the same road with the water to its WEST must be ridden south.
    const road = makeRoad('scan-1', 'Shore Rd', northRoad(BUFFALO, 0, ROAD_LEN));
    const westLake = makeScan({ roads: [road], waterPts: lakeEastOf(BUFFALO, 0, -LAKE_OFFSET_M, ROAD_LEN) });
    const [mark] = buildMarks(westLake, opts());
    expect(mark.direction).toBe('reverse');
    expect(mark.travelBearingDeg).toBeCloseTo(180, 6);
    expect(mark.backdropSide).toBe('right');
    expect(mark.backdrop.right.water10).toBe(10);
  });

  it('falls back to the sun tiebreak when NEITHER direction puts a backdrop on the right', () => {
    // A bare road has no backdrop either way, so step 2 of the chain cannot fire and reelPlan's
    // "put the sun behind you" decides — north in the northern hemisphere at solar noon, south in
    // the southern one. Preconditions asserted rather than assumed: at solar noon the sun is in the
    // southern half-plane at Buffalo and the northern one at Sydney.
    const sunN = solarPosition(NOON_BUFFALO, 42.9, -78.85);
    expect(sunN.azimuthDeg).toBeGreaterThan(90);
    expect(sunN.azimuthDeg).toBeLessThan(270);
    const sunS = solarPosition(NOON_SYDNEY, -33.87, 151.21);
    expect(sunS.azimuthDeg < 90 || sunS.azimuthDeg > 270).toBe(true);

    const [north] = buildMarks(bareRoadScan(BUFFALO), opts());
    expect(north.backdropSide).toBeNull();
    expect(north.direction).toBe('forward');
    expect(north.travelBearingDeg).toBeCloseTo(0, 6);

    const [south] = buildMarks(bareRoadScan(SYDNEY), opts({ at: NOON_SYDNEY }));
    expect(south.backdropSide).toBeNull();
    expect(south.direction).toBe('reverse');
    expect(south.travelBearingDeg).toBeCloseTo(180, 6);
  });

  it('falls back to the sun tiebreak when BOTH directions put a backdrop on the right', async () => {
    // A gorge with the ground falling away equally on both sides. `pickSide` breaks its own tie
    // toward the right, so BOTH directions report `right` and step 2 cannot separate them either —
    // the sun has to decide, and the two hemispheres disagree, which is what proves it is the sun
    // deciding and not the road's stored vertex order.
    //
    // The terrain mechanism rather than water, because the two sides have to be EXACTLY equal for
    // this case to exist at all and `sideScan` gives each sample to its single nearest tell: water
    // at equal distance on both sides is a coin flip per sample, not a 50/50 split.
    const gorge = (at: ReturnType<typeof projector>): AreaScan =>
      makeScan({ roads: [makeRoad('scan-1', 'Notch Rd', northRoad(at, 0, ROAD_LEN))] });
    mockFall.mockImplementation(async (ws) =>
      new Map(ws.map((w) => [w.id, { left: drop(130.3), right: drop(130.3) } as PerSide<LateralFall>])),
    );

    const north = gorge(BUFFALO);
    const [markN] = await enrichMarks(buildMarks(north, opts()), north, opts());
    expect(markN.backdrop.left.score10).toBe(markN.backdrop.right.score10);
    expect(markN.backdrop.left.score10).toBeGreaterThanOrEqual(BACKDROP_MIN);
    expect(markN.backdropSide).toBe('right');
    expect(markN.direction).toBe('forward');

    const south = gorge(SYDNEY);
    const o = opts({ at: NOON_SYDNEY });
    const [markS] = await enrichMarks(buildMarks(south, o), south, o);
    expect(markS.backdropSide).toBe('right');
    expect(markS.direction).toBe('reverse');
  });

  it('carries a 130 m drop to the boom side, through enrichment, whichever verge it is on', async () => {
    // The terrain half of the same guard. `readFall` reports left/right against the window's STORED
    // bearing, so a drop east of a north-digitised road arrives as `right` and the road is ridden
    // north; a drop to the WEST arrives as `left` and the same road must be ridden south, so that
    // the rig films the gorge either way. If `backdropSide` did not travel with `direction` this
    // would still name a side and every number on the card would look fine.
    const gorge = (): AreaScan =>
      makeScan({ roads: [makeRoad('scan-1', 'Gorge Rd', northRoad(BUFFALO, 0, ROAD_LEN))] });

    mockFall.mockImplementation(async (ws) =>
      new Map(ws.map((w) => [w.id, { left: flat(), right: drop(130.3) } as PerSide<LateralFall>])),
    );
    const east = gorge();
    const [markE] = await enrichMarks(buildMarks(east, opts()), east, opts());
    expect(markE.direction).toBe('forward');
    expect(markE.backdropSide).toBe('right');
    expect(markE.backdrop.right.terrain10).toBe(10);

    mockFall.mockImplementation(async (ws) =>
      new Map(ws.map((w) => [w.id, { left: drop(130.3), right: flat() } as PerSide<LateralFall>])),
    );
    const west = gorge();
    const [markW] = await enrichMarks(buildMarks(west, opts()), west, opts());
    expect(markW.direction).toBe('reverse');
    expect(markW.backdropSide).toBe('right');
    expect(markW.backdrop.right.terrain10).toBe(10);
  });

  it('still SCORES the better side rather than the boom side — a left-hand gorge is a good road', async () => {
    // The distinction the tiebreak is easy to confuse with, and the reason `metrics.backdrop` stays
    // `max(left, right)`. Which direction to RECOMMEND is settled by which verge the boom faces;
    // what the road is WORTH is not. A 130 m drop is a 130 m drop whichever side it starts on,
    // because the rider can turn around — and turning them around is precisely what the tiebreak
    // does. So the same road with the drop on either verge must score identically.
    const gorge = (): AreaScan =>
      makeScan({ roads: [makeRoad('scan-1', 'Gorge Rd', northRoad(BUFFALO, 0, ROAD_LEN))] });

    mockFall.mockImplementation(async (ws) =>
      new Map(ws.map((w) => [w.id, { left: flat(), right: drop(130.3) } as PerSide<LateralFall>])),
    );
    const eastScan = gorge();
    const [east] = await enrichMarks(buildMarks(eastScan, opts()), eastScan, opts());

    mockFall.mockImplementation(async (ws) =>
      new Map(ws.map((w) => [w.id, { left: drop(130.3), right: flat() } as PerSide<LateralFall>])),
    );
    const westScan = gorge();
    const [west] = await enrichMarks(buildMarks(westScan, opts()), westScan, opts());

    expect(east.metrics.backdrop).toBe(10);
    expect(west.metrics.backdrop).toBe(10);
    expect(west.score).toBe(east.score);
    expect(west.direction).not.toBe(east.direction);
  });

  it('keeps travelBearingDeg consistent with direction on every mark', () => {
    // reverse = forward + 180 (mod 360), for every road in a scan of mixed bearings.
    const roads = [
      makeRoad('scan-1', 'N', [BUFFALO(0, 0), BUFFALO(0, 600)]),
      makeRoad('scan-2', 'E', [BUFFALO(3000, 0), BUFFALO(3600, 0)]),
      makeRoad('scan-3', 'NE', [BUFFALO(6000, 0), BUFFALO(6420, 420)]),
      makeRoad('scan-4', 'SE', [BUFFALO(9000, 500), BUFFALO(9420, 80)]),
    ];
    const marks = buildMarks(makeScan({ roads }), opts());
    expect(marks.length).toBe(4);
    for (const m of marks) {
      const fwd = ((m.window.bearingDeg % 360) + 360) % 360;
      const expected = m.direction === 'forward' ? fwd : (fwd + 180) % 360;
      expect(m.travelBearingDeg).toBeCloseTo(expected, 6);
    }
  });

  it('names a backdropSide only when that side clears BACKDROP_MIN', () => {
    const road = makeRoad('scan-1', 'Flat Rd', northRoad(BUFFALO, 0, ROAD_LEN));
    const marks = buildMarks(makeScan({ roads: [road] }), opts());
    expect(marks[0].backdrop.left.score10).toBe(0);
    expect(marks[0].backdrop.right.score10).toBe(0);
    expect(marks[0].backdropSide).toBeNull();
    expect(marks[0].metrics.backdrop).toBe(0);
  });
});

describe('the boom-side invariant — backdropSide is `right` on every mark that has one', () => {
  // MEASURED FIRST, THEN PINNED. On the 83-tile corpus the emitted `backdropSide` is `right` for
  // every mark of all 1,417 windows across ten (instant x aim) combinations, with zero windows where
  // some direction yields a right-side backdrop and the emitted one does not. A UI is deleting its
  // left-backdrop branches on the strength of that, so it has to be ENFORCED rather than observed —
  // and it is emergent from three separate pieces that nothing currently ties together: `pickSide`'s
  // `>=` tie toward right, `pickDirection` step 2, and `flipSides`. Break any one of them and every
  // number on the shoot card still looks entirely reasonable while the boom points at the empty
  // verge, which is the whole reason this is worth a dedicated sweep.
  //
  // Both mechanisms, because they reach the side label by different routes: terrain arrives from the
  // DEM in the window's STORED orientation and is flipped, water is classified per sample by
  // `sideScan`. Six bearings, so nothing here can be an artifact of the north-south fixtures the rest
  // of this file uses — the sun tiebreak pulls a different way on each of them, and the invariant has
  // to survive it pulling the wrong way.

  /** Roads this far apart cannot interact: past NMS_RADIUS_M (400 m) so nothing suppresses anything,
   *  and past BUILT_RADIUS_M (800 m) so no road's endpoints land in another's cleanliness disc. */
  const ROAD_SPACING_M = 5000;

  const BEARINGS = [0, 45, 90, 135, 200, 315];

  /**
   * A straight `WINDOW_M` road from (`eastM`, 0) running along `bearingDeg`, plus — when `offsetM` is
   * given — a line of open-water tells parallel to it, `offsetM` to the road's STORED right (negative
   * for its stored left).
   *
   * The right-hand normal is bearing + 90, i.e. (east, north) = (cos b, -sin b), which is the same
   * convention `sideOf` and `offsetPath` use. Getting that sign wrong here would make the fixture
   * agree with an inverted implementation, so it is derived rather than copied.
   */
  function straight(eastM: number, bearingDeg: number, offsetM: number | null) {
    const r = (bearingDeg * Math.PI) / 180;
    const at = (alongM: number, sideM: number): LatLng =>
      BUFFALO(
        eastM + alongM * Math.sin(r) + sideM * Math.cos(r),
        alongM * Math.cos(r) - sideM * Math.sin(r),
      );
    const coords: LatLng[] = [at(0, 0), at(WINDOW_M, 0)];
    const water: WeightedTell[] = [];
    if (offsetM !== null) {
      // Past both ends of the road, so every sample of the window sees the lake abeam at exactly
      // `offsetM` and coverage is not clipped at the ends.
      for (let s = -50; s <= WINDOW_M + 50; s += RESAMPLE_M) {
        water.push({ pt: at(s, offsetM), w: WATER_SIZE.lake });
      }
    }
    return { coords, water };
  }

  it('aims a TERRAIN backdrop at the boom, from whichever verge the DEM reports it on', async () => {
    // The five arrangements the two sides can be in, plus the empty one. 130.3 m is Letchworth Park
    // Rd's measured mean lateral fall (terrain10 = 10 against FULL_FALL_M); 60 m is half of
    // FULL_FALL_M, so it reads 5.0 — a real backdrop that is beaten by the other verge, which is the
    // case a naive "is there anything on the right" rule gets wrong.
    const CASES = [
      { name: 'left only', left: 130.3, right: 0 },
      { name: 'right only', left: 0, right: 130.3 },
      { name: 'both, left stronger', left: 130.3, right: 60 },
      { name: 'both, right stronger', left: 60, right: 130.3 },
      { name: 'both, exactly equal', left: 130.3, right: 130.3 },
      { name: 'neither', left: 0, right: 0 },
    ] as const;

    const roads: ScoredRoad[] = [];
    const falls = new Map<string, PerSide<LateralFall>>();
    let n = 0;
    for (const c of CASES) {
      for (const b of BEARINGS) {
        const id = `scan-${n}`;
        roads.push(makeRoad(id, `${c.name} @${b}`, straight(n * ROAD_SPACING_M, b, null).coords));
        falls.set(id, {
          left: c.left > 0 ? drop(c.left) : flat(),
          right: c.right > 0 ? drop(c.right) : flat(),
        });
        n++;
      }
    }
    // Readings are per WINDOW and in the window's stored orientation, which is exactly what
    // `readFall` returns — the flip to the ridden direction is the code under test.
    mockFall.mockImplementation(
      async (ws) => new Map(ws.map((w) => [w.id, falls.get(w.roadId)!])),
    );

    const scan = makeScan({ roads });
    const o = opts();
    const marks = await enrichMarks(buildMarks(scan, o), scan, o);
    expect(marks).toHaveLength(roads.length);

    for (const m of marks) {
      const f = falls.get(m.roadId)!;
      const l10 = terrain10(f.left);
      const r10 = terrain10(f.right);
      const best = Math.max(l10, r10);

      if (best < BACKDROP_MIN) {
        expect(m.backdropSide).toBeNull();
        continue;
      }
      // The invariant itself.
      expect(m.backdropSide).toBe('right');
      // …and that the DIRECTION is what achieves it, rather than the label having been written on a
      // mark ridden the other way: the emitted mark's own `right` carries the stronger stored side.
      expect(m.backdrop.right.terrain10).toBe(best);
      expect(m.metrics.backdrop).toBe(best);
      if (l10 > r10) expect(m.direction).toBe('reverse');
      if (r10 > l10) expect(m.direction).toBe('forward');
      // Nothing was missed: no direction of this window could have done better than the one emitted.
      expect(m.backdrop.right.score10).toBeGreaterThanOrEqual(m.backdrop.left.score10);
    }
  });

  it('aims a WATER backdrop at the boom too, before any enrichment runs', () => {
    // Same invariant by the other route, and it has to be checked separately: water never passes
    // through `flipSides` in the stored orientation the way the DEM reading does — `sideScan`
    // classifies each sample against the local tangent, so the fixture's lake is on the stored right
    // or the stored left by geometry rather than by a label this test hands in.
    const roads: ScoredRoad[] = [];
    const waterPts: WeightedTell[] = [];
    const want = new Map<string, 'forward' | 'reverse'>();
    let n = 0;
    for (const b of BEARINGS) {
      for (const [offsetM, direction] of [
        [LAKE_OFFSET_M, 'forward'],
        [-LAKE_OFFSET_M, 'reverse'],
      ] as const) {
        const id = `scan-${n}`;
        const s = straight(n * ROAD_SPACING_M, b, offsetM);
        roads.push(makeRoad(id, `lake ${direction} @${b}`, s.coords));
        waterPts.push(...s.water);
        want.set(id, direction);
        n++;
      }
    }

    const marks = buildMarks(makeScan({ roads, waterPts }), opts());
    expect(marks).toHaveLength(roads.length);
    for (const m of marks) {
      expect(m.backdropSide).toBe('right');
      expect(m.backdrop.right.water10).toBe(10);
      expect(m.backdrop.left.water10).toBe(0);
      // A lake on the stored right is filmed riding forward; the same lake on the stored left is
      // filmed only by turning round.
      expect(m.direction).toBe(want.get(m.roadId));
    }
  });

  it('never lets the composite decide — the precondition the invariant rests on', () => {
    // A TRIPWIRE, not a regression test: nothing has ever behaved otherwise. `pickDirection` checks
    // the composite FIRST and would silently overrule the boom-side rule if it ever separated the two
    // directions of a window. It cannot today — `directionalLight10` is |cos| and `sideLight10` is
    // |sin| of the off-axis angle, both symmetric about 90 deg, and riding the other way turns x into
    // 180 - x; the elevation term is the same instant at the same place; and every other metric is
    // flip-invariant. Both aims and three instants (high sun, low sun, and after sunset, where the
    // quality term is zero and the product with it is too), because an asymmetric aim function would
    // most likely arrive for one aim only.
    //
    // If this ever goes red, the two tests above lose their guarantee and `ReelMark.backdropSide`
    // stops being `'right' | null`. That is the point of failing here first, with the cost named.
    const instants = [
      NOON_BUFFALO,
      new Date('2026-06-21T23:30:00Z'), // ~19:30 local, low sun — the shoot window this exists for
      new Date('2026-06-22T03:00:00Z'), // after sunset
    ];
    for (const aim of ['side', 'forward'] as const) {
      for (const at of instants) {
        for (const bearing of [0, 17, 45, 90, 133, 180, 217, 271, 359]) {
          const fwd = lightAt(at, BUFFALO(0, 0), bearing, aim);
          const rev = lightAt(at, BUFFALO(0, 0), (bearing + 180) % 360, aim);
          expect(rev.score10).toBe(fwd.score10);
          // The quantity `pickDirection` actually compares, at a tolerance of half its own reporting
          // quantum: with both composites integers, only exact equality keeps step 1 from firing.
          const metrics = (light: number): ReelMetrics => ({
            backdrop: 10,
            cleanliness: 6,
            light,
            drama: 3,
          });
          expect(reelComposite(metrics(rev.score10))).toBe(reelComposite(metrics(fwd.score10)));
        }
      }
    }
  });
});

describe('buildMarks — instant, offline, and de-duplicated', () => {
  it('performs NO network of any kind', () => {
    // The whole two-stage split exists because the built-up query costs ~20-25 s of dispatch
    // overhead against a scan that resolves from tiles in about a second. A stray fetch here would
    // hand that cost back and nothing in the output would say so.
    const boom = vi.fn(() => {
      throw new Error('buildMarks must not touch the network');
    });
    vi.stubGlobal('fetch', boom);

    const road = makeRoad('scan-1', 'Shore Rd', northRoad(BUFFALO, 0, WINDOW_M));
    const scan = makeScan({ roads: [road], waterPts: lakeEastOf(BUFFALO, 0, LAKE_OFFSET_M, WINDOW_M) });
    const marks = buildMarks(scan, opts());

    expect(marks.length).toBeGreaterThan(0);
    expect(boom).not.toHaveBeenCalled();
    expect(mockFall).not.toHaveBeenCalled();
    expect(mockBuilt).not.toHaveBeenCalled();
  });

  it('collapses two overlapping windows on one road into a single mark', () => {
    // A 600 m road is cut into overlapping windows a stride apart; their midpoints are far closer
    // than NMS_RADIUS_M, so they are the same moment and only the strongest survives.
    const road = makeRoad('scan-1', 'Long Rd', northRoad(BUFFALO, 0, 600));
    expect(cutWindows(road).length).toBeGreaterThan(1);
    expect(buildMarks(makeScan({ roads: [road] }), opts())).toHaveLength(1);
  });

  it('never suppresses across roads, even where they meet', () => {
    // Two roads crossing at a junction are two different shots: a rider cannot film both, because
    // they are riding, and the two roads point different ways at different backdrops.
    const ns = makeRoad('scan-1', 'N-S Rd', [BUFFALO(0, -200), BUFFALO(0, 200)]);
    const ew = makeRoad('scan-2', 'E-W Rd', [BUFFALO(-200, 0), BUFFALO(200, 0)]);
    const marks = buildMarks(makeScan({ roads: [ns, ew] }), opts());
    expect(new Set(marks.map((m) => m.roadId)).size).toBe(2);
  });

  it('ranks strongest first and applies the limit after suppression', () => {
    const roads = [
      makeRoad('scan-1', 'Plain', northRoad(BUFFALO, 0, WINDOW_M)),
      makeRoad('scan-2', 'Shore', northRoad(BUFFALO, 4000, WINDOW_M)),
      makeRoad('scan-3', 'Plain 2', northRoad(BUFFALO, 8000, WINDOW_M)),
    ];
    const scan = makeScan({ roads, waterPts: lakeEastOf(BUFFALO, 4000, LAKE_OFFSET_M, WINDOW_M) });

    const all = buildMarks(scan, opts());
    expect(all).toHaveLength(3);
    expect(all[0].roadId).toBe('scan-2'); // the only road with a backdrop
    for (let i = 1; i < all.length; i++) expect(all[i - 1].score).toBeGreaterThanOrEqual(all[i].score);

    const capped = buildMarks(scan, opts({ limit: 1 }));
    expect(capped).toHaveLength(1);
    expect(capped[0].roadId).toBe('scan-2');
    expect(buildMarks(scan, opts({ limit: 0 }))).toHaveLength(0);
  });

  it('marks every window provisional before enrichment', () => {
    const road = makeRoad('scan-1', 'Rural Rd', northRoad(BUFFALO, 0, WINDOW_M));
    for (const m of buildMarks(makeScan({ roads: [road] }), opts())) {
      expect(m.clean.provisional).toBe(true);
      expect(m.clean.builtDensity).toBeNull();
      expect(m.backdrop.left.fall).toBeNull();
      expect(m.backdrop.right.fall).toBeNull();
    }
  });

  it('tags only what map data can honestly claim', () => {
    // `water` is presence, never visibility; `gravel` is an explicit surface, never an unmapped one.
    const road = makeRoad('scan-1', 'Shore Rd', northRoad(BUFFALO, 0, WINDOW_M), { paved: false });
    const scan = makeScan({ roads: [road], waterPts: lakeEastOf(BUFFALO, 0, LAKE_OFFSET_M, WINDOW_M) });
    const [mark] = buildMarks(scan, opts());
    expect(mark.tags).toContain('water');
    expect(mark.tags).toContain('gravel');
    expect(mark.tags).not.toContain('corner'); // a dead-straight road
    expect(mark.tags).not.toContain('urban'); // nothing tees into it
    // The six dropped tags stay dropped; only the closed honest set may appear.
    for (const t of mark.tags) expect(['corner', 'water', 'urban', 'gravel']).toContain(t);
  });

  it('never reads greenAreas — `canopy` is gone and its 400 ms with it', () => {
    // C8. The tag rested on `fractionInside(greenAreas)`, which measured 379-409 ms of a 614 ms
    // `buildMarks` on the real 11-tile Buffalo scan — the most expensive thing in the module, on the
    // main thread, repaid on every debounced rebuild, to emit one boolean that nothing ranked on and
    // that the design doc already recorded as over-applied and defective (features.ts pools
    // `leisure=park` with `landuse=forest`, so mown lawn scored like closed forest).
    //
    // Asserted behaviourally rather than by counting calls: a window buried in green polygons must
    // now be indistinguishable from the same window with none, tags and score alike. A green polygon
    // list large enough to be measurable is used so this also fails loudly if the call comes back.
    const road = makeRoad('scan-1', 'Wooded Rd', northRoad(BUFFALO, 0, WINDOW_M));
    const wood: LatLng[] = [BUFFALO(-200, -100), BUFFALO(200, -100), BUFFALO(200, 600), BUFFALO(-200, 600)];
    const [wooded] = buildMarks(makeScan({ roads: [road], greenAreas: [wood] }), opts());
    const [bare] = buildMarks(makeScan({ roads: [road] }), opts());

    expect(wooded.tags).toEqual(bare.tags);
    expect(wooded.score).toBe(bare.score);
    expect(wooded.metrics).toEqual(bare.metrics);
    for (const t of wooded.tags) expect(t).not.toBe('canopy');
  });

  it('tags a window that a grid tees into constantly as urban', () => {
    const road = makeRoad('scan-1', 'Grid Rd', northRoad(BUFFALO, 0, WINDOW_M));
    const tees: ScannedRoad[] = [];
    for (let i = 1; i <= 6; i++) {
      tees.push(makeRoad(`scan-${i + 1}`, 'Side', [BUFFALO(0, i * 50), BUFFALO(200, i * 50)]));
    }
    const scan = makeScan({ roads: [road], corpus: [road, ...tees] });
    const [mark] = buildMarks(scan, opts());
    expect(mark.clean.junctionsPerKm).toBeGreaterThan(FULL_JUNCTION_PER_KM);
    expect(mark.tags).toContain('urban');
    expect(buildMarks(makeScan({ roads: [road] }), opts())[0].tags).not.toContain('urban');
  });

  it('does not tag gravel when the surface is simply unmapped', () => {
    const road = makeRoad('scan-1', 'Unknown Rd', northRoad(BUFFALO, 0, WINDOW_M));
    expect(buildMarks(makeScan({ roads: [road] }), opts())[0].tags).not.toContain('gravel');
  });

  it('tags a switchback pair as a corner', () => {
    // Total unsigned heading change over the window, against FULL_HEADING_CHANGE_DEG (150 deg). A
    // zigzag of 100 m legs at +/-45 deg turns 90 deg at each vertex, so it saturates drama outright.
    const zig: LatLng[] = [
      BUFFALO(0, 0),
      BUFFALO(70, 70),
      BUFFALO(0, 140),
      BUFFALO(70, 210),
      BUFFALO(0, 280),
      BUFFALO(70, 350),
      BUFFALO(0, 420),
    ];
    const [mark] = buildMarks(makeScan({ roads: [makeRoad('scan-1', 'Switchback Rd', zig)] }), opts());
    expect(mark.metrics.drama).toBe(10);
    expect(mark.tags).toContain('corner');
  });
});

describe('re-weighting — selection is weight-dependent, so a re-rank has to re-select', () => {
  // Two roads that are only worth looking at for their backdrop, and two that are only worth looking
  // at for their corners, each pair far enough apart that nothing suppresses anything. With a limit
  // of two, the default weights keep the water pair and drama-only weights keep the switchback pair,
  // so the two weight settings disagree about WHICH marks exist and not merely about their order.
  const zig = (eastM: number): LatLng[] => [
    BUFFALO(eastM, 0),
    BUFFALO(eastM + 70, 70),
    BUFFALO(eastM, 140),
    BUFFALO(eastM + 70, 210),
    BUFFALO(eastM, 280),
    BUFFALO(eastM + 70, 350),
    BUFFALO(eastM, 420),
  ];
  const roads = [
    makeRoad('scan-1', 'Shore A', northRoad(BUFFALO, 0, WINDOW_M)),
    makeRoad('scan-2', 'Shore B', northRoad(BUFFALO, 4000, WINDOW_M)),
    makeRoad('scan-3', 'Switchback A', zig(8000)),
    makeRoad('scan-4', 'Switchback B', zig(12000)),
  ];
  const scan = (): AreaScan =>
    makeScan({
      roads,
      waterPts: [
        ...lakeEastOf(BUFFALO, 0, LAKE_OFFSET_M, WINDOW_M),
        ...lakeEastOf(BUFFALO, 4000, LAKE_OFFSET_M, WINDOW_M),
      ],
    });

  const dramaOnly: ReelMetrics = { backdrop: 0, cleanliness: 0, light: 0, drama: 1 };
  const A = (): ReelOptions => opts({ limit: 2 });
  const B = (): ReelOptions => opts({ limit: 2, weights: dramaOnly });

  it('picks a genuinely different pair of marks under the two weight settings', () => {
    // The premise. Without it the equality below would hold for a re-sort as well and prove nothing.
    expect(buildMarks(scan(), A()).map((m) => m.roadId)).toEqual(['scan-1', 'scan-2']);
    expect(buildMarks(scan(), B()).map((m) => m.roadId).sort()).toEqual(['scan-3', 'scan-4']);
  });

  it('selectMarks over a pool built under A equals buildMarks under B, exactly', () => {
    // THE C5 CONTRACT, stated as an equality rather than claimed in a comment. Both non-max
    // suppression and the limit consume `mark.score`, so the weights in force at build time decide
    // which of two overlapping windows survives and which `limit` of ~1,400 windows are kept. The
    // pool therefore has to carry every window — and both directions of each, since the direction
    // tiebreak starts with the composite and the composite is weight-dependent.
    const pool = scoreWindows(scan(), A());
    const reweighted = selectMarks(pool, B());
    const fresh = buildMarks(scan(), B());

    const shape = (ms: typeof fresh) =>
      ms.map((m) => ({ id: m.id, direction: m.direction, score: m.score, metrics: m.metrics }));
    expect(shape(reweighted)).toEqual(shape(fresh));
    // …and the same pool re-selected under its own weights reproduces the original answer.
    expect(shape(selectMarks(pool, A()))).toEqual(shape(buildMarks(scan(), A())));
  });

  it('and re-scoring the OLD shortlist does NOT — which is what this replaces', () => {
    // The teeth. Dragging `drama` to 1 and everything else to 0 used to return the marks the
    // BACKDROP weights had already chosen, re-sorted by drama: a list with no switchback in it at
    // all, and nothing in the output saying so. Measured on a real 30 km scan it made 37 of the 40
    // genuinely-best marks unreachable.
    const shortlistA = buildMarks(scan(), A());
    const resorted = shortlistA
      .map((m) => ({ ...m, score: reelComposite(m.metrics, dramaOnly) }))
      .sort((a, b) => b.score - a.score);
    const correct = buildMarks(scan(), B());

    expect(resorted.map((m) => m.roadId)).not.toEqual(correct.map((m) => m.roadId));
    expect(Math.max(...resorted.map((m) => m.metrics.drama))).toBeLessThan(
      Math.max(...correct.map((m) => m.metrics.drama)),
    );
  });

  it('carries both directions of every window in the pool', () => {
    // The structural property the equality rests on: resolving direction when the pool is built
    // would bake the building weights' answer into it, because `pickDirection` starts with the
    // composite.
    const s = scan();
    const windows = s.roads.reduce((n, r) => n + cutWindows(r).length, 0);
    const pool = scoreWindows(s, A());
    expect(pool).toHaveLength(2 * windows);
    for (let i = 0; i < pool.length; i += 2) {
      expect(pool[i + 1].id).toBe(pool[i].id);
      expect(pool[i + 1].direction).not.toBe(pool[i].direction);
    }
  });

  it('does no network, exactly as buildMarks does not', () => {
    const boom = vi.fn(() => {
      throw new Error('scoreWindows must not touch the network');
    });
    vi.stubGlobal('fetch', boom);
    selectMarks(scoreWindows(scan(), A()), B());
    expect(boom).not.toHaveBeenCalled();
    expect(mockFall).not.toHaveBeenCalled();
    expect(mockBuilt).not.toHaveBeenCalled();
  });
});

describe('enrichMarks — refinement that can never cost the rider the first answer', () => {
  const ROAD_LEN = WINDOW_M;
  const rural = makeRoad('scan-1', 'Rural Rd', northRoad(BUFFALO, 0, ROAD_LEN));
  const village = makeRoad('scan-2', 'Village Rd', northRoad(BUFFALO, 5000, ROAD_LEN));

  /** Rural road with nothing; village road with a lake to the east. Same geometry, same bearing, so
   *  the two marks differ only in backdrop and (after enrichment) cleanliness. */
  const twoRoadScan = (): AreaScan =>
    makeScan({
      roads: [rural, village],
      waterPts: lakeEastOf(BUFFALO, 5000, LAKE_OFFSET_M, ROAD_LEN),
    });

  /** Cleanliness-heavy weights, so a measured built-up penalty can outweigh a full water backdrop.
   *  Under REEL_WEIGHTS it cannot: backdrop is 0.4 and cleanliness only 0.25. */
  const cleanFirst: ReelMetrics = { backdrop: 0.1, cleanliness: 0.6, light: 0.1, drama: 0.2 };

  function builtAround(centre: LatLng, n: number): OverpassElement[] {
    const at = projector(centre[0], centre[1]);
    const side = Math.ceil(Math.sqrt(n));
    const out: OverpassElement[] = [];
    for (let i = 0; i < n; i++) {
      const e = -250 + (500 * (i % side)) / side;
      const s = -250 + (500 * Math.floor(i / side)) / side;
      out.push({ type: 'way', id: 2000 + i, geometry: [{ lat: at(e, s)[0], lon: at(e, s)[1] }] });
    }
    return out;
  }

  it('returns the original ranking, still provisional, when BOTH enrichments fail', async () => {
    const scan = twoRoadScan();
    const before = buildMarks(scan, opts({ weights: cleanFirst }));
    const after = await enrichMarks(before, scan, opts({ weights: cleanFirst }));

    expect(after).toHaveLength(before.length);
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
    for (let i = 1; i < after.length; i++) expect(after[i - 1].score).toBeGreaterThanOrEqual(after[i].score);
    for (const m of after) {
      expect(m.clean.provisional).toBe(true);
      // Still a valid mark, not merely a surviving one: the named side is the stronger of the two
      // and clears the bar, the score is the composite of the metrics it carries, and the travel
      // bearing agrees with the direction.
      if (m.backdropSide !== null) {
        expect(m.backdrop[m.backdropSide].score10).toBeGreaterThanOrEqual(BACKDROP_MIN);
        expect(m.backdrop[m.backdropSide].score10).toBe(m.metrics.backdrop);
      } else {
        expect(m.metrics.backdrop).toBeLessThan(BACKDROP_MIN);
      }
      expect(m.score).toBe(reelComposite(m.metrics, cleanFirst));
      const fwd = ((m.window.bearingDeg % 360) + 360) % 360;
      expect(m.travelBearingDeg).toBeCloseTo(m.direction === 'forward' ? fwd : (fwd + 180) % 360, 6);
    }
  });

  it('clears provisional and re-ranks when the built-up query lands', async () => {
    const scan = twoRoadScan();
    const o = opts({ weights: cleanFirst });

    const before = buildMarks(scan, o);
    // The village road leads on its lake backdrop while cleanliness is a tie at 10 apiece.
    expect(before[0].roadId).toBe('scan-2');
    expect(before.every((m) => m.clean.provisional)).toBe(true);

    // Now the measured signal arrives: 1400 residential/service ways around the village road, none
    // anywhere near the rural one. The DEM lands too, and reports flat ground both sides.
    mockBuilt.mockResolvedValue(countBuiltWays(builtAround(village.coords[0], 1400)));
    mockFall.mockImplementation(
      async (ws) => new Map(ws.map((w) => [w.id, { left: flat(), right: flat() }])),
    );

    const after = await enrichMarks(before, scan, o);
    expect(after.every((m) => m.clean.provisional)).toBe(false);
    expect(after.map((m) => m.roadId)).toEqual(['scan-1', 'scan-2']);
    expect(after.find((m) => m.roadId === 'scan-2')!.clean.builtDensity).toBeGreaterThan(0);
    expect(after.find((m) => m.roadId === 'scan-1')!.clean.builtDensity).toBe(0);
  });

  it('keeps the mark ids stable across enrichment so the UI does not lose its place', async () => {
    const scan = twoRoadScan();
    const o = opts({ weights: cleanFirst });
    const before = buildMarks(scan, o);
    mockBuilt.mockResolvedValue(countBuiltWays(builtAround(village.coords[0], 1400)));
    const after = await enrichMarks(before, scan, o);
    expect(new Set(after.map((m) => m.id))).toEqual(new Set(before.map((m) => m.id)));
  });

  it('takes the terrain refinement alone when the built-up query fails, and stays provisional', async () => {
    // Partial degradation: the DEM found a rim, the Overpass mirror did not answer. The backdrop
    // must improve and cleanliness must still declare itself approximate.
    const scan = makeScan({ roads: [rural] });
    const before = buildMarks(scan, opts());
    expect(before[0].metrics.backdrop).toBe(0);

    mockFall.mockImplementation(
      async (ws) => new Map(ws.map((w) => [w.id, { left: flat(), right: drop(130.3) }])),
    );
    const after = await enrichMarks(before, scan, opts());
    expect(after[0].metrics.backdrop).toBe(10);
    expect(after[0].backdropSide).toBe('right');
    expect(after[0].clean.provisional).toBe(true);
    expect(after[0].clean.builtDensity).toBeNull();
  });

  it('leaves marks the terrain probe could not reach on their water-only backdrop', async () => {
    // reelTerrain caps itself at MAX_PROBE_WINDOWS against a measured Open-Meteo 429 threshold, so a
    // partial map is a normal outcome and must not be read as "we looked and found flat ground".
    const scan = twoRoadScan();
    const before = buildMarks(scan, opts());
    mockFall.mockImplementation(async (ws) => new Map([[ws[0].id, { left: flat(), right: drop(130.3) }]]));

    const after = await enrichMarks(before, scan, opts());
    const probed = after.find((m) => m.window.id === before[0].window.id)!;
    const unprobed = after.find((m) => m.window.id !== before[0].window.id)!;
    expect(probed.backdrop.right.fall).not.toBeNull();
    expect(unprobed.backdrop.left.fall).toBeNull();
    expect(unprobed.backdrop.right.fall).toBeNull();
  });

  it('does not touch the network for an empty shortlist', async () => {
    expect(await enrichMarks([], twoRoadScan(), opts())).toEqual([]);
    expect(mockFall).not.toHaveBeenCalled();
    expect(mockBuilt).not.toHaveBeenCalled();
  });

  it('survives an enrichment that throws rather than returning null', async () => {
    // Both are documented to return null on failure, but a throw escaping into the refinement would
    // take the already-ranked list with it, which is the one outcome the split exists to prevent.
    const scan = twoRoadScan();
    mockFall.mockRejectedValue(new Error('open-meteo down'));
    mockBuilt.mockRejectedValue(new Error('overpass down'));
    const before = buildMarks(scan, opts());
    const after = await enrichMarks(before, scan, opts());
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
    expect(after.every((m) => m.clean.provisional)).toBe(true);
  });
});
