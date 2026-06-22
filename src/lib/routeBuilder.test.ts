import { describe, it, expect } from 'vitest';
import { buildRides, synthesizeStops } from './routeBuilder';
import { COMPOSITE_WEIGHTS } from './composite';
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

  it('honors maxRides and returns rides sorted by score descending', () => {
    const isolated = (i: number): ScoredRoad =>
      road(`Iso${i}`, -77 - i * 0.1, -77 - i * 0.1 - 0.05, rubric({ curvature: 4 + (i % 4) }));
    const many = Array.from({ length: 6 }, (_, i) => isolated(i));
    const rides = buildRides(many, EMPTY_CATALOG, { bias: COMPOSITE_WEIGHTS, minKm: 1, maxRides: 3 });
    expect(rides.length).toBeLessThanOrEqual(3);
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
