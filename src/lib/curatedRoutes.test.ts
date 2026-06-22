import { describe, it, expect } from 'vitest';
import { flowCurvature, spurApexes, sinuosityScore, pathLength } from './geometry';
import { compositeScore } from './scenicScore';
import { CURATED_ROUTES } from '../data/curatedRoutes';

// The Curated slate is now built to the same standard as the Scenic slate (real road geometry,
// measured curvature, transparent composite score, Street-View-anchored stops). These invariants
// keep the generated dataset honest — they re-measure the shipped polylines with the TS metrics.
describe('shipped curated dataset invariants', () => {
  it('has routes', () => {
    expect(CURATED_ROUTES.length).toBeGreaterThan(0);
  });

  for (const r of CURATED_ROUTES) {
    describe(r.id, () => {
      it('curvature is MEASURED from the stored geometry as rideable flow (not hand-assigned)', () => {
        expect(r.rubric.curvature).toBeCloseTo(flowCurvature(r.coords), 1);
      });

      it('score is the reproducible composite of its rubric', () => {
        expect(r.score).toBe(compositeScore(r.rubric));
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

      it('has scenic stops with valid headings and copy', () => {
        expect(r.stops.length).toBeGreaterThan(0);
        for (const s of r.stops) {
          expect(Number.isFinite(s.heading)).toBe(true);
          expect(s.heading).toBeGreaterThanOrEqual(0);
          expect(s.heading).toBeLessThan(360);
          expect(s.title.length).toBeGreaterThan(0);
          expect(s.blurb.length).toBeGreaterThan(0);
        }
      });
    });
  }

  it('is sorted by score descending (best first)', () => {
    const scores = CURATED_ROUTES.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
