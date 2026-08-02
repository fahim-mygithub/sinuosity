import { describe, it, expect } from 'vitest'
import {
  sat, sampleRoute, corridorSignal, weightedSignal, measureRubric, anyWithinM, TAU,
  pointInRing, fractionInside, nearestWithinM, waterSplit, OPEN_WATER_W, MINOR_WATER_W,
  type WeightedTell,
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

/**
 * `n` weighted tells over a tile-scan-sized extent whose `.pt` reads are COUNTED, plus the counter.
 *
 * Reading `.pt` is exactly one candidate examined: every distance evaluation in the module reads it
 * once, on the indexed branch and the brute-force branch alike (so do the brute references above),
 * while `buildGrid` reads it twice per tell — a mean-latitude pass, then a bucketing pass — and only
 * when it actually builds an index. One counter therefore separates the three things a perf test
 * here cares about: how much of the cloud a query touches, whether an index was built at all, and
 * how many times it was built.
 *
 * This is the instrument that replaced the two `performance.now()` bounds these tests used to carry
 * (`< 2000` and `< 1500`). A stopwatch is the wrong instrument twice over: it measures the machine
 * as much as the algorithm, and `.github/workflows/deploy.yml` runs `npm test` before it publishes
 * to Pages — so a flake on a loaded runner blocks a deploy, and the usual cure for a flaky perf test
 * is deletion, which loses the guard entirely. Counts are exact, identical on every machine, and
 * they fail by three to four ORDERS OF MAGNITUDE when the index goes away, where a stopwatch had to
 * resolve a few percent.
 *
 * Every figure quoted as "measured" in the two tests below was read off this file's own workload.
 * The brute-force figures come from re-running that same workload against a copy of sceneryTells.ts
 * with GRID_MIN forced to Infinity, which is how both tests were confirmed to FAIL outright with the
 * acceleration removed.
 *
 * Seeded independently of the surrounding describes so the counts cannot depend on which tests ran
 * first.
 */
function countedTells(n: number, w: number, seed: number): {
  tells: WeightedTell[]
  counter: { reads: number }
} {
  let s = seed
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  const counter = { reads: 0 }
  // 0.9 deg lat x 1.2 deg lon at lat 43 is ~100 x ~98 km, the footprint of a tile-sourced scan. At
  // n = 60000 that is ~6 tells/km2, so the nearest tell to an arbitrary point is ~200 m away — the
  // density that decides how far the ring search actually has to walk.
  const tells: WeightedTell[] = Array.from({ length: n }, () => {
    const pt: LatLng = [42.5 + rnd() * 0.9, -79.0 + rnd() * 1.2]
    return { w, get pt(): LatLng { counter.reads++; return pt } }
  })
  return { tells, counter }
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

  it('examines a bounded neighbourhood per route point, and indexes the cloud once, not per call', () => {
    // The workload that made the grid necessary, kept at full size so this is still a smoke test that
    // it completes at all: 60k tells is the water-vertex order of a tile-sourced scan (a Buffalo scan
    // carries ~255k across all families) and 8 calls is ~8 stitched rides per scan.
    const { tells: huge, counter } = countedTells(60000, 0.3, 20260731)
    const route: LatLng[] = Array.from({ length: 60 }, (_, i) => [42.8 + i * 0.002, -78.7 + i * 0.002])

    // The baseline is MEASURED, on this array and this route, in this run — so every ratio below is
    // between two counts taken from the same data, and the machine cancels out of all of them.
    counter.reads = 0
    const expected = bruteWeighted(route, huge, TAU.water)
    const brutePerCall = counter.reads
    expect(brutePerCall).toBe(route.length * huge.length) // 3,600,000 — the counter sees every pair

    counter.reads = 0
    const first = weightedSignal(route, huge, TAU.water)
    const firstCall = counter.reads

    counter.reads = 0
    for (let i = 0; i < 7; i++) weightedSignal(route, huge, TAU.water)
    const laterCalls = counter.reads

    // Bounded AND right: the equality tests above run at 4k tells, this one pins 60k.
    expect(first).toEqual(expected)

    // The ring search visits a neighbourhood, not the cloud: measured 335 candidates for a whole
    // 60-point route pass, against 3,600,000 brute force — ~10,700x fewer.
    expect(laterCalls / 7).toBeLessThan(brutePerCall / 1000)

    // The index is built once, and building it is linear: measured 120,335 on the first call = two
    // O(n) build passes (120,000) plus that same 335 of sweep. With GRID_MIN forced to Infinity this
    // is 3,600,000, i.e. 20x over the bound.
    expect(firstCall).toBeLessThan(3 * huge.length)
    // ...and no later call rebuilds it: measured 2,345 for all seven together. One rebuild alone
    // would cost 2n = 120,000, so this bound (6,016) is comfortably under a SINGLE extra build while
    // still leaving 2.6x of slack; unindexed the seven cost 25,200,000.
    expect(laterCalls).toBeLessThan(firstCall / 20)

    // The headline the old `< 2000 ms` was groping for, stated as a count: all eight indexed passes,
    // index build included, examine fewer tells than ONE brute-force pass. Measured 122,680 vs
    // 3,600,000; unindexed it is 28,800,000, so this fails by 8x with the acceleration removed.
    expect(firstCall + laterCalls).toBeLessThan(brutePerCall)
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

  it('answers each query from a bounded neighbourhood, over one index shared by all of them', () => {
    // routeBuilder asks this for EVERY vertex of every stitched ride, not a 60-point sample: 500
    // vertices x 8 rides against the ~60k water vertices a tile-sourced scan merges.
    const { tells: huge, counter } = countedTells(60000, 0.3, 31337)
    const coords: LatLng[] = Array.from({ length: 500 }, (_, i) => [42.8 + i * 0.0004, -78.7 + i * 0.0004])

    // Baseline measured in this run. Nothing is within 90 m of this vertex, so there is no short
    // circuit and one brute-force query costs exactly one distance per tell.
    counter.reads = 0
    expect(huge.some((t) => haversineM(coords[0], t.pt) <= 90)).toBe(false)
    const brutePerQuery = counter.reads
    expect(brutePerQuery).toBe(huge.length)

    counter.reads = 0
    let hits = 0
    for (let ride = 0; ride < 8; ride++) for (const c of coords) if (anyWithinM(huge, c, 90)) hits++
    const indexed = counter.reads

    // All 4000 queries, index build included, examine less than three brute-force queries' worth of
    // tells. Measured 132,216: 120,000 of it the one-off O(n) build, 12,216 of it all 4000 ring
    // searches (~3 candidates each, because maxM=90 m stops the walk inside ring 1). With GRID_MIN
    // forced to Infinity it is 224,084,488 — over the bound by 1245x, and the same number proves the
    // grid is built ONCE, since a rebuild per call alone would cost 2n x 4000 = 480,000,000.
    expect(indexed).toBeLessThan(3 * huge.length)
    // The same fact as a ratio against the measured baseline: >1000x fewer candidates than brute force.
    expect(indexed).toBeLessThan((8 * coords.length * brutePerQuery) / 1000)
    expect(hits).toBeGreaterThan(0) // the workload is not vacuously cheap because nothing ever matches

    // A search that examined nothing would also be "bounded", so anchor the counts to the answers:
    // every 25th vertex is re-asked of brute force. The sample carries 3 hits and 17 misses at this
    // seed, so agreement is not vacuous in either direction.
    let sampledHits = 0
    for (let i = 0; i < coords.length; i += 25) {
      const b = huge.some((t) => haversineM(coords[i], t.pt) <= 90)
      expect(anyWithinM(huge, coords[i], 90)).toBe(b)
      if (b) sampledHits++
    }
    expect(sampledHits).toBeGreaterThan(0)
  })
})

// -----------------------------------------------------------------------------------------------
// nearestWithinM — same exact search as anyWithinM, but it returns WHICH tell and HOW FAR, which is
// what a per-side scan needs ("a lake 280 m off your right shoulder"). Checked against the
// DEFINITION of nearest-within-range rather than against a copy of the implementation, so that the
// brute-force branch is tested by something other than itself, and swept across the GRID_MIN
// crossover, which is the one place an indexing bug can hide.
// -----------------------------------------------------------------------------------------------

describe('nearestWithinM', () => {
  let s = 90210
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  const cloud: WeightedTell[] = Array.from({ length: 3000 }, () => ({
    pt: [42.5 + rnd() * 0.4, -78.8 + rnd() * 0.4] as LatLng,
    w: [0.3, 0.5, 0.8, 1.0][Math.floor(rnd() * 4)],
  }))

  // GRID_MIN is 512 and module-private, so these straddle it explicitly: below it the brute-force
  // branch runs, at and above it the ring search does, and both must return the same tell. Sliced
  // once and reused, because a fresh array per call is exactly the cache defeat under test
  // elsewhere in this file.
  const PAIR: WeightedTell[] = cloud.slice(0, 2)
  const BELOW_GRID: WeightedTell[] = cloud.slice(0, 511)
  const AT_GRID: WeightedTell[] = cloud.slice(0, 512)
  const SUBSETS: WeightedTell[][] = [
    cloud.slice(0, 1), PAIR, BELOW_GRID, AT_GRID, cloud.slice(0, 513), cloud,
  ]

  // Inside the cloud, on its corner, and well outside it (which exercises the extent-based ring
  // termination — a bad bound reports "nothing found" there while brute force still answers).
  const QUERIES: LatLng[] = [
    [42.6, -78.6], [42.5, -78.8], [42.9, -78.4], [42.70123, -78.61987],
    [41.0, -76.0], [43.5, -79.5],
  ]
  const THRESHOLDS = [10, 120, 400, 1500, 20000, 500000]

  /**
   * The definition of "nearest tell within maxM", asserted directly: nothing may be closer, the
   * reported distance must be the tell's real distance, and null must mean the entire set is out of
   * range. These hold whatever the implementation does, so they are a real oracle for both branches.
   */
  const assertIsNearest = (
    tells: WeightedTell[], pt: LatLng, maxM: number,
    r: { tell: WeightedTell; distM: number } | null,
  ): void => {
    let min = Infinity
    for (const t of tells) { const d = haversineM(pt, t.pt); if (d < min) min = d }
    if (r === null) {
      expect(min).toBeGreaterThan(maxM)
      return
    }
    expect(tells.includes(r.tell)).toBe(true)
    expect(r.distM).toBe(haversineM(pt, r.tell.pt))
    expect(r.distM).toBeLessThanOrEqual(maxM)
    expect(r.distM).toBe(min) // same distance function on both sides, so this is bit-exact
  }

  it('returns the true nearest at every size across the GRID_MIN crossover', () => {
    for (const tells of SUBSETS) {
      for (const q of QUERIES) {
        for (const maxM of THRESHOLDS) {
          assertIsNearest(tells, q, maxM, nearestWithinM(tells, q, maxM))
        }
      }
    }
  })

  it('the indexed path returns the identical tell to the brute-force path on the same data', () => {
    // 511 vs 512 tells is the same point set plus one, so it switches branches without changing the
    // data: every query whose answer is not the added point must be unchanged. This catches an
    // index that silently drops a cell.
    const added = AT_GRID[511]
    for (const q of QUERIES) {
      for (const maxM of THRESHOLDS) {
        const brute = nearestWithinM(BELOW_GRID, q, maxM)
        const indexed = nearestWithinM(AT_GRID, q, maxM)
        if (indexed?.tell !== added) expect(indexed?.tell ?? null).toBe(brute?.tell ?? null)
      }
    }
  })

  it('answers the same yes/no question as anyWithinM', () => {
    // Two independently-bounded ring searches over the same predicate. If they ever disagree, one
    // of the two termination bounds is wrong.
    for (const tells of SUBSETS) {
      for (const q of QUERIES) {
        for (const maxM of THRESHOLDS) {
          expect(nearestWithinM(tells, q, maxM) !== null).toBe(anyWithinM(tells, q, maxM))
        }
      }
    }
  })

  it('returns the NEAREST, not merely the first tell it meets within range', () => {
    // Known geometry: at R = 6371 km, 1e-4 deg of latitude is 11.12 m. The decoys are deliberately
    // placed EARLIER in the array than the answer, so array order and search order both have to
    // lose to distance.
    const at: LatLng = [42.7, -78.9]
    const tells: WeightedTell[] = [
      { pt: [42.7 + 0.0090, -78.9], w: 1.0 }, // ~1001 m
      { pt: [42.7 + 0.0030, -78.9], w: 0.3 }, // ~334 m
      { pt: [42.7 + 0.0009, -78.9], w: 0.5 }, // ~100 m — the answer
      { pt: [42.7 + 0.0050, -78.9], w: 1.0 }, // ~556 m
    ]
    const r = nearestWithinM(tells, at, 2000)
    expect(r?.tell).toBe(tells[2])
    expect(r?.distM).toBeCloseTo(100.1, 0)

    // Shrinking maxM past the nearest tell must not fall back to a farther one.
    expect(nearestWithinM(tells, at, 50)).toBeNull()
    // ...and a maxM between the two nearest returns only the nearest.
    expect(nearestWithinM(tells, at, 200)?.tell).toBe(tells[2])
  })

  it('returns null when everything is beyond maxM, on both branches', () => {
    const q: LatLng = [45.0, -70.0] // hundreds of km from the cloud
    expect(nearestWithinM(PAIR, q, 1000)).toBeNull()
    expect(nearestWithinM(cloud, q, 1000)).toBeNull()
    // The tell exists and is findable — it is the RANGE that excludes it, not the search.
    expect(nearestWithinM(cloud, q, 1e9)).not.toBeNull()
  })

  it('returns null for an empty tell list', () => {
    expect(nearestWithinM([], [42.6, -78.6], 1000)).toBeNull()
  })
})

// -----------------------------------------------------------------------------------------------
// The grid cache is keyed on the ACCESSOR as well as the array. Two accessors over one array
// describe two different point sets, so a cache keyed on the array alone hands the second caller a
// grid built for the first caller's points — and every answer that comes back is a plausible-looking
// wrong one, which is the worst failure mode there is. Nothing in the app does this today; these
// tests exist because `nearestWithinM` made these helpers attractive to new code, so the collision
// is now one careless call away.
// -----------------------------------------------------------------------------------------------

/**
 * One element that is BOTH a bare `LatLng` (indices 0/1 — what `corridorSignal` indexes) and a
 * `WeightedTell` (`.pt` — what `nearestWithinM` indexes), with the two views ~130 km apart.
 *
 * `gridFor` is module-private, so this is the only way to drive a single array through both
 * accessors from outside — and it is exactly the shape of the mistake being guarded against: same
 * array, different point extractor, two legitimately different grids.
 */
type Hybrid = LatLng & WeightedTell
const hybrid = (self: LatLng, pt: LatLng): Hybrid =>
  Object.assign([self[0], self[1]] as LatLng, { pt, w: 1 })

// 25 x 24 = 600 elements, comfortably over the module's GRID_MIN of 512, so BOTH calls take the
// indexed path — the brute-force branches share no cache and could not collide.
const H_COLS = 25
const H_ROWS = 24
// 0.005 deg is ~556 m of latitude and ~410 m of longitude here, so a cell centre is ~345 m from
// every node of the lattice. Every threshold below is well inside that margin.
const H_STEP = 0.005
const SELF_ORIGIN: LatLng = [42.5, -78.5]
const PT_ORIGIN: LatLng = [43.5, -79.5]
const node = (o: LatLng, k: number): LatLng => [
  o[0] + (k % H_COLS) * H_STEP,
  o[1] + Math.floor(k / H_COLS) * H_STEP,
]
/** The centre of the lattice cell at (12,12) — no node is within 340 m of it. */
const cellCentre = (o: LatLng): LatLng => [o[0] + 12.5 * H_STEP, o[1] + 12.5 * H_STEP]
/** A node deep INSIDE the lattice, so a ring search over the wrong grid cannot sweep it: a query
 *  130 km away only ever reaches the boundary ring before its own bound stops it. */
const DEEP = 12 + 12 * H_COLS

const hybridLattice = (): Hybrid[] =>
  Array.from({ length: H_COLS * H_ROWS }, (_, k) => hybrid(node(SELF_ORIGIN, k), node(PT_ORIGIN, k)))

/** Nearest distance from `p` to any of `pts`, by definition. Same distance function as the module,
 *  so a correct answer matches bit-exactly. */
const bruteMin = (p: LatLng, pts: LatLng[]): number => {
  let m = Infinity
  for (const q of pts) { const d = haversineM(p, q); if (d < m) m = d }
  return m
}

describe('the grid cache distinguishes accessors over the same array', () => {
  it('answers the .pt view correctly after the bare-point view has been indexed', () => {
    const arr = hybridLattice()
    const qPt = cellCentre(PT_ORIGIN)
    // This element's `.pt` sits exactly ON the query; its own coordinates sit a degree away, deep
    // inside the other lattice. Only the right index can find it.
    arr[DEEP] = hybrid(node(SELF_ORIGIN, DEEP), qPt)

    const route: LatLng[] = [cellCentre(SELF_ORIGIN)]
    const bare = corridorSignal(route, arr as unknown as LatLng[], TAU.green)
    expect(bare.minM).toBe(bruteMin(route[0], arr.map((h) => [h[0], h[1]] as LatLng)))

    // Same array, other accessor. Exactly one element is within 100 m of qPt (the lattice nodes are
    // ~345 m off), so the answer is unambiguous: a grid keyed on the array alone answers this out of
    // the bare-point index, sweeps the wrong cells entirely, and returns null.
    const near = nearestWithinM(arr as unknown as WeightedTell[], qPt, 100)
    expect(near?.tell).toBe(arr[DEEP])
    expect(near?.distM).toBe(0)
  })

  it('answers the bare-point view correctly after the .pt view has been indexed', () => {
    // The same collision with the two accessors swapped, because either one can arrive first and a
    // cache that ignores the accessor is wrong in whichever direction it is used second.
    const arr = hybridLattice()
    const onRoute = cellCentre(SELF_ORIGIN)
    arr[DEEP] = hybrid(onRoute, node(PT_ORIGIN, DEEP))

    const qPt = cellCentre(PT_ORIGIN)
    const near = nearestWithinM(arr as unknown as WeightedTell[], qPt, 1000)
    expect(near?.distM).toBe(bruteMin(qPt, arr.map((h) => h.pt)))

    const bare = corridorSignal([onRoute], arr as unknown as LatLng[], TAU.green)
    expect(bare.minM).toBe(0) // the element sits exactly on the route point
    expect(bare.adj).toBe(1)
  })
})

// -----------------------------------------------------------------------------------------------
// The open/minor water split. `.filter()` per call returned a fresh array, and the spatial index is
// keyed on array IDENTITY, so measureRubric re-indexed every water vertex in the scan on every one
// of its ~300 calls per scan (2.10 ms stable vs 20.29 ms as written, over 66,067 points). The tests
// below pin both halves: the split is still the same partition, and it is now reference-stable.
// -----------------------------------------------------------------------------------------------

/**
 * Record every array cut out of `arr` by `.filter`, by shadowing the method on that ONE array
 * instance (the prototype is untouched, so nothing else in the process is affected).
 *
 * This is the witness for "the split happened once": splitting is a `.filter` per bucket, and it is
 * the fresh array a filter returns that defeats the identity-keyed spatial index. Counting the
 * derived arrays measures the cause directly and cannot flake, where a stopwatch measures the
 * symptom and can.
 */
function recordSplits(arr: WeightedTell[]): WeightedTell[][] {
  const derived: WeightedTell[][] = []
  Object.defineProperty(arr, 'filter', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: (pred: (t: WeightedTell, i: number, a: WeightedTell[]) => boolean): WeightedTell[] => {
      const out = Array.prototype.filter.call(arr, pred) as WeightedTell[]
      derived.push(out)
      return out
    },
  })
  return derived
}

describe('waterSplit', () => {
  // Boundary weights included on purpose: WATER_SIZE puts real features exactly on 0.3 (stream),
  // 0.5 (river), 0.8 (lake), 0.85 (canal) and 1.0 (coastline), so an off-by-one comparison here
  // silently reclassifies a whole feature class.
  const MIXED: WeightedTell[] = [
    { pt: [42.70, -78.90], w: 1.0 },
    { pt: [42.70, -78.89], w: 0.85 },
    { pt: [42.70, -78.88], w: 0.8 },
    { pt: [42.70, -78.87], w: OPEN_WATER_W },
    { pt: [42.70, -78.86], w: 0.5 },
    { pt: [42.70, -78.85], w: MINOR_WATER_W },
    { pt: [42.70, -78.84], w: 0.2 },
  ]

  it('partitions on the documented thresholds, boundaries included', () => {
    const { open, minor } = waterSplit(MIXED)
    expect(open.every((t) => t.w >= OPEN_WATER_W)).toBe(true)
    expect(minor.every((t) => t.w >= MINOR_WATER_W && t.w < OPEN_WATER_W)).toBe(true)
    expect(open).toContain(MIXED[3]) // w exactly OPEN_WATER_W counts as open water
    expect(minor).toContain(MIXED[5]) // w exactly MINOR_WATER_W counts as a minor watercourse
    // Disjoint, and nothing at or above MINOR_WATER_W is lost between the two.
    expect(open.length + minor.length).toBe(MIXED.filter((t) => t.w >= MINOR_WATER_W).length)
    expect(open).not.toContain(MIXED[6])
    expect(minor).not.toContain(MIXED[6])
  })

  it('returns REFERENCE-STABLE arrays for the same input array — this IS the fix', () => {
    const a = waterSplit(MIXED)
    const b = waterSplit(MIXED)
    expect(b).toBe(a)
    expect(b.open).toBe(a.open)
    expect(b.minor).toBe(a.minor)
  })

  it('does NOT reuse a split across arrays — identical content, different identity, own split', () => {
    // The cache must be keyed on the array, not on anything global: two scans in one session hold
    // different waterPts arrays and must not see each other's answers.
    const twin: WeightedTell[] = MIXED.map((t) => ({ ...t }))
    const a = waterSplit(MIXED)
    const b = waterSplit(twin)
    expect(b.open).not.toBe(a.open)
    expect(b.open.map((t) => t.w)).toEqual(a.open.map((t) => t.w)) // ...but the same answer
  })

  it('splits a DIFFERENT array by its own contents', () => {
    const creeksOnly: WeightedTell[] = [
      { pt: [42.7, -78.9], w: 0.3 }, { pt: [42.7, -78.8], w: 0.5 },
    ]
    const { open, minor } = waterSplit(creeksOnly)
    expect(open).toEqual([])
    expect(minor.length).toBe(2)
  })
})

describe('measureRubric water-split cache is an optimisation, not a behaviour change', () => {
  let s = 555777
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  // Weights drawn from WATER_SIZE itself so the population straddles both thresholds the way a real
  // scan's tells do.
  const WEIGHTS = [0.3, 0.5, 0.8, 0.85, 1.0, 0.2]
  const waterPts: WeightedTell[] = Array.from({ length: 1200 }, () => ({
    pt: [42.68 + rnd() * 0.06, -78.93 + rnd() * 0.1] as LatLng,
    w: WEIGHTS[Math.floor(rnd() * WEIGHTS.length)],
  }))
  const TELLS = {
    waterPts,
    waterAreas: [[[42.69, -78.91], [42.69, -78.86], [42.71, -78.86], [42.71, -78.91]] as LatLng[]],
    greenAreas: [ENCLOSING],
    greenPts: SHORE.map((t) => t.pt),
  }
  const ROUTES: LatLng[][] = [
    ROUTE,
    Array.from({ length: 40 }, (_, i) => [42.69 + i * 0.0005, -78.92 + i * 0.0012] as LatLng),
    Array.from({ length: 12 }, (_, i) => [42.80, -78.60 + i * 0.001] as LatLng), // dry, off the water
  ]

  it('scores identically to the uncached build-time twin, which still filters inline every call', () => {
    // scripts/lib/scenery-tells.mjs is literally the pre-fix code path (its measureRubric still does
    // `waterPts.filter(...)` on every call), so this is a genuine before/after comparison rather
    // than a snapshot of what the new code happens to produce.
    return import('../../scripts/lib/scenery-tells.mjs').then((mjs) => {
      for (const route of ROUTES) {
        const after = measureRubric(route, TELLS)
        const before = mjs.measureRubric(route, TELLS)
        for (const k of ['scenery', 'greenery', 'water', 'notability'] as const) {
          expect(after[k]).toBeCloseTo(before[k], 10)
        }
        for (const k of Object.keys(after.provenance)) {
          expect(after.provenance[k]).toBeCloseTo(before.provenance[k], 10)
        }
      }
    })
  })

  it('same input, same output, call after call — the cache carries no state into the answer', () => {
    for (const route of ROUTES) {
      const first = measureRubric(route, { ...TELLS, viewMinM: 500 })
      const second = measureRubric(route, { ...TELLS, viewMinM: 500 })
      const third = measureRubric(route, { ...TELLS, viewMinM: 500 })
      expect(second).toEqual(first)
      expect(third).toEqual(first)
    }
  })

  it('a copy of the tells array with the same content scores the same', () => {
    // The real call sites spread the tells OBJECT (`{ ...catalog.tells, viewMinM }`) while keeping
    // the same underlying arrays, which is what makes identity keying work. A caller that rebuilds
    // the array instead must still get the right answer — just not the fast path.
    const copy = { ...TELLS, waterPts: waterPts.map((t) => ({ ...t })) }
    expect(measureRubric(ROUTES[0], copy)).toEqual(measureRubric(ROUTES[0], TELLS))
  })

  it('measures water from the tells it was given, not from a stale cached split', () => {
    const wetPts: WeightedTell[] = SHORE.map((t) => ({ ...t }))
    const dryPts: WeightedTell[] = SHORE.map((t) => ({ pt: [t.pt[0] + 0.5, t.pt[1]] as LatLng, w: t.w }))
    const wet = measureRubric(ROUTE, { waterPts: wetPts })
    const dry = measureRubric(ROUTE, { waterPts: dryPts })
    expect(wet.water).toBeGreaterThan(dry.water)
    // And re-asking for the first one still gives the first answer.
    expect(measureRubric(ROUTE, { waterPts: wetPts })).toEqual(wet)
  })

  it('handles tells with no water at all, repeatedly (the shared empty-array fallback)', () => {
    const a = measureRubric(ROUTE, { greenAreas: [ENCLOSING] })
    const b = measureRubric(ROUTE, { greenAreas: [ENCLOSING] })
    expect(a.water).toBe(0)
    expect(b).toEqual(a)
  })

  it('splits — and therefore indexes — the water tells ONCE, not once per call', async () => {
    // The regression this whole change exists to prevent. The result is unchanged by the bug, so the
    // invariant has to be observed some other way.
    //
    // It used to be observed with a stopwatch (`perCallMs < 8`). That is the wrong instrument: a
    // wall-clock bound flakes on a loaded box, and a flaky test on a performance invariant gets
    // deleted rather than investigated — which loses the guard entirely. The bug is not "slow", it
    // is "twice per call": `.filter` over the whole water array is exactly what re-ran, and a fresh
    // array is exactly what made `gridFor` rebuild the index. So COUNT the splits. Deterministic,
    // and it fails by 50x rather than by a few percent if the caching is ever removed.
    let s2 = 8080
    const r2 = (): number => ((s2 = (s2 * 1664525 + 1013904223) >>> 0) / 4294967296)
    // Minor watercourses dominate the vertex count of an inland tile scan, and it is the grid over
    // them that was being rebuilt. Kept at full size so the test also stays a smoke test that 50
    // calls over 60k points complete at all.
    const huge: WeightedTell[] = [
      ...Array.from({ length: 60000 }, () => ({
        pt: [42.5 + r2() * 0.9, -79.0 + r2() * 1.2] as LatLng, w: 0.5,
      })),
      ...Array.from({ length: 200 }, () => ({
        pt: [44.0 + r2() * 0.1, -76.0 + r2() * 0.1] as LatLng, w: 1.0,
      })),
    ]
    const derived = recordSplits(huge)
    const route: LatLng[] = Array.from({ length: 60 }, (_, i) => [42.8 + i * 0.002, -78.7 + i * 0.002])

    for (let i = 0; i < 50; i++) measureRubric(route, { waterPts: huge, viewMinM: i })

    // Two derived arrays in total — open and minor — for all fifty calls.
    expect(derived).toHaveLength(2)
    // ...and they are the SHARED split's arrays, so the grid keyed on their identity is the one
    // every call reused.
    const { open, minor } = waterSplit(huge)
    expect(derived).toContain(open)
    expect(derived).toContain(minor)

    // Negative control, so this is a before/after measurement rather than a snapshot of what the
    // fixed code happens to do: scripts/lib/scenery-tells.mjs IS the pre-fix path — its measureRubric
    // still filters inline (scenery-tells.mjs:287-288) — and against the same instrumented array it
    // cuts two fresh arrays, and therefore two fresh grids, on every single call.
    const mjs = await import('../../scripts/lib/scenery-tells.mjs')
    const beforeFix = recordSplits(huge)
    for (let i = 0; i < 3; i++) mjs.measureRubric(route, { waterPts: huge, viewMinM: i })
    expect(beforeFix).toHaveLength(6)
  })
})
