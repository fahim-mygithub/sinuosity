import { describe, it, expect } from 'vitest';
import { cleanCoords, curvature10, spurApexes, sinuosityScore, pathLength, type LatLng } from './geometry';
import { compositeScore } from './scenicScore';
import { SCENIC_ROUTES } from '../data/scenicRoutes';

describe('cleanCoords', () => {
  it('drops near-duplicate consecutive points', () => {
    const pts: LatLng[] = [
      [42.0, -78.0],
      [42.0, -78.0], // exact dup
      [42.0, -78.01],
    ];
    expect(cleanCoords(pts)).toHaveLength(2);
  });

  it('collapses an out-and-back spur to a single pass-through', () => {
    const withSpur: LatLng[] = [
      [42.0, -78.0],
      [42.0, -78.01],
      [42.0, -78.02], // junction J
      [42.003, -78.02], // out
      [42.006, -78.02], // apex (U-turn)
      [42.003, -78.02], // retrace back
      [42.0, -78.02], // back to J
      [42.0, -78.03],
      [42.0, -78.04],
    ];
    const cleaned = cleanCoords(withSpur);
    expect(spurApexes(withSpur).length).toBeGreaterThan(0); // the artifact existed
    expect(spurApexes(cleaned)).toEqual([]); // and is gone
    expect(cleaned.length).toBeLessThan(withSpur.length);
    // the through-line W of the junction survives
    expect(cleaned[cleaned.length - 1]).toEqual([42.0, -78.04]);
  });

  it('preserves a switchback whose legs do not retrace', () => {
    // two ~50m-offset parallel legs joined by a turn — a real twisty, not a dead-end
    const switchback: LatLng[] = [
      [42.0, -78.0],
      [42.01, -78.0],
      [42.02, -78.0],
      [42.02, -78.0006],
      [42.01, -78.0006],
      [42.0, -78.0006],
    ];
    expect(cleanCoords(switchback)).toHaveLength(switchback.length);
  });
});

describe('curvature10', () => {
  it('scores a straight line 0', () => {
    const straight: LatLng[] = [
      [42.0, -78.0],
      [42.0, -78.01],
      [42.0, -78.02],
      [42.0, -78.03],
    ];
    expect(curvature10(straight)).toBe(0);
  });

  it('scores a twisty line higher than a gentle one', () => {
    const gentle: LatLng[] = [
      [42.0, -78.0],
      [42.001, -78.01],
      [42.0, -78.02],
      [42.001, -78.03],
    ];
    const twisty: LatLng[] = [
      [42.0, -78.0],
      [42.01, -78.004],
      [42.0, -78.008],
      [42.01, -78.012],
      [42.0, -78.016],
    ];
    expect(curvature10(twisty)).toBeGreaterThan(curvature10(gentle));
    expect(curvature10(twisty)).toBeLessThanOrEqual(10);
  });
});

describe('compositeScore', () => {
  it('is a weighted 0-100 composite of the rubric', () => {
    expect(compositeScore({ curvature: 10, scenery: 10, greenery: 10, water: 10, notability: 10 })).toBe(100);
    expect(compositeScore({ curvature: 0, scenery: 0, greenery: 0, water: 0, notability: 0 })).toBe(0);
    // curvature carries 35% weight
    expect(compositeScore({ curvature: 10, scenery: 0, greenery: 0, water: 0, notability: 0 })).toBe(35);
  });
});

describe('shipped scenic dataset invariants', () => {
  it('has routes', () => {
    expect(SCENIC_ROUTES.length).toBeGreaterThan(0);
  });

  for (const r of SCENIC_ROUTES) {
    describe(r.id, () => {
      it('curvature is MEASURED from the stored geometry (not hand-assigned)', () => {
        expect(r.rubric.curvature).toBeCloseTo(curvature10(r.coords), 1);
      });

      it('score is the reproducible composite of its rubric', () => {
        expect(r.score).toBe(compositeScore(r.rubric));
      });

      it('has no stop left at the schema-default heading 0', () => {
        for (const s of r.stops) expect(s.heading).not.toBe(0);
      });

      it('has no out-and-back spur in its polyline', () => {
        expect(spurApexes(r.coords)).toEqual([]);
      });

      it('distanceKm matches the drawn geometry', () => {
        expect(r.distanceKm).toBeCloseTo(pathLength(r.coords), 0);
      });

      it('curvature stays on the 0-10 scale', () => {
        expect(sinuosityScore(r.coords)).toBeGreaterThanOrEqual(0);
        expect(r.rubric.curvature).toBeGreaterThanOrEqual(0);
        expect(r.rubric.curvature).toBeLessThanOrEqual(10);
      });
    });
  }

  it('is sorted by score descending (twistiest/best first)', () => {
    const scores = SCENIC_ROUTES.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
