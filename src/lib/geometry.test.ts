import { describe, it, expect } from 'vitest';
import { haversine, pathLength, sinuosityScore, sharpestTurnIndices, flowCurvature, type LatLng } from './geometry';

describe('flowCurvature', () => {
  // A straight road that makes ONE 90° turn into a side street (the intersection-corner case).
  const intersectionCorner: LatLng[] = [
    [42.70, -78.80], [42.70, -78.79], [42.70, -78.78], [42.70, -78.77], // straight east
    [42.71, -78.77], [42.72, -78.77], [42.73, -78.77], // 90° turn, then straight north
  ];
  // A road that genuinely arcs — a run of ~15° turns in the same direction (a real sweeper).
  const sweeper: LatLng[] = Array.from({ length: 12 }, (_, i) => {
    const t = i / 11; const ang = t * Math.PI * 0.5; // quarter circle
    return [42.70 + 0.03 * (1 - Math.cos(ang)), -78.80 + 0.03 * Math.sin(ang)] as LatLng;
  });
  // A straight road digitized with sub-degree lateral jitter (mapping noise, not corners).
  const jitterStraight: LatLng[] = Array.from({ length: 40 }, (_, i) =>
    [42.70 + (i % 2 === 0 ? 0 : 0.00002), -78.80 + i * 0.0009] as LatLng,
  );

  it('excludes a lone 90° intersection corner (it is not a flowing curve)', () => {
    expect(flowCurvature(intersectionCorner)).toBe(0);
    // ...whereas the raw rad/km metric DOES count the corner — that gap is the bug being fixed.
    expect(sinuosityScore(intersectionCorner)).toBeGreaterThan(flowCurvature(intersectionCorner));
    expect(sinuosityScore(intersectionCorner)).toBeGreaterThan(0.2);
  });

  it('rewards a sustained arc of moderate turns', () => {
    expect(flowCurvature(sweeper)).toBeGreaterThan(1);
  });

  it('ignores sub-4° digitization jitter on a straight road', () => {
    expect(flowCurvature(jitterStraight)).toBeLessThan(0.2);
  });

  it('returns 0 for a fragment shorter than 300 m', () => {
    expect(flowCurvature([[42.70, -78.80], [42.7005, -78.7995]])).toBe(0);
  });
});

describe('haversine', () => {
  it('returns ~0 for identical points', () => {
    expect(haversine([42.98, -78.74], [42.98, -78.74])).toBeCloseTo(0, 5);
  });

  it('computes a known distance (Buffalo to Rochester ~107 km)', () => {
    // ~107 km straight-line between Buffalo and Rochester city centers
    const d = haversine([42.8864, -78.8784], [43.1566, -77.6088]);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(115);
  });
});

describe('pathLength', () => {
  it('sums segment distances', () => {
    const coords: LatLng[] = [[42.0, -78.0], [42.1, -78.0], [42.2, -78.0]];
    expect(pathLength(coords)).toBeCloseTo(haversine(coords[0], coords[1]) * 2, 4);
  });
});

describe('sinuosityScore', () => {
  it('returns 0 for a path under 250m', () => {
    const coords: LatLng[] = [[42.0, -78.0], [42.0005, -78.0]];
    expect(sinuosityScore(coords)).toBe(0);
  });

  it('returns ~0 for a straight long road', () => {
    const coords: LatLng[] = [[42.0, -78.0], [42.1, -78.0], [42.2, -78.0], [42.3, -78.0]];
    expect(sinuosityScore(coords)).toBeLessThan(0.1);
  });

  it('returns a higher score for a zigzag than a straight line', () => {
    const straight: LatLng[] = [[42.0, -78.0], [42.1, -78.0], [42.2, -78.0]];
    const zigzag: LatLng[] = [[42.0, -78.0], [42.05, -78.05], [42.1, -78.0], [42.15, -78.05], [42.2, -78.0]];
    expect(sinuosityScore(zigzag)).toBeGreaterThan(sinuosityScore(straight));
  });

  it('scores a constant-bearing diagonal road near 0 (cos-lat correction)', () => {
    // Equal lat/lon steps => after cos(lat) scaling the bearing is constant, so
    // there is no real turning. A naive planar metric would also read ~0 here,
    // but this pins that the correction does not introduce phantom curvature.
    const diagonal: LatLng[] = [
      [42.7, -78.7], [42.72, -78.68], [42.74, -78.66], [42.76, -78.64], [42.78, -78.62],
    ];
    expect(sinuosityScore(diagonal)).toBeLessThan(0.05);
  });
});

describe('sharpestTurnIndices', () => {
  it('identifies the apex of a zigzag and preserves route order', () => {
    const zigzag: LatLng[] = [[42.0, -78.0], [42.05, -78.05], [42.1, -78.0], [42.15, -78.05], [42.2, -78.0]];
    const idxs = sharpestTurnIndices(zigzag, 2);
    expect(idxs.length).toBe(2);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b)); // ascending
    idxs.forEach((i) => { expect(i).toBeGreaterThan(0); expect(i).toBeLessThan(zigzag.length - 1); });
  });
});
