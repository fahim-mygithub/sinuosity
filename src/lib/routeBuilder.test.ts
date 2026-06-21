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
