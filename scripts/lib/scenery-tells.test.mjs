import { describe, it, expect } from 'vitest';
import {
  sat, sampleRoute, corridorSignal, weightedSignal, measureRubric, TAU,
  pointInRing, fractionInside,
} from './scenery-tells.mjs';
import { rankScore, destinationPoint, haversineM } from './scenic-metrics.mjs';

// A short WNY-ish route polyline (lake-ish corridor along ~constant lat).
const ROUTE = [
  [42.700, -78.900], [42.700, -78.890], [42.700, -78.880],
  [42.700, -78.870], [42.700, -78.860], [42.700, -78.850],
];

describe('sat', () => {
  it('is 0 at 0, monotone increasing, bounded below 1', () => {
    expect(sat(0)).toBe(0);
    expect(sat(1)).toBeGreaterThan(sat(0.5));
    expect(sat(2)).toBeLessThan(1); // saturates toward, never exceeds, 1
    expect(sat(100)).toBeLessThanOrEqual(1);
    expect(sat(-5)).toBe(0); // clamps negatives
  });
});

describe('sampleRoute', () => {
  it('caps the point count and keeps endpoints', () => {
    const long = Array.from({ length: 500 }, (_, i) => [42 + i * 1e-4, -78]);
    const s = sampleRoute(long, 60);
    expect(s.length).toBe(60);
    expect(s[0]).toEqual(long[0]);
    expect(s[s.length - 1]).toEqual(long[long.length - 1]);
  });
});

describe('corridorSignal', () => {
  it('is zero with no tells', () => {
    expect(corridorSignal(ROUTE, [], TAU.green)).toEqual({ adj: 0, prox: 0, minM: Infinity });
  });

  it('scores a near feature higher than a far one (monotone in closeness)', () => {
    const near = corridorSignal(ROUTE, [[42.701, -78.875]], TAU.green); // ~110m off the line
    const far = corridorSignal(ROUTE, [[42.760, -78.875]], TAU.green); // ~6.6km off
    expect(near.prox).toBeGreaterThan(far.prox);
    expect(near.adj).toBeGreaterThanOrEqual(far.adj);
    expect(near.minM).toBeLessThan(far.minM);
  });

  it('adjacency fraction and proximity stay within [0,1]', () => {
    const s = corridorSignal(ROUTE, ROUTE.map((p) => [p[0] + 1e-4, p[1]]), TAU.green);
    expect(s.adj).toBeGreaterThanOrEqual(0);
    expect(s.adj).toBeLessThanOrEqual(1);
    expect(s.prox).toBeGreaterThanOrEqual(0);
    expect(s.prox).toBeLessThanOrEqual(1);
  });
});

describe('weightedSignal', () => {
  it('weights a big feature above a small one at equal distance', () => {
    const big = weightedSignal(ROUTE, [{ pt: [42.703, -78.875], w: 1.0 }], TAU.water);
    const small = weightedSignal(ROUTE, [{ pt: [42.703, -78.875], w: 0.3 }], TAU.water);
    expect(big.prox).toBeGreaterThan(small.prox);
  });
});

// A big polygon that encloses the whole ROUTE (a state-park / forest the road runs through).
const ENCLOSING = [[42.69, -78.91], [42.69, -78.84], [42.71, -78.84], [42.71, -78.91]];
// Coastline-style vertex line running ~100m north of, and parallel to, the route.
const SHORE = ROUTE.map((p) => ({ pt: [p[0] + 1e-3, p[1]], w: 1.0 }));

describe('pointInRing / fractionInside', () => {
  it('detects containment', () => {
    expect(pointInRing([42.7, -78.87], ENCLOSING)).toBe(true);
    expect(pointInRing([43.5, -78.87], ENCLOSING)).toBe(false);
  });
  it('a road through a polygon is mostly inside it', () => {
    expect(fractionInside(ROUTE, [ENCLOSING])).toBeGreaterThan(0.9);
    expect(fractionInside(ROUTE, [])).toBe(0);
  });
});

describe('measureRubric', () => {
  it('produces every field in [0,10]', () => {
    const r = measureRubric(ROUTE, {
      waterPts: SHORE, greenAreas: [ENCLOSING], view: [[42.7005, -78.87]],
    });
    for (const f of ['scenery', 'greenery', 'water', 'notability']) {
      expect(r[f]).toBeGreaterThanOrEqual(0);
      expect(r[f]).toBeLessThanOrEqual(10);
    }
  });

  it('rates a shore-hugging route wetter than a dry inland one', () => {
    const wet = measureRubric(ROUTE, { waterPts: SHORE });
    const dry = measureRubric(ROUTE, { waterPts: [{ pt: [42.9, -78.0], w: 0.3 }] });
    expect(wet.water).toBeGreaterThan(dry.water);
    expect(wet.water).toBeGreaterThan(5);
  });

  it('rates a road INSIDE a forest green even when the treeline edge is far (containment, not centroid)', () => {
    const green = measureRubric(ROUTE, { greenAreas: [ENCLOSING] });
    expect(green.greenery).toBeGreaterThan(5);
  });

  it('CONDITIONALLY fuses scenery: the same viewpoint scores lower amid ugly land-use', () => {
    const view = [[42.7005, -78.875]];
    const wild = measureRubric(ROUTE, { view, greenAreas: [ENCLOSING] });
    const urban = measureRubric(ROUTE, { view, uglyAreas: [ENCLOSING] });
    expect(wild.scenery).toBeGreaterThan(urban.scenery);
  });

  it('penalizes greenery for ugly land-use the road runs through', () => {
    const clean = measureRubric(ROUTE, { greenAreas: [ENCLOSING] });
    const blighted = measureRubric(ROUTE, { greenAreas: [ENCLOSING], uglyAreas: [ENCLOSING] });
    expect(blighted.greenery).toBeLessThan(clean.greenery);
  });

  it('lifts notability when a viewpoint sits right on the route', () => {
    const r = measureRubric(ROUTE, { view: [[42.7, -78.875]], viewMinM: 40 });
    expect(r.notability).toBeGreaterThanOrEqual(7);
  });
});

describe('rankScore (discovery)', () => {
  it('caps runaway per-km density (mall-ring guard)', () => {
    // A 3km perKm-826 mall loop must not out-rank a 60km perKm-92 real road.
    const mall = rankScore(826.9, 3.0);
    const real = rankScore(91.8, 60);
    expect(real).toBeGreaterThan(mall);
  });

  it('demotes a long mild road below a short intense one (length-bias fix)', () => {
    const longMild = rankScore(18.5, 191.5); // West Lake Rd
    const shortIntense = rankScore(120, 16); // Zoar Valley-ish, capped
    expect(shortIntense).toBeGreaterThan(longMild);
  });

  it('is 0 for degenerate input', () => {
    expect(rankScore(0, 50)).toBe(0);
    expect(rankScore(90, 0)).toBe(0);
  });
});

describe('destinationPoint', () => {
  it('lands the requested distance away (≈, for a perpendicular offset)', () => {
    const p = [42.7, -78.8];
    const east = destinationPoint(p, 90, 50);
    expect(haversineM(p, east)).toBeCloseTo(50, 0);
    expect(east[1]).toBeGreaterThan(p[1]); // east => larger lon
  });

  it('opposite bearings land on opposite sides', () => {
    const p = [42.7, -78.8];
    const left = destinationPoint(p, 0, 40);
    const right = destinationPoint(p, 180, 40);
    expect(left[0]).toBeGreaterThan(p[0]); // north
    expect(right[0]).toBeLessThan(p[0]); // south
  });
});

// -----------------------------------------------------------------------------------------------
// The grid index inside corridorSignal / weightedSignal is an INDEXING change, not an
// approximation: both signals need only the nearest (or strongest) tell per route point, so ring
// search with an exact stopping bound must reproduce the brute-force answer bit for bit. If it
// ever does not, every baked rubric in the tile corpus is silently wrong, so this is asserted
// against an independent brute-force implementation rather than against stored expectations.
// -----------------------------------------------------------------------------------------------

/** Deterministic pseudo-random generator — a fixed seed keeps a failure reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function bruteCorridor(routePts, tellPts, tauM, adjM = 260) {
  let adjCount = 0, proxSum = 0, minM = Infinity;
  for (const rp of routePts) {
    let nearest = Infinity;
    for (const tp of tellPts) {
      const d = haversineM(rp, tp);
      if (d < nearest) nearest = d;
    }
    if (nearest <= adjM) adjCount++;
    proxSum += Math.exp(-nearest / tauM);
    if (nearest < minM) minM = nearest;
  }
  return { adj: adjCount / routePts.length, prox: proxSum / routePts.length, minM };
}

function bruteWeighted(routePts, weightedTells, tauM) {
  let sum = 0, adj = 0;
  const thresh = Math.exp(-1);
  for (const rp of routePts) {
    let best = 0;
    for (const t of weightedTells) {
      const v = t.w * Math.exp(-haversineM(rp, t.pt) / tauM);
      if (v > best) best = v;
    }
    sum += best;
    if (best >= thresh) adj++;
  }
  return { prox: sum / routePts.length, adj: adj / routePts.length };
}

describe('grid-indexed signals equal brute force', () => {
  const r = rng(20260731);
  // Comfortably over GRID_MIN (512) so the indexed path is the one under test.
  const dense = Array.from({ length: 4000 }, () => [42.5 + r() * 0.5, -78.8 + r() * 0.5]);
  const weighted = dense.map((pt, i) => ({ pt, w: [0.2, 0.3, 0.5, 0.8, 0.85, 1.0][i % 6] }));
  const routes = [
    ROUTE,
    Array.from({ length: 40 }, (_, i) => [42.6 + i * 0.004, -78.7 + i * 0.003]),
    // deliberately far from every tell: exercises the sparse-grid termination guard
    Array.from({ length: 10 }, (_, i) => [41.0 + i * 0.01, -76.0]),
  ];

  it('corridorSignal matches for every tau', () => {
    for (const route of routes) {
      for (const tau of Object.values(TAU)) {
        expect(corridorSignal(route, dense, tau)).toEqual(bruteCorridor(route, dense, tau));
      }
    }
  });

  it('weightedSignal matches, including when a distant heavy feature outranks a near light one', () => {
    for (const route of routes) {
      for (const tau of Object.values(TAU)) {
        expect(weightedSignal(route, weighted, tau)).toEqual(bruteWeighted(route, weighted, tau));
      }
    }
  });

  it('matches on clustered data, where whole grid regions are empty', () => {
    // Two tight clusters far apart — the pathological case for a ring search that stops too early.
    const r2 = rng(7);
    const clustered = [
      ...Array.from({ length: 1500 }, () => [42.50 + r2() * 0.01, -78.50 + r2() * 0.01]),
      ...Array.from({ length: 1500 }, () => [42.95 + r2() * 0.01, -78.05 + r2() * 0.01]),
    ];
    const route = Array.from({ length: 30 }, (_, i) => [42.5 + i * 0.015, -78.5 + i * 0.015]);
    for (const tau of Object.values(TAU)) {
      expect(corridorSignal(route, clustered, tau)).toEqual(bruteCorridor(route, clustered, tau));
    }
  });

  it('measureRubric end-to-end is unchanged by indexing', () => {
    const r3 = rng(99);
    const tells = {
      waterPts: Array.from({ length: 3000 }, () => ({ pt: [42.5 + r3() * 0.4, -78.8 + r3() * 0.4], w: r3() })),
      waterAreas: [], greenAreas: [],
      greenPts: Array.from({ length: 2000 }, () => [42.5 + r3() * 0.4, -78.8 + r3() * 0.4]),
      uglyAreas: [],
      uglyPts: Array.from({ length: 800 }, () => [42.5 + r3() * 0.4, -78.8 + r3() * 0.4]),
      view: Array.from({ length: 600 }, () => [42.5 + r3() * 0.4, -78.8 + r3() * 0.4]),
      peak: Array.from({ length: 600 }, () => [42.5 + r3() * 0.4, -78.8 + r3() * 0.4]),
      notable: Array.from({ length: 600 }, () => ({ pt: [42.5 + r3() * 0.4, -78.8 + r3() * 0.4], w: r3() })),
    };
    const route = Array.from({ length: 50 }, (_, i) => [42.6 + i * 0.003, -78.7 + i * 0.004]);
    const got = measureRubric(route, tells);
    for (const k of ['scenery', 'greenery', 'water', 'notability']) {
      expect(Number.isFinite(got[k])).toBe(true);
      expect(got[k]).toBeGreaterThanOrEqual(0);
      expect(got[k]).toBeLessThanOrEqual(10);
    }
  });
});
