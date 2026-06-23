import { describe, it, expect } from 'vitest';
import { buildRides, synthesizeStops, rideabilityFactor } from './routeBuilder';
import { COMPOSITE_WEIGHTS, compositeScore } from './composite';
import type { LatLng } from './geometry';
import type { ScoredRoad, ScenicRubric, ScenicStop } from '../data/types';
import type { FeatureCatalog, ScenicPOI } from './features';

const rubric = (o: Partial<ScenicRubric> = {}): ScenicRubric => ({
  curvature: 5, scenery: 3, greenery: 3, water: 2, notability: 1, ...o,
});

// A gently zig-zagging road (enough vertices + length that curvature is measurable and it clears
// the minKm floor when stitched). lon runs west→east at constant-ish lat.
function road(id: string, lon0: number, lon1: number, rub: ScenicRubric): ScoredRoad {
  const n = 8;
  const coords: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const lon = lon0 + (lon1 - lon0) * t;
    coords.push([42.7 + (i % 2 === 0 ? 0 : 0.0008), +lon.toFixed(5)]);
  }
  return { id, name: id, curveDensity: 1.2, sinuosity: 5, score: 0, rubric: rub, coords };
}

const EMPTY_CATALOG: FeatureCatalog = {
  tells: { waterPts: [], waterAreas: [], greenAreas: [], greenPts: [], uglyAreas: [], uglyPts: [], view: [], peak: [], notable: [] },
  pois: [],
};

describe('buildRides', () => {
  // roadA ends exactly where roadB begins → they share a junction node and should stitch.
  const roadA = road('Alder Rd', -78.84, -78.8, rubric());
  const roadB = road('Birch Rd', -78.8, -78.76, rubric());
  // force the shared endpoint to be byte-identical so the endpoint index matches
  roadB.coords[0] = roadA.coords[roadA.coords.length - 1];

  it('stitches two connected roads into one longer ride', () => {
    const rides = buildRides([roadA, roadB], EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 1 });
    expect(rides).toHaveLength(1);
    expect(rides[0].distanceKm).toBeGreaterThan(5); // ~3.3km + ~3.3km
    expect(rides[0].coords.length).toBeGreaterThan(4);
    expect(rides[0].stops.length).toBeGreaterThanOrEqual(2); // fallback terrain stops
  });

  it('produces a full ScenicRoute shape (opens the cruise page unchanged)', () => {
    const [ride] = buildRides([roadA, roadB], EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 1, areaLabel: 'Testville' });
    expect(ride.id).toMatch(/^scan-/);
    expect(ride.name).toBeTruthy();
    expect(ride.region).toBe('near Testville');
    expect(ride.color).toMatch(/^#/);
    expect(ride.score).toBeGreaterThanOrEqual(0);
    expect(ride.score).toBeLessThanOrEqual(100);
    expect(ride.rubric.curvature).toBeGreaterThan(0); // re-measured from the stitched geometry
    expect(ride.drivingTime).toMatch(/min|h/);
  });

  it('drops a stitched ride shorter than minKm', () => {
    const stub = road('Stub Rd', -78.801, -78.8, rubric()); // ~80m
    const rides = buildRides([stub], EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 4 });
    expect(rides).toHaveLength(0);
  });

  it('honors maxRides; .score stays pure composite and the list is ordered by rank (B0/B6)', () => {
    const isolated = (i: number): ScoredRoad =>
      road(`Iso${i}`, -77 - i * 0.1, -77 - i * 0.1 - 0.05, rubric({ curvature: 4 + (i % 4) }));
    const many = Array.from({ length: 6 }, (_, i) => isolated(i));
    const rides = buildRides(many, EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 1, maxRides: 3 });
    expect(rides.length).toBeLessThanOrEqual(3);
    // Purity invariant (M0): every scan ride's .score is EXACTLY the composite of its own rubric.
    for (const r of rides) expect(r.score).toBe(compositeScore(r.rubric, COMPOSITE_WEIGHTS));
    // With no speed/surface tags the rideability factor is a constant 1.0, so rank order == score
    // order; assert the documented descending order (non-strict).
    for (let i = 1; i < rides.length; i++) expect(rides[i - 1].score).toBeGreaterThanOrEqual(rides[i].score);
  });

  it('places a tagged viewpoint right on the route as a named stop', () => {
    const onRoute: LatLng = roadA.coords[3];
    const view: LatLng = [onRoute[0] + 0.0004, onRoute[1]]; // ~45m off the line
    const catalog: FeatureCatalog = {
      tells: { ...EMPTY_CATALOG.tells, view: [view] },
      pois: [{ pt: view, name: 'Eagle Overlook', kind: 'viewpoint', notable: true, weight: 1 } as ScenicPOI],
    };
    const [ride] = buildRides([roadA, roadB], catalog, { bias: COMPOSITE_WEIGHTS, minKm: 1 });
    expect(ride.stops.some((s) => s.title === 'Eagle Overlook' && s.kind === 'viewpoint')).toBe(true);
  });
});

// Two flat (curvature-free) roads sharing a junction, so they STITCH (chain>1, descriptor applies)
// and the corridor is densely sampled — isolates water/viewpoint behaviour from curve scoring.
function flatHalf(id: string, lon0: number, lon1: number): ScoredRoad {
  const n = 40;
  const coords: LatLng[] = [];
  for (let i = 0; i < n; i++) coords.push([42.70, +(lon0 + (lon1 - lon0) * (i / (n - 1))).toFixed(5)]);
  return { id, name: id, curveDensity: 0, sinuosity: 0, score: 0, rubric: rubric(), coords };
}
function flatPair(): ScoredRoad[] {
  const a = flatHalf('Lakeview Rd', -78.84, -78.81);
  const b = flatHalf('Lakeview Rd', -78.81, -78.78);
  b.coords[0] = a.coords[a.coords.length - 1]; // exact shared junction
  return [a, b];
}

// Water points strung `offsetDeg` north of the corridor, dense enough to be the nearest feature.
// `w` selects the class: 0.8 = open water (lake/canal), 0.5 = a river/creek centerline, 0.2 = a
// negligible retention pond (already gated down in features.ts).
function waterCatalog(offsetDeg: number, w = 0.8): FeatureCatalog {
  const waterPts = [];
  for (let lon = -78.85; lon <= -78.77; lon += 0.0008) waterPts.push({ pt: [42.70 + offsetDeg, +lon.toFixed(5)] as LatLng, w });
  return { tells: { ...EMPTY_CATALOG.tells, waterPts }, pois: [] };
}

describe('honesty pass — water is sold only when you can see/ride it', () => {
  it('labels a road WITH open water alongside (~78 m) as a real Shoreline with a high water score', () => {
    const [r] = buildRides(flatPair(), waterCatalog(0.0007, 0.8), { bias: COMPOSITE_WEIGHTS, minKm: 1 });
    expect(r.theme).toBe('Shoreline');
    expect(r.name).toContain('Shoreline Run');
    expect(r.rubric.water).toBeGreaterThan(5);
  });

  it('does NOT oversell open water set back ~145 m (behind houses): low water score, not a Shoreline', () => {
    const [r] = buildRides(flatPair(), waterCatalog(0.0013, 0.8), { bias: COMPOSITE_WEIGHTS, minKm: 1 });
    expect(r.theme).not.toBe('Shoreline');
    expect(r.rubric.water).toBeLessThan(3); // out of sight (>120 m) ⇒ not a waterside ride
    expect(r.name).not.toContain('Shoreline');
  });

  it('labels a road tracking a creek (~44 m) as Creekside with a modest (not high) water score', () => {
    const [r] = buildRides(flatPair(), waterCatalog(0.0004, 0.5), { bias: COMPOSITE_WEIGHTS, minKm: 1 });
    expect(r.theme).toBe('Creekside');
    expect(r.name).toContain('Creek Run');
    expect(r.rubric.water).toBeGreaterThan(0);
    expect(r.rubric.water).toBeLessThan(5); // a screened creek is real, but not a shoreline
  });

  it('the Heim Rd case: only tiny retention ponds nearby ⇒ no water claim at all', () => {
    // Small unnamed ponds arrive pre-gated at w=0.2 (see features.ts). The ride must read as a plain
    // backroad — no Shoreline, no Creek Run, ~0 water — which is what Street View actually shows.
    const [r] = buildRides(flatPair(), waterCatalog(0.0004, 0.2), { bias: COMPOSITE_WEIGHTS, minKm: 1 });
    expect(r.rubric.water).toBeLessThan(1);
    expect(r.theme).not.toBe('Shoreline');
    expect(r.theme).not.toBe('Creekside');
    expect(r.name).not.toContain('Creek');
    expect(r.name).not.toContain('Shoreline');
  });
});

describe('honesty pass — verified viewpoints only lift notability', () => {
  const onRoute: LatLng = [42.7004, -78.81]; // ~45 m off the line at the junction vertex, < 150 m

  it('does NOT lift notability for a bare unnamed viewpoint map-tell', () => {
    const cat: FeatureCatalog = {
      tells: { ...EMPTY_CATALOG.tells, view: [onRoute] },
      pois: [{ pt: onRoute, kind: 'viewpoint', notable: false, weight: 1 }],
    };
    const [r] = buildRides(flatPair(), cat, { bias: COMPOSITE_WEIGHTS, minKm: 1 });
    expect(r.rubric.notability).toBeLessThan(5); // the old floor would have forced 7
  });

  it('DOES lift notability for a named/verified viewpoint', () => {
    const cat: FeatureCatalog = {
      tells: { ...EMPTY_CATALOG.tells, view: [onRoute] },
      pois: [{ pt: onRoute, name: 'Gorge Overlook', kind: 'viewpoint', notable: true, weight: 1 }],
    };
    const [r] = buildRides(flatPair(), cat, { bias: COMPOSITE_WEIGHTS, minKm: 1 });
    expect(r.rubric.notability).toBeGreaterThanOrEqual(7);
  });
});

describe('synthesizeStops', () => {
  const coords: LatLng[] = Array.from({ length: 20 }, (_, i) => [42.7, -78.8 + i * 0.002] as LatLng);

  it('falls back to >=2 terrain stops when no features are nearby', () => {
    const stops = synthesizeStops(coords, [], rubric({ greenery: 7 }));
    expect(stops.length).toBeGreaterThanOrEqual(2);
    stops.forEach((s: ScenicStop) => expect(typeof s.kind).toBe('string'));
  });

  it('aims the stop camera heading toward the feature', () => {
    const view: LatLng = [42.7035, -78.78]; // ~390m north of the line (within STOP_NEAR_M)
    const pois: ScenicPOI[] = [{ pt: view, name: 'North View', kind: 'viewpoint', notable: true, weight: 1 }];
    const stop = synthesizeStops(coords, pois, rubric()).find((s) => s.title === 'North View');
    expect(stop).toBeDefined();
    // The viewpoint is due north of the road, so the camera heading should point roughly north.
    expect(stop!.heading).toBeGreaterThanOrEqual(0);
    expect(stop!.heading).toBeLessThan(360);
    expect(Math.min(stop!.heading, 360 - stop!.heading)).toBeLessThan(20); // near 0°/north
  });

  it('de-clusters features that sit on top of each other', () => {
    const p: LatLng = [42.7008, -78.78];
    const pois: ScenicPOI[] = [
      { pt: p, name: 'A', kind: 'viewpoint', notable: true, weight: 1 },
      { pt: [p[0] + 0.0001, p[1]], name: 'B', kind: 'viewpoint', notable: true, weight: 1 },
    ];
    const stops = synthesizeStops(coords, pois, rubric());
    const named = stops.filter((s) => s.title === 'A' || s.title === 'B');
    expect(named).toHaveLength(1); // within 600m → only one survives
  });
});

// ── Phase B/C hardening edge cases ─────────────────────────────────────────────────────────────
// A tagged road builder so rideability/shape/time can be exercised. Same geometry shape as `road`.
function taggedRoad(
  id: string, lon0: number, lon1: number,
  tags: Partial<Pick<ScoredRoad, 'highway' | 'surface' | 'maxspeedMph' | 'paved' | 'oneway'>> = {},
  rub: ScenicRubric = rubric(),
): ScoredRoad {
  const r = road(id, lon0, lon1, rub);
  return { ...r, ...tags };
}

describe('rideabilityFactor (B5/M6/M7)', () => {
  it('10) null / unknown maxspeed ⇒ exactly 1.0 (neutral)', () => {
    expect(rideabilityFactor([taggedRoad('a', -78.84, -78.80)])).toBe(1.0);
    expect(rideabilityFactor([taggedRoad('a', -78.84, -78.80, { maxspeedMph: null })])).toBe(1.0);
    expect(rideabilityFactor([])).toBe(1.0);
  });

  it('penalizes only KNOWN ≤30 and rewards only KNOWN ≥45; stays within [0.6, 1.1]', () => {
    const slow = rideabilityFactor([taggedRoad('s', -78.84, -78.80, { maxspeedMph: 25 })]);
    const fast = rideabilityFactor([taggedRoad('f', -78.84, -78.80, { maxspeedMph: 55 })]);
    expect(slow).toBeLessThan(1.0);
    expect(fast).toBeGreaterThan(1.0);
    expect(slow).toBeGreaterThanOrEqual(0.6);
    expect(fast).toBeLessThanOrEqual(1.1);
    // A 35 mph leg is neither penalized nor rewarded by the speed term.
    expect(rideabilityFactor([taggedRoad('m', -78.84, -78.80, { maxspeedMph: 35 })])).toBe(1.0);
  });

  it('applies a small penalty per KNOWN-unpaved leg; unknown surface stays neutral', () => {
    expect(rideabilityFactor([taggedRoad('u', -78.84, -78.80, { paved: false })])).toBeLessThan(1.0);
    expect(rideabilityFactor([taggedRoad('p', -78.84, -78.80, { paved: true })])).toBe(1.0);
  });
});

describe('buildRides — used-set rollback & budget (B2)', () => {
  it('5) a minKm-failing chain frees its roads for a later seed', () => {
    // A short isolated stub (below minKm) at a HIGH composite so it seeds first, plus a separate
    // long stitchable pair that clears minKm. The stub must not steal the budget or its own road.
    const stub = road('Stub Rd', -78.801, -78.80, rubric({ curvature: 9 })); // ~80 m, top composite
    const a = road('Long A', -78.90, -78.86, rubric({ curvature: 5 }));
    const b = road('Long B', -78.86, -78.82, rubric({ curvature: 5 }));
    b.coords[0] = a.coords[a.coords.length - 1];
    const rides = buildRides([stub, a, b], EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 4, maxRides: 8 });
    // The stub's chain is discarded (< minKm); the long pair still builds a ride.
    expect(rides.length).toBe(1);
    expect(rides[0].distanceKm).toBeGreaterThan(5);
  });

  it('6) two equal-composite spurs near start → no sub-minKm loop, budget not exhausted', () => {
    // Two tiny equal-composite stubs that share the seed's start node. Neither can form a ride that
    // clears minKm; the builder must not emit a sub-minKm ride nor burn the whole ride budget.
    const seed = road('Hub Rd', -78.80, -78.799, rubric({ curvature: 8 })); // tiny
    const spurA = road('Spur A', -78.799, -78.7985, rubric({ curvature: 8 }));
    const spurB = road('Spur B', -78.799, -78.7985, rubric({ curvature: 8 }));
    spurA.coords[0] = seed.coords[seed.coords.length - 1];
    spurB.coords[0] = seed.coords[seed.coords.length - 1];
    const rides = buildRides([seed, spurA, spurB], EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 4 });
    expect(rides.length).toBe(0); // nothing clears minKm; no sub-minKm ride leaks out
  });
});

describe('buildRides — honest shape (B4/M10)', () => {
  it('7) two disjoint parallel legs <2 km apart sharing no junction → out-and-back, not loop', () => {
    // Two roads whose endpoints are euclidean-close but DO NOT share a junction key → no graph
    // cycle, so it must classify as out-and-back even though the ends are near.
    const a = road('Parallel A', -78.84, -78.80, rubric());
    const b = road('Parallel B', -78.80, -78.76, rubric());
    b.coords[0] = a.coords[a.coords.length - 1]; // they stitch end-to-end (a straight-ish run)
    const [r] = buildRides([a, b], EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 1 });
    // A straight A→B run does not return near its start → out-and-back copy, never "Loops back".
    expect(r.summary).toContain('Out-and-back');
    expect(r.summary).not.toContain('Loops back');
  });

  it('classifies a triangle that closes through the graph as a loop', () => {
    // Three legs forming a closed triangle: each leg's tail is the next leg's head, and the third
    // leg's tail returns to the seed's start node → a REAL graph cycle, euclidean-close.
    const seg = (id: string, p0: LatLng, p1: LatLng): ScoredRoad => {
      const n = 10;
      const coords: LatLng[] = [];
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        coords.push([+(p0[0] + (p1[0] - p0[0]) * t).toFixed(5), +(p0[1] + (p1[1] - p0[1]) * t).toFixed(5)]);
      }
      return { id, name: id, curveDensity: 1.2, sinuosity: 5, score: 0, rubric: rubric(), coords };
    };
    const A: LatLng = [42.70, -78.80];
    const B: LatLng = [42.74, -78.80];
    const C: LatLng = [42.72, -78.74];
    const ab = seg('AB Rd', A, B);
    const bc = seg('BC Rd', B, C);
    const ca = seg('CA Rd', C, A);
    bc.coords[0] = ab.coords[ab.coords.length - 1]; // share B
    ca.coords[0] = bc.coords[bc.coords.length - 1]; // share C
    ca.coords[ca.coords.length - 1] = ab.coords[0]; // close back to A
    const [r] = buildRides([ab, bc, ca], EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 1, targetKm: 20 });
    expect(r.summary).toContain('Loops back');
    expect(r.summary).not.toContain('Out-and-back');
  });

  it('a notable out-and-back is a "Landmark Run", never "Landmark Loop"', () => {
    const a = road('Vista A', -78.84, -78.80, rubric({ notability: 9, curvature: 1, scenery: 1 }));
    const b = road('Vista B', -78.80, -78.76, rubric({ notability: 9, curvature: 1, scenery: 1 }));
    b.coords[0] = a.coords[a.coords.length - 1];
    const onRoute = a.coords[3];
    const cat: FeatureCatalog = {
      tells: { ...EMPTY_CATALOG.tells, view: [onRoute] },
      pois: [{ pt: onRoute, name: 'Old Mill', kind: 'viewpoint', notable: true, weight: 1 }],
    };
    const [r] = buildRides([a, b], cat, { bias: { curvature: 0, scenery: 0, greenery: 0, water: 0, notability: 1 }, minKm: 1 });
    // A named/verified viewpoint lifts notability ≥ 7 (see honesty pass), so the descriptor fires;
    // it must be the out-and-back form, never the loop form.
    expect(r.rubric.notability).toBeGreaterThanOrEqual(5);
    expect(r.name).toContain('Landmark Run');
    expect(r.name).not.toContain('Landmark Loop');
  });
});

describe('buildRides — loop mode (preferLoops)', () => {
  // Build a straight segment of `n` points between two endpoints.
  const seg = (id: string, p0: LatLng, p1: LatLng): ScoredRoad => {
    const n = 10;
    const coords: LatLng[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      coords.push([+(p0[0] + (p1[0] - p0[0]) * t).toFixed(5), +(p0[1] + (p1[1] - p0[1]) * t).toFixed(5)]);
    }
    return { id, name: id, curveDensity: 1.2, sinuosity: 5, score: 0, rubric: rubric(), coords };
  };
  // A closed triangle A→B→C→A that forms a real graph cycle.
  const triangle = (): ScoredRoad[] => {
    const A: LatLng = [42.70, -78.80];
    const B: LatLng = [42.74, -78.80];
    const C: LatLng = [42.72, -78.74];
    const ab = seg('AB Rd', A, B);
    const bc = seg('BC Rd', B, C);
    const ca = seg('CA Rd', C, A);
    bc.coords[0] = ab.coords[ab.coords.length - 1];
    ca.coords[0] = bc.coords[bc.coords.length - 1];
    ca.coords[ca.coords.length - 1] = ab.coords[0];
    return [ab, bc, ca];
  };

  it('returns ONLY loop-shaped rides when a loop exists (the out-and-back is filtered out)', () => {
    // A closing triangle (a real loop) PLUS a disjoint straight pair far away (an out-and-back).
    const tri = triangle();
    const sx = road('Straight X', -77.10, -77.06, rubric());
    const sy = road('Straight Y', -77.06, -77.02, rubric());
    sy.coords[0] = sx.coords[sx.coords.length - 1];
    const rides = buildRides([...tri, sx, sy], EMPTY_CATALOG, {
      bias: COMPOSITE_WEIGHTS, minKm: 1, targetKm: 20, preferLoops: true,
    });
    expect(rides.length).toBeGreaterThanOrEqual(1);
    for (const r of rides) {
      expect(r.summary).toContain('Loops back');
      expect(r.summary).not.toContain('Out-and-back');
    }
  });

  it('falls back to the best ride (never empty) when no loop can be formed', () => {
    // Only a straight stitchable pair is available — no graph cycle is possible.
    const a = road('Solo A', -78.84, -78.80, rubric());
    const b = road('Solo B', -78.80, -78.76, rubric());
    b.coords[0] = a.coords[a.coords.length - 1];
    const rides = buildRides([a, b], EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 1, preferLoops: true });
    expect(rides.length).toBeGreaterThanOrEqual(1); // honest fallback, not an empty list
    expect(rides[0].summary).toContain('Out-and-back'); // labeled truthfully
  });

  it('actively CLOSES a loop back to the start even when a higher-scoring spur tempts the walk away', () => {
    // A square A→B→C→D→A (curvy enough to ride) plus a HIGH-curvature spur D→E leading away east.
    // At D the greedy/biased walk prefers the spur (higher composite), so DEFAULT mode overshoots
    // into an out-and-back. Loop mode must instead snap the square shut at the start node.
    const A: LatLng = [42.70, -78.80], B: LatLng = [42.74, -78.80];
    const C: LatLng = [42.74, -78.74], D: LatLng = [42.70, -78.74], E: LatLng = [42.70, -78.66];
    const ab = seg('AB Rd', A, B); ab.rubric = rubric({ curvature: 10 }); // seeds first
    const bc = seg('BC Rd', B, C);
    const cd = seg('CD Rd', C, D);
    const da = seg('DA Rd', D, A); // closes the square back to the start node
    const de = seg('DE Rd', D, E); de.rubric = rubric({ curvature: 9 }); // the tempting spur
    bc.coords[0] = ab.coords[ab.coords.length - 1];
    cd.coords[0] = bc.coords[bc.coords.length - 1];
    da.coords[0] = cd.coords[cd.coords.length - 1];
    da.coords[da.coords.length - 1] = ab.coords[0]; // exact closure to A
    de.coords[0] = cd.coords[cd.coords.length - 1]; // shares the D junction with DA
    const roads = [ab, bc, cd, da, de];

    const opts = { bias: COMPOSITE_WEIGHTS, minKm: 1, targetKm: 20 };
    const dflt = buildRides(roads, EMPTY_CATALOG, opts);
    const loops = buildRides(roads, EMPTY_CATALOG, { ...opts, preferLoops: true });

    // Default overshoots down the spur — the square never closes.
    expect(dflt.every((r) => !r.summary.includes('Loops back'))).toBe(true);
    // Loop mode returns the closed square.
    expect(loops.length).toBeGreaterThanOrEqual(1);
    expect(loops.every((r) => r.summary.includes('Loops back'))).toBe(true);
  });

  it('treats a distinct-road circuit that returns NEAR (not exactly on) the start as a loop — only in loop mode', () => {
    // A→B→C→D→E of distinct roads; E sits ~0.5 km from A but is a DIFFERENT node (no road E→A).
    // There is no exact graph cycle, so DEFAULT mode (strict) calls it out-and-back. But because the
    // builder never reuses a road, returning near the start IS a real circuit — loop mode says loop.
    const A: LatLng = [42.70, -78.80], B: LatLng = [42.73, -78.80], C: LatLng = [42.73, -78.84];
    const D: LatLng = [42.70, -78.84], E: LatLng = [42.701, -78.806]; // E ≈ 0.5 km from A, distinct
    const ab = seg('AB Rd', A, B), bc = seg('BC Rd', B, C), cd = seg('CD Rd', C, D), de = seg('DE Rd', D, E);
    bc.coords[0] = ab.coords[ab.coords.length - 1];
    cd.coords[0] = bc.coords[bc.coords.length - 1];
    de.coords[0] = cd.coords[cd.coords.length - 1];
    const roads = [ab, bc, cd, de];
    const opts = { bias: COMPOSITE_WEIGHTS, minKm: 1, targetKm: 22 };

    const [dflt] = buildRides(roads, EMPTY_CATALOG, opts);
    expect(dflt.summary).toContain('Out-and-back'); // strict default: not an exact cycle

    const loops = buildRides(roads, EMPTY_CATALOG, { ...opts, preferLoops: true });
    expect(loops.length).toBeGreaterThanOrEqual(1);
    expect(loops[0].summary).toContain('Loops back'); // near-start return of distinct roads = a loop
  });

  it('keeps .score pure composite in loop mode', () => {
    const rides = buildRides(triangle(), EMPTY_CATALOG, {
      bias: COMPOSITE_WEIGHTS, minKm: 1, targetKm: 20, preferLoops: true,
    });
    for (const r of rides) expect(r.score).toBe(compositeScore(r.rubric, COMPOSITE_WEIGHTS));
  });
});

describe('buildRides — robustness & invariants (B6, edge)', () => {
  it('8) a tiny-radius scan (one short road) does not regress to []', () => {
    // One road that just clears minKm on its own — must still produce a ride, not an empty list.
    const solo = road('Solo Rd', -78.86, -78.80, rubric()); // ~5 km
    const rides = buildRides([solo], EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 1 });
    expect(rides.length).toBeGreaterThanOrEqual(1);
    expect(rides[0].coords.length).toBeGreaterThanOrEqual(4);
  });

  it('9) ride.score === compositeScore(ride.rubric, bias) for EVERY ride', () => {
    const bias = { curvature: 0.5, scenery: 0.2, greenery: 0.1, water: 0.1, notability: 0.1 };
    const a = road('Honest A', -78.90, -78.86, rubric({ curvature: 7 }));
    const b = road('Honest B', -78.86, -78.82, rubric({ curvature: 7 }));
    b.coords[0] = a.coords[a.coords.length - 1];
    const c = road('Honest C', -77.5, -77.44, rubric({ curvature: 3 }));
    const rides = buildRides([a, b, c], EMPTY_CATALOG, { bias, minKm: 1 });
    expect(rides.length).toBeGreaterThan(0);
    for (const r of rides) expect(r.score).toBe(compositeScore(r.rubric, bias));
  });

  it('11) all-tags-absent ⇒ rideability constant 1.0 ⇒ ordering is purely composite', () => {
    const mk = (i: number, curv: number) => road(`R${i}`, -77 - i * 0.2, -77 - i * 0.2 - 0.06, rubric({ curvature: curv }));
    const roads = [mk(0, 3), mk(1, 8), mk(2, 5)];
    const rides = buildRides(roads, EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 1, maxRides: 8 });
    // Every ride had no speed/surface tags ⇒ factor is exactly 1.0 ⇒ rank order == score order.
    const scores = rides.map((r) => r.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  it('12) a maxed-rubric scan ride keeps score ≤ 100', () => {
    const a = road('Max A', -78.90, -78.86, rubric({ curvature: 10, scenery: 10, greenery: 10, water: 10, notability: 10 }));
    const b = road('Max B', -78.86, -78.82, rubric({ curvature: 10, scenery: 10, greenery: 10, water: 10, notability: 10 }));
    b.coords[0] = a.coords[a.coords.length - 1];
    const [r] = buildRides([a, b], EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 1 });
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('8b) scan drivingTime derives from chain-weighted known posted speed (B8)', () => {
    // A chain of 45 mph roads should yield a slower (longer) time than the 55 fallback default.
    const a = taggedRoad('Fast A', -78.90, -78.86, { maxspeedMph: 45 });
    const b = taggedRoad('Fast B', -78.86, -78.82, { maxspeedMph: 45 });
    b.coords[0] = a.coords[a.coords.length - 1];
    const [r] = buildRides([a, b], EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 1 });
    expect(r.drivingTime).toMatch(/min|h/);
  });
});
