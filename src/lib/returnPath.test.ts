import { describe, it, expect } from 'vitest';
import { buildReturnGraph, getReturnGraph, findReturnPath } from './returnPath';
import { pathLength, haversine, type LatLng } from './geometry';
import type { ScannedRoad } from '../data/types';

/** A straight 2-endpoint way between p0 and p1 (endpoints kept exact so they hash to graph nodes). */
function way(id: string, p0: LatLng, p1: LatLng): ScannedRoad {
  const n = 6;
  const coords: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    coords.push([+(p0[0] + (p1[0] - p0[0]) * t).toFixed(5), +(p0[1] + (p1[1] - p0[1]) * t).toFixed(5)]);
  }
  // keep the exact endpoints
  coords[0] = p0;
  coords[coords.length - 1] = p1;
  return { id, name: id, curveDensity: 0, sinuosity: 0, score: 0, coords };
}

// A unit square A(top-left) B(top-right) C(bottom-right) D(bottom-left) wired AB, BC, CD, DA.
const A: LatLng = [42.70, -78.80];
const B: LatLng = [42.70, -78.76];
const C: LatLng = [42.66, -78.76];
const D: LatLng = [42.66, -78.80];
const square = () => [way('ab', A, B), way('bc', B, C), way('cd', C, D), way('da', D, A)];

describe('findReturnPath', () => {
  it('routes the long way home over the OTHER three sides when the direct way is excluded', () => {
    const graph = buildReturnGraph(square());
    // Featured ride = AB; route from B back to A avoiding the AB way → must go B→C→D→A.
    const path = findReturnPath(graph, B, A, { excludeWayIds: new Set(['ab']) });
    expect(path).not.toBeNull();
    // Oriented from B → A.
    expect(haversine(path![0], B) * 1000).toBeLessThan(20);
    expect(haversine(path![path!.length - 1], A) * 1000).toBeLessThan(20);
    // It's the 3-side detour, not the single AB side (which would be the retrace we're avoiding).
    const direct = haversine(B, A);
    expect(pathLength(path!)).toBeGreaterThan(direct * 2);
  });

  it('returns null when the only path home exceeds the length budget', () => {
    const graph = buildReturnGraph(square());
    const path = findReturnPath(graph, B, A, { excludeWayIds: new Set(['ab']), maxKm: 1 });
    expect(path).toBeNull();
  });

  it('returns null when an endpoint is not on the graph', () => {
    const graph = buildReturnGraph(square());
    const offGrid: LatLng = [10, 10];
    expect(findReturnPath(graph, offGrid, A)).toBeNull();
    expect(findReturnPath(graph, B, offGrid)).toBeNull();
  });

  it('returns null when from and to are the same node', () => {
    const graph = buildReturnGraph(square());
    expect(findReturnPath(graph, A, A)).toBeNull();
  });

  it('finds the shortest of two alternate returns', () => {
    // Add a short diagonal shortcut B→D so the cheapest A-avoiding return from B is B→D→A.
    const roads = [...square(), way('bd', B, D)];
    const graph = buildReturnGraph(roads);
    const path = findReturnPath(graph, B, A, { excludeWayIds: new Set(['ab']) });
    expect(path).not.toBeNull();
    // B→D→A is shorter than B→C→D→A, so the routed length is under the 3-side detour.
    const threeSide = haversine(B, C) + haversine(C, D) + haversine(D, A);
    expect(pathLength(path!)).toBeLessThan(threeSide);
  });
});

describe('getReturnGraph', () => {
  it('memoizes the graph per corpus array identity', () => {
    const roads = square();
    expect(getReturnGraph(roads)).toBe(getReturnGraph(roads));
    expect(getReturnGraph(square())).not.toBe(getReturnGraph(roads));
  });
});
