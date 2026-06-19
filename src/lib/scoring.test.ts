import { describe, it, expect } from 'vitest';
import { scoreRoute, scoreAndSort } from './scoring';
import type { Route, Weights } from '../data/types';

const base: Route = {
  id: 'x', name: 'X', type: 't', highlights: 'h',
  sinuosity: 5, scenery: 5, canopy: 50, waterProximity: '', community: 5,
  communityIntel: '', note: '', color: '#000', coords: [[42, -78], [42.1, -78.1]],
};
const EVEN: Weights = { sinuosity: 1, scenery: 1, community: 1 };

describe('scoreRoute', () => {
  it('computes a weighted average scaled to ~100', () => {
    // all 5s, canopy 50 (no seasonal modifier): (5+5+5)/3 * 10 = 50
    expect(scoreRoute(base, EVEN)).toBe(50);
  });

  it('respects asymmetric weights', () => {
    const r = { ...base, sinuosity: 10, scenery: 0, community: 0 };
    // weight sinuosity only -> ~100
    expect(scoreRoute(r, { sinuosity: 10, scenery: 0, community: 0 })).toBe(100);
  });

  it('caps the score at 100', () => {
    const r = { ...base, sinuosity: 10, scenery: 10, community: 10, canopy: 20 };
    expect(scoreRoute(r, EVEN)).toBe(100); // 100 + 6 seasonal, capped
  });

  it('adds the open-sky bonus when canopy < 40', () => {
    expect(scoreRoute({ ...base, canopy: 39 }, EVEN)).toBe(56); // 50 + 6
  });

  it('adds the shade bonus when canopy > 70', () => {
    expect(scoreRoute({ ...base, canopy: 71 }, EVEN)).toBe(54); // 50 + 4
  });

  it('applies NO seasonal modifier at the exact boundaries 40 and 70', () => {
    expect(scoreRoute({ ...base, canopy: 40 }, EVEN)).toBe(50);
    expect(scoreRoute({ ...base, canopy: 70 }, EVEN)).toBe(50);
  });
});

describe('scoreAndSort', () => {
  it('returns routes sorted by score descending with a score field attached', () => {
    const routes: Route[] = [
      { ...base, id: 'low', sinuosity: 2, scenery: 2, community: 2 },
      { ...base, id: 'high', sinuosity: 9, scenery: 9, community: 9 },
    ];
    const sorted = scoreAndSort(routes, EVEN);
    expect(sorted[0].id).toBe('high');
    expect(sorted[1].id).toBe('low');
    expect(sorted[0]).toHaveProperty('score');
  });
});
