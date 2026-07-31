import { describe, it, expect } from 'vitest';
import { encodePath, decodePath, QUANT, tileIndex, tileKey, tilesForBounds, tilesForRadius, TILE_DEG, MARGIN_KM } from './tileCodec';
import { sinuosityScore, flowCurvature, pathLength, type LatLng } from './geometry';

const WNY: LatLng[] = [
  [42.500123, -78.500456],
  [42.501987, -78.502111],
  [42.503004, -78.499888],
  [42.499001, -78.495012],
];

describe('encodePath / decodePath', () => {
  it('round-trips a polyline within the quantization step', () => {
    const back = decodePath(encodePath(WNY));
    expect(back).toHaveLength(WNY.length);
    for (let i = 0; i < WNY.length; i++) {
      expect(Math.abs(back[i][0] - WNY[i][0])).toBeLessThanOrEqual(QUANT);
      expect(Math.abs(back[i][1] - WNY[i][1])).toBeLessThanOrEqual(QUANT);
    }
  });

  it('emits two integers per point, delta-encoded after the first', () => {
    const enc = encodePath(WNY);
    expect(enc).toHaveLength(WNY.length * 2);
    expect(enc.every((n) => Number.isInteger(n))).toBe(true);
    // Deltas between adjacent road vertices are tiny compared to the absolute anchor — that is the
    // whole point of the encoding (gzip cannot compress high-entropy absolute coordinate digits).
    const anchorMagnitude = Math.abs(enc[0]);
    for (let i = 2; i < enc.length; i++) expect(Math.abs(enc[i])).toBeLessThan(anchorMagnitude);
  });

  it('handles an empty path and a single point', () => {
    expect(decodePath(encodePath([]))).toEqual([]);
    const one = decodePath(encodePath([[42.5, -78.5]]));
    expect(one).toHaveLength(1);
    expect(one[0][0]).toBeCloseTo(42.5, 4);
  });

  it('survives a long path without accumulating drift', () => {
    // Delta encoding sums on decode, so a rounding bug shows up as drift that grows with length.
    const long: LatLng[] = Array.from({ length: 500 }, (_, i) => [42.5 + i * 0.0007, -78.5 - i * 0.0011]);
    const back = decodePath(encodePath(long));
    const last = back[back.length - 1];
    expect(Math.abs(last[0] - long[long.length - 1][0])).toBeLessThanOrEqual(QUANT);
    expect(Math.abs(last[1] - long[long.length - 1][1])).toBeLessThanOrEqual(QUANT);
  });
});

describe('tileIndex / tileKey', () => {
  it('floors to the grid, including across the negative-longitude boundary', () => {
    expect(tileIndex(42.5, -78.5)).toEqual([85, -157]);
    expect(tileIndex(42.99, -78.01)).toEqual([85, -157]);
    // -78.0 belongs to the NEXT tile east; a naive trunc-toward-zero would put it in -156.
    expect(tileIndex(42.5, -77.99)).toEqual([85, -156]);
    expect(tileIndex(42.5, -78.51)).toEqual([85, -158]);
  });

  it('produces a filename-safe key that distinguishes negative indices', () => {
    expect(tileKey(85, -157)).toBe('t_85_-157');
    expect(tileKey(85, 157)).toBe('t_85_157');
  });
});

describe('tilesForBounds', () => {
  it('covers a 30km-radius scan plus the way-ownership margin', () => {
    const tiles = tilesForBounds(42.6, -78.4, 30);
    expect(tiles).toContainEqual([85, -157]); // the centre tile

    // Every corner of the padded box must land in a returned tile — this is the property that
    // actually matters (a road whose midpoint sits out there must still be loadable).
    const padded = 30 + MARGIN_KM;
    const dLat = padded / 111;
    const dLon = padded / (111 * Math.cos((42.6 * Math.PI) / 180));
    for (const [la, lo] of [
      [42.6 - dLat, -78.4 - dLon], [42.6 - dLat, -78.4 + dLon],
      [42.6 + dLat, -78.4 - dLon], [42.6 + dLat, -78.4 + dLon],
    ]) {
      expect(tiles).toContainEqual(tileIndex(la, lo));
    }
  });

  it('always contains the required set, and is strictly larger where the margin crosses a boundary', () => {
    // Grid quantization means the margin often adds nothing (both boxes land in the same cells);
    // what must ALWAYS hold is containment. The second half pins a centre where it genuinely grows,
    // so a margin regressed to zero would still be caught.
    for (const [lat, lon] of [[42.75, -78.25], [42.99, -78.49], [43.01, -78.51], [44.2, -74.1]]) {
      const req = tilesForRadius(lat, lon, 30).map(([a, b]) => tileKey(a, b));
      const all = new Set(tilesForBounds(lat, lon, 30).map(([a, b]) => tileKey(a, b)));
      for (const k of req) expect(all.has(k)).toBe(true);
    }
    // At 42.70, a 30km reach ends at 42.97 (still row 85) while 30+12km reaches 43.08 (row 86),
    // so the margin must pull in an extra row here.
    expect(tilesForBounds(42.70, -78.25, 30).length).toBeGreaterThan(tilesForRadius(42.70, -78.25, 30).length);
  });

  it('stays economical — a max-radius scan loads a bounded handful of tiles', () => {
    // Regression guard: padding by a whole tile instead of MARGIN_KM made this 20 for no gain.
    // The bound tracks MARGIN_KM, which grew to 25 once a 25.9km way turned up mid-crawl.
    for (const [lat, lon] of [[42.6, -78.4], [42.75, -78.25], [44.2, -74.1], [41.4, -74.2]]) {
      expect(tilesForBounds(lat, lon, 30).length).toBeLessThanOrEqual(16);
    }
  });

  it('returns unique tiles', () => {
    const tiles = tilesForBounds(42.6, -78.4, 30);
    expect(new Set(tiles.map(([a, b]) => tileKey(a, b))).size).toBe(tiles.length);
  });

  it('grows the tile count with radius', () => {
    expect(tilesForBounds(42.6, -78.4, 30).length).toBeGreaterThan(tilesForBounds(42.6, -78.4, 5).length);
  });

  it('uses a half-degree grid', () => {
    expect(TILE_DEG).toBe(0.5);
  });
});

describe('parity with the build-time encoder (scripts/lib/tile-codec.mjs)', () => {
  // The app decodes with the TS module; scripts/build-tiles.mjs encodes with the .mjs twin. Node
  // cannot import the TS, so the two are duplicated — and a desync would ship geometry that decodes
  // to garbage while every other test stays green. This is the guard.
  it('produces byte-identical encodings and the same grid math', async () => {
    const mjs = await import('../../scripts/lib/tile-codec.mjs');

    expect(mjs.QUANT).toBe(QUANT);
    expect(mjs.TILE_DEG).toBe(TILE_DEG);
    // The builder asserts against its own MARGIN_KM; if the two drift, the build's "no way exceeds
    // 2x margin" guard stops matching the margin the client actually uses.
    expect(mjs.MARGIN_KM).toBe(MARGIN_KM);
    expect(mjs.encodePath(WNY)).toEqual(encodePath(WNY));
    expect(mjs.encodePath([])).toEqual(encodePath([]));

    const long: LatLng[] = Array.from({ length: 300 }, (_, i) => [42.5 + i * 0.0007, -78.5 - i * 0.0011]);
    expect(mjs.encodePath(long)).toEqual(encodePath(long));

    // Cross-decode: the TS decoder must read what the build-time encoder wrote, and vice versa.
    expect(decodePath(mjs.encodePath(WNY))).toEqual(mjs.decodePath(encodePath(WNY)));

    for (const [lat, lon] of [[42.5, -78.5], [42.99, -78.01], [42.5, -77.99], [-1.0, 0.25]]) {
      expect(mjs.tileIndex(lat, lon)).toEqual(tileIndex(lat, lon));
    }
    expect(mjs.tileKey(85, -157)).toBe(tileKey(85, -157));
  });
});

describe('baked curvature matches runtime curvature', () => {
  // The builder bakes curveDensity/flowCurvature with scripts/lib/scenic-metrics.mjs; the app
  // computes the same quantities with src/lib/geometry.ts on the Overpass path. If these disagree,
  // the SAME road ranks differently depending on which source served the scan — and both numbers
  // look perfectly reasonable, so nothing else catches it.
  it('agrees between scenic-metrics.mjs and geometry.ts', async () => {
    const mjs = await import('../../scripts/lib/scenic-metrics.mjs');

    const paths: LatLng[][] = [
      WNY,
      // a genuine switchback
      [[42.5, -78.5], [42.503, -78.498], [42.5015, -78.4945], [42.5045, -78.4925], [42.503, -78.489], [42.506, -78.487]],
      // a ruler-straight road: both must report ~0, not NaN
      Array.from({ length: 20 }, (_, i) => [42.5 + i * 0.001, -78.5] as LatLng),
      // a long rolling road
      Array.from({ length: 120 }, (_, i) => [42.5 + i * 0.0009, -78.5 + Math.sin(i / 4) * 0.004] as LatLng),
    ];

    for (const p of paths) {
      expect(mjs.sinuosityScore(p)).toBeCloseTo(sinuosityScore(p), 10);
      expect(mjs.flowCurvature(p)).toBeCloseTo(flowCurvature(p), 10);
      expect(mjs.pathLengthKm(p)).toBeCloseTo(pathLength(p), 10);
    }
  });
});
