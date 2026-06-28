import { describe, it, expect } from 'vitest';
import { haversine, pathLength, sinuosityScore, sharpestTurnIndices, flowCurvature, dropBacktracks, cumulativeKm, offsetPath, type LatLng } from './geometry';

describe('offsetPath', () => {
  it('returns the input unchanged for fewer than 2 points', () => {
    expect(offsetPath([], 50)).toEqual([]);
    expect(offsetPath([[42.7, -78.8]], 50)).toEqual([[42.7, -78.8]]);
  });

  it('shifts a straight east-west line consistently to one side by ~the given ground distance', () => {
    const line: LatLng[] = Array.from({ length: 10 }, (_, i) => [42.70, -78.80 + i * 0.002] as LatLng);
    const off = offsetPath(line, 50); // 50 m
    expect(off).toHaveLength(line.length);
    const expectedDeg = 50 / 111320; // latitude degrees for 50 m
    const dLats = off.map((p, i) => p[0] - line[i][0]);
    // A straight line offsets every vertex by the same latitude delta (longitude ~unchanged).
    for (let i = 0; i < off.length; i++) {
      expect(Math.abs(dLats[i])).toBeCloseTo(expectedDeg, 5);
      expect(Math.sign(dLats[i])).toBe(Math.sign(dLats[0])); // same side for all points
      expect(off[i][1]).toBeCloseTo(line[i][1], 4); // east position barely moves
    }
  });

  it('keeps the offset line about as long as the original', () => {
    const line: LatLng[] = Array.from({ length: 12 }, (_, i) => [42.70 + i * 0.001, -78.80 + i * 0.0015] as LatLng);
    const off = offsetPath(line, 40);
    expect(pathLength(off)).toBeCloseTo(pathLength(line), 1);
  });
});

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

describe('dropBacktracks', () => {
  // Helper: build a straight east-west line of `n` points spanning lon0..lon1 at fixed lat.
  const line = (lat: number, lon0: number, lon1: number, n: number): LatLng[] =>
    Array.from({ length: n }, (_, i) => [lat, +(lon0 + (lon1 - lon0) * (i / (n - 1))).toFixed(6)] as LatLng);

  it('1) preserves a 40–60 m-spaced hairpin at the SHIPPING bandM (offset limbs do not retrace)', () => {
    // A hairpin: out along one lat, U-turn, back along a parallel lat ~50 m north. The two limbs
    // are offset ~50 m everywhere. The production call (routeBuilder.ts) ships bandM: 25, which is
    // tighter than the limb offset → limbs are NOT seen as a retrace → preserved. We assert with the
    // SAME bandM the app actually runs, so this test verifies real shipping behaviour (no special-
    // cased config). rejoinM stays at its 70 default to mirror production.
    const SHIPPING_BAND_M = 25;
    const dLat = 0.00045; // ~50 m north
    const out: LatLng[] = line(42.70, -78.80, -78.78, 6);
    const back: LatLng[] = line(42.70 + dLat, -78.78, -78.80, 6);
    const hairpin = [...out, ...back];
    const result = dropBacktracks(hairpin, { rejoinM: 70, bandM: SHIPPING_BAND_M, minArcKm: 0.3 });
    expect(result.length).toBe(hairpin.length);
  });

  it('2) preserves both lobes of a figure-eight (lobes diverge, no retrace)', () => {
    // Two loops meeting at a crossing point; neither lobe retraces the other.
    const lobe = (cLat: number, cLon: number, r: number, n: number): LatLng[] =>
      Array.from({ length: n }, (_, k) => {
        const a = (k / (n - 1)) * 2 * Math.PI;
        return [cLat + r * Math.sin(a), cLon + r * (1 - Math.cos(a))] as LatLng;
      });
    const fig8 = [...lobe(42.70, -78.80, 0.01, 14), ...lobe(42.70, -78.80, -0.01, 14)];
    const result = dropBacktracks(fig8, { rejoinM: 70, minArcKm: 0.3 });
    expect(result.length).toBe(fig8.length);
  });

  it('3) collapses an end-of-ride dead-end spur on an out-and-back (Eddy regression)', () => {
    // Main line, then a spur that drives out and retraces straight back over itself to the rejoin.
    const main = line(42.70, -78.80, -78.75, 10);
    const tip: LatLng = [42.71, -78.75];
    // out to the tip and back along the SAME geometry (true retrace)
    const spurOut = [[42.705, -78.75], tip] as LatLng[];
    const spurBack = [tip, [42.705, -78.75]] as LatLng[];
    const withSpur = [...main, ...spurOut, ...spurBack, [42.70, -78.75]] as LatLng[];
    const before = withSpur.length;
    const result = dropBacktracks(withSpur, { rejoinM: 120, minArcKm: 0.2, shape: 'out-and-back' });
    expect(result.length).toBeLessThan(before); // the retracing spur collapsed
  });

  it('4) never returns < 4 points; distanceKm consistency via cumulativeKm', () => {
    const tiny: LatLng[] = [[42.70, -78.80], [42.70, -78.79], [42.70, -78.78]];
    expect(dropBacktracks(tiny).length).toBe(3); // < 4 in, returned untouched

    const main = line(42.70, -78.80, -78.75, 10);
    const tip: LatLng = [42.71, -78.75];
    const withSpur = [...main, [42.705, -78.75], tip, [42.705, -78.75], [42.70, -78.75]] as LatLng[];
    const result = dropBacktracks(withSpur, { rejoinM: 120, minArcKm: 0.2 });
    expect(result.length).toBeGreaterThanOrEqual(4);
    // pathLength of the result equals the final cumulativeKm entry (internal consistency).
    const cum = cumulativeKm(result);
    expect(cum[cum.length - 1]).toBeCloseTo(pathLength(result), 9);
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
