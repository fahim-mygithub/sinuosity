import { describe, it, expect } from 'vitest'
import {
  sat, sampleRoute, corridorSignal, weightedSignal, measureRubric, anyWithinM, TAU,
  pointInRing, fractionInside,
} from './sceneryTells'
import { haversine, type LatLng } from './geometry'

/** Metres between two points — the unit corridorSignal/weightedSignal work in. */
const haversineM = (a: LatLng, b: LatLng): number => haversine(a, b) * 1000

// A short WNY-ish route polyline (lake-ish corridor along ~constant lat).
const ROUTE: LatLng[] = [
  [42.700, -78.900], [42.700, -78.890], [42.700, -78.880],
  [42.700, -78.870], [42.700, -78.860], [42.700, -78.850],
]

describe('sat', () => {
  it('is 0 at 0, monotone increasing, bounded below 1', () => {
    expect(sat(0)).toBe(0)
    expect(sat(1)).toBeGreaterThan(sat(0.5))
    expect(sat(2)).toBeLessThan(1) // saturates toward, never exceeds, 1
    expect(sat(100)).toBeLessThanOrEqual(1)
    expect(sat(-5)).toBe(0) // clamps negatives
  })
})

describe('sampleRoute', () => {
  it('caps the point count and keeps endpoints', () => {
    const long: LatLng[] = Array.from({ length: 500 }, (_, i) => [42 + i * 1e-4, -78])
    const s = sampleRoute(long, 60)
    expect(s.length).toBe(60)
    expect(s[0]).toEqual(long[0])
    expect(s[s.length - 1]).toEqual(long[long.length - 1])
  })
})

describe('corridorSignal', () => {
  it('is zero with no tells', () => {
    expect(corridorSignal(ROUTE, [], TAU.green)).toEqual({ adj: 0, prox: 0, minM: Infinity })
  })

  it('scores a near feature higher than a far one (monotone in closeness)', () => {
    const near = corridorSignal(ROUTE, [[42.701, -78.875]], TAU.green) // ~110m off the line
    const far = corridorSignal(ROUTE, [[42.760, -78.875]], TAU.green) // ~6.6km off
    expect(near.prox).toBeGreaterThan(far.prox)
    expect(near.adj).toBeGreaterThanOrEqual(far.adj)
    expect(near.minM).toBeLessThan(far.minM)
  })

  it('adjacency fraction and proximity stay within [0,1]', () => {
    const s = corridorSignal(ROUTE, ROUTE.map((p) => [p[0] + 1e-4, p[1]] as LatLng), TAU.green)
    expect(s.adj).toBeGreaterThanOrEqual(0)
    expect(s.adj).toBeLessThanOrEqual(1)
    expect(s.prox).toBeGreaterThanOrEqual(0)
    expect(s.prox).toBeLessThanOrEqual(1)
  })
})

describe('weightedSignal', () => {
  it('weights a big feature above a small one at equal distance', () => {
    const big = weightedSignal(ROUTE, [{ pt: [42.703, -78.875], w: 1.0 }], TAU.water)
    const small = weightedSignal(ROUTE, [{ pt: [42.703, -78.875], w: 0.3 }], TAU.water)
    expect(big.prox).toBeGreaterThan(small.prox)
  })
})

// A big polygon that encloses the whole ROUTE (a state-park / forest the road runs through).
const ENCLOSING: LatLng[] = [[42.69, -78.91], [42.69, -78.84], [42.71, -78.84], [42.71, -78.91]]
// Coastline-style vertex line running ~100m north of, and parallel to, the route.
const SHORE = ROUTE.map((p) => ({ pt: [p[0] + 1e-3, p[1]] as LatLng, w: 1.0 }))

describe('pointInRing / fractionInside', () => {
  it('detects containment', () => {
    expect(pointInRing([42.7, -78.87], ENCLOSING)).toBe(true)
    expect(pointInRing([43.5, -78.87], ENCLOSING)).toBe(false)
  })
  it('a road through a polygon is mostly inside it', () => {
    expect(fractionInside(ROUTE, [ENCLOSING])).toBeGreaterThan(0.9)
    expect(fractionInside(ROUTE, [])).toBe(0)
  })
})

describe('measureRubric', () => {
  it('produces every field in [0,10]', () => {
    const r = measureRubric(ROUTE, {
      waterPts: SHORE, greenAreas: [ENCLOSING], view: [[42.7005, -78.87]],
    })
    for (const f of ['scenery', 'greenery', 'water', 'notability'] as const) {
      expect(r[f]).toBeGreaterThanOrEqual(0)
      expect(r[f]).toBeLessThanOrEqual(10)
    }
  })

  it('rates a shore-hugging route wetter than a dry inland one', () => {
    const wet = measureRubric(ROUTE, { waterPts: SHORE })
    const dry = measureRubric(ROUTE, { waterPts: [{ pt: [42.9, -78.0], w: 0.3 }] })
    expect(wet.water).toBeGreaterThan(dry.water)
    expect(wet.water).toBeGreaterThan(5)
  })

  it('rates a road INSIDE a forest green even when the treeline edge is far (containment, not centroid)', () => {
    const green = measureRubric(ROUTE, { greenAreas: [ENCLOSING] })
    expect(green.greenery).toBeGreaterThan(5)
  })

  it('CONDITIONALLY fuses scenery: the same viewpoint scores lower amid ugly land-use', () => {
    const view: LatLng[] = [[42.7005, -78.875]]
    const wild = measureRubric(ROUTE, { view, greenAreas: [ENCLOSING] })
    const urban = measureRubric(ROUTE, { view, uglyAreas: [ENCLOSING] })
    expect(wild.scenery).toBeGreaterThan(urban.scenery)
  })

  it('penalizes greenery for ugly land-use the road runs through', () => {
    const clean = measureRubric(ROUTE, { greenAreas: [ENCLOSING] })
    const blighted = measureRubric(ROUTE, { greenAreas: [ENCLOSING], uglyAreas: [ENCLOSING] })
    expect(blighted.greenery).toBeLessThan(clean.greenery)
  })

  it('lifts notability when a viewpoint sits right on the route', () => {
    const r = measureRubric(ROUTE, { view: [[42.7, -78.875]], viewMinM: 40 })
    expect(r.notability).toBeGreaterThanOrEqual(7)
  })
})

describe('parity with the build-time scenery lib (scripts/lib/scenery-tells.mjs)', () => {
  // The tile corpus bakes each road's rubric with the .mjs twin; the app re-measures the STITCHED
  // ride polyline at runtime with this TS module (routeBuilder.ts). If the two disagree, a ride's
  // headline rubric contradicts the rubrics of the roads it is made of — and both look plausible.
  // The .mjs was given a grid index for build speed; this proves the index did not move results.
  it('measures the same rubric as the runtime implementation', async () => {
    const mjs = await import('../../scripts/lib/scenery-tells.mjs')

    let seed = 4242
    const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)

    // Big enough that the .mjs takes its indexed path (GRID_MIN is 512) while the .ts stays brute
    // force — which is exactly the comparison that matters.
    const tells = {
      waterPts: Array.from({ length: 2500 }, () => ({ pt: [42.5 + rnd() * 0.4, -78.8 + rnd() * 0.4] as LatLng, w: [0.3, 0.5, 0.8, 1.0][Math.floor(rnd() * 4)] })),
      waterAreas: [[[42.60, -78.70], [42.64, -78.70], [42.64, -78.66], [42.60, -78.66]] as LatLng[]],
      greenAreas: [[[42.55, -78.75], [42.62, -78.75], [42.62, -78.68], [42.55, -78.68]] as LatLng[]],
      greenPts: Array.from({ length: 1500 }, () => [42.5 + rnd() * 0.4, -78.8 + rnd() * 0.4] as LatLng),
      uglyAreas: [[[42.70, -78.50], [42.72, -78.50], [42.72, -78.48]] as LatLng[]],
      uglyPts: Array.from({ length: 900 }, () => [42.5 + rnd() * 0.4, -78.8 + rnd() * 0.4] as LatLng),
      view: Array.from({ length: 700 }, () => [42.5 + rnd() * 0.4, -78.8 + rnd() * 0.4] as LatLng),
      peak: Array.from({ length: 700 }, () => [42.5 + rnd() * 0.4, -78.8 + rnd() * 0.4] as LatLng),
      notable: Array.from({ length: 700 }, () => ({ pt: [42.5 + rnd() * 0.4, -78.8 + rnd() * 0.4] as LatLng, w: rnd() })),
    }

    const routes: LatLng[][] = [
      ROUTE,
      Array.from({ length: 60 }, (_, i) => [42.56 + i * 0.0012, -78.74 + i * 0.0011] as LatLng),
      Array.from({ length: 25 }, (_, i) => [42.61 + i * 0.0008, -78.69] as LatLng),
    ]

    for (const route of routes) {
      const a = measureRubric(route, tells)
      const b = mjs.measureRubric(route, tells)
      for (const k of ['scenery', 'greenery', 'water', 'notability'] as const) {
        expect(b[k]).toBeCloseTo(a[k], 10)
      }
    }
  })
})

// -----------------------------------------------------------------------------------------------
// The grid index inside corridorSignal / weightedSignal is an INDEXING change, not an
// approximation. Proven against an independent brute-force implementation rather than against
// stored expectations, because if it ever diverges every scenery score in the app is quietly wrong.
// -----------------------------------------------------------------------------------------------

function bruteCorridor(routePts: LatLng[], tellPts: LatLng[], tauM: number, adjM = 260) {
  let adjCount = 0, proxSum = 0, minM = Infinity
  for (const rp of routePts) {
    let nearest = Infinity
    for (const tp of tellPts) {
      const d = haversineM(rp, tp)
      if (d < nearest) nearest = d
    }
    if (nearest <= adjM) adjCount++
    proxSum += Math.exp(-nearest / tauM)
    if (nearest < minM) minM = nearest
  }
  return { adj: adjCount / routePts.length, prox: proxSum / routePts.length, minM }
}

function bruteWeighted(routePts: LatLng[], tells: { pt: LatLng; w: number }[], tauM: number) {
  let sum = 0, adj = 0
  const thresh = Math.exp(-1)
  for (const rp of routePts) {
    let best = 0
    for (const t of tells) {
      const v = t.w * Math.exp(-haversineM(rp, t.pt) / tauM)
      if (v > best) best = v
    }
    sum += best
    if (best >= thresh) adj++
  }
  return { prox: sum / routePts.length, adj: adj / routePts.length }
}

describe('grid-indexed signals equal brute force', () => {
  let seed = 20260731
  const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  // Well over GRID_MIN (512) so the indexed path is the one under test.
  const dense: LatLng[] = Array.from({ length: 4000 }, () => [42.5 + rnd() * 0.5, -78.8 + rnd() * 0.5])
  const weighted = dense.map((pt, i) => ({ pt, w: [0.2, 0.3, 0.5, 0.8, 0.85, 1.0][i % 6] }))
  const routes: LatLng[][] = [
    ROUTE,
    Array.from({ length: 40 }, (_, i) => [42.6 + i * 0.004, -78.7 + i * 0.003] as LatLng),
    // deliberately far from every tell — exercises the extent-based termination
    Array.from({ length: 10 }, (_, i) => [41.0 + i * 0.01, -76.0] as LatLng),
  ]

  it('corridorSignal matches for every tau', () => {
    for (const route of routes) {
      for (const tau of Object.values(TAU)) {
        expect(corridorSignal(route, dense, tau)).toEqual(bruteCorridor(route, dense, tau))
      }
    }
  })

  it('weightedSignal matches, including when a distant heavy feature outranks a near light one', () => {
    for (const route of routes) {
      for (const tau of Object.values(TAU)) {
        expect(weightedSignal(route, weighted, tau)).toEqual(bruteWeighted(route, weighted, tau))
      }
    }
  })

  it('matches on clustered data, where whole grid regions are empty', () => {
    let s2 = 7
    const r2 = (): number => ((s2 = (s2 * 1664525 + 1013904223) >>> 0) / 4294967296)
    const clustered: LatLng[] = [
      ...Array.from({ length: 1500 }, () => [42.50 + r2() * 0.01, -78.50 + r2() * 0.01] as LatLng),
      ...Array.from({ length: 1500 }, () => [42.95 + r2() * 0.01, -78.05 + r2() * 0.01] as LatLng),
    ]
    const route: LatLng[] = Array.from({ length: 30 }, (_, i) => [42.5 + i * 0.015, -78.5 + i * 0.015])
    for (const tau of Object.values(TAU)) {
      expect(corridorSignal(route, clustered, tau)).toEqual(bruteCorridor(route, clustered, tau))
    }
  })

  it('is fast enough for a tile-sourced scan (255k water points, freezes the page brute-force)', () => {
    const huge = Array.from({ length: 60000 }, () => ({
      pt: [42.5 + rnd() * 0.9, -79.0 + rnd() * 1.2] as LatLng,
      w: 0.3,
    }))
    const route: LatLng[] = Array.from({ length: 60 }, (_, i) => [42.8 + i * 0.002, -78.7 + i * 0.002])
    const t0 = performance.now()
    for (let i = 0; i < 8; i++) weightedSignal(route, huge, TAU.water) // ~8 stitched rides per scan
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})

describe('anyWithinM', () => {
  let s = 31337
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  const dense = Array.from({ length: 3000 }, () => ({
    pt: [42.5 + rnd() * 0.4, -78.8 + rnd() * 0.4] as LatLng, w: 0.5,
  }))

  const brute = (pt: LatLng, maxM: number): boolean =>
    dense.some((t) => haversineM(pt, t.pt) <= maxM)

  it('matches brute force across thresholds and query positions', () => {
    // Includes points inside the cloud, on its edge, and far outside it.
    const queries: LatLng[] = [
      [42.6, -78.6], [42.5, -78.8], [42.9, -78.4], [42.70123, -78.61987],
      [41.0, -76.0], [43.5, -79.5],
    ]
    for (const q of queries) {
      for (const maxM of [10, 70, 90, 250, 500, 1500, 50000]) {
        expect(anyWithinM(dense, q, maxM)).toBe(brute(q, maxM))
      }
    }
  })

  it('agrees with brute force on the small-array path too', () => {
    const few = dense.slice(0, 20)
    const bruteFew = (pt: LatLng, m: number): boolean => few.some((t) => haversineM(pt, t.pt) <= m)
    for (const maxM of [50, 500, 5000, 100000]) {
      expect(anyWithinM(few, [42.6, -78.6], maxM)).toBe(bruteFew([42.6, -78.6], maxM))
    }
  })

  it('returns false for an empty tell list', () => {
    expect(anyWithinM([], [42.6, -78.6], 1000)).toBe(false)
  })

  it('is fast enough for full-polyline use across many rides', () => {
    // routeBuilder asks this for EVERY vertex of every stitched ride, not a 60-point sample.
    const huge = Array.from({ length: 60000 }, () => ({
      pt: [42.5 + rnd() * 0.9, -79.0 + rnd() * 1.2] as LatLng, w: 0.3,
    }))
    const coords: LatLng[] = Array.from({ length: 500 }, (_, i) => [42.8 + i * 0.0004, -78.7 + i * 0.0004])
    const t0 = performance.now()
    for (let ride = 0; ride < 8; ride++) for (const c of coords) anyWithinM(huge, c, 90)
    expect(performance.now() - t0).toBeLessThan(1500)
  })
})
