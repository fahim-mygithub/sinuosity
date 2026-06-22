import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  buildTellsQuery,
  categorizeFeatures,
  fetchFeatureCatalog,
  clearFeatureCache,
} from './features'
import type { OverpassElement } from './overpass'

const HOME: [number, number] = [42.9808, -78.7441]

// The feature catalog is cached per center+radius across calls; clear it so each test is fresh.
beforeEach(() => clearFeatureCache())
afterEach(() => vi.restoreAllMocks())

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => 'application/json; charset=utf-8' },
    json: async () => body,
  } as unknown as Response
}

describe('buildTellsQuery', () => {
  it('targets the scenic feature classes with radial selectors and inline geometry', () => {
    const q = buildTellsQuery(HOME, 8000)
    expect(q).toContain('tourism')
    expect(q).toContain('viewpoint')
    expect(q).toContain('around:8000,42.9808,-78.7441')
    expect(q).toContain('out geom')
    expect(q).toContain('[timeout:25]')
    // also covers water, forest, and ugly-landuse classes
    expect(q).toContain('natural')
    expect(q).toContain('landuse')
  })
})

describe('categorizeFeatures', () => {
  const elements: OverpassElement[] = [
    // viewpoint node (notable via wikidata)
    {
      type: 'node',
      id: 1,
      lat: 42.5,
      lon: -78.6,
      tags: { tourism: 'viewpoint', name: 'Big View', wikidata: 'Q123' },
    },
    // waterway (river) way with geometry
    {
      type: 'way',
      id: 2,
      tags: { waterway: 'river', name: 'Cattaraugus Creek' },
      geometry: [
        { lat: 42.51, lon: -78.61 },
        { lat: 42.52, lon: -78.62 },
        { lat: 42.53, lon: -78.63 },
      ],
    },
    // forest way with a closed ring
    {
      type: 'way',
      id: 3,
      tags: { landuse: 'forest', name: 'Zoar Woods' },
      geometry: [
        { lat: 42.55, lon: -78.7 },
        { lat: 42.56, lon: -78.7 },
        { lat: 42.56, lon: -78.69 },
        { lat: 42.55, lon: -78.69 },
        { lat: 42.55, lon: -78.7 },
      ],
    },
  ]

  it('builds the right tells arrays from a hand-built element list', () => {
    const { tells } = categorizeFeatures(elements)
    expect(tells.view.length).toBeGreaterThan(0)
    expect(tells.waterPts.length).toBeGreaterThan(0)
    expect(tells.greenAreas.length).toBeGreaterThan(0)
    expect(tells.greenPts.length).toBeGreaterThan(0)
    // the wikidata-tagged viewpoint is notable; viewMinM is NOT set by the catalog
    expect(tells.notable.length).toBeGreaterThan(0)
    expect(tells.viewMinM).toBeUndefined()
  })

  it('collects matching ScenicPOI entries with the correct kinds', () => {
    const { pois } = categorizeFeatures(elements)
    const byName = (n: string) => pois.find((p) => p.name === n)
    expect(byName('Big View')?.kind).toBe('viewpoint')
    expect(byName('Big View')?.notable).toBe(true)
    expect(byName('Cattaraugus Creek')?.kind).toBe('water')
    expect(byName('Zoar Woods')?.kind).toBe('forest')
    // river weight mirrors the tells weight (a minor watercourse, below the open-water threshold)
    expect(byName('Cattaraugus Creek')?.weight).toBeCloseTo(0.5)
  })

  it('treats a small unnamed natural=water as a negligible pond, not open water', () => {
    // A ~0.5 ha unnamed pond (subdivision retention pond) — the Heim Rd audit case. It must NOT
    // become a containment polygon and must carry a negligible weight (below the open-water bar).
    const pond: OverpassElement[] = [
      {
        type: 'way',
        id: 21,
        tags: { natural: 'water' }, // unnamed
        geometry: [
          { lat: 43.011, lon: -78.7592 }, { lat: 43.0115, lon: -78.7592 },
          { lat: 43.0115, lon: -78.7585 }, { lat: 43.011, lon: -78.7585 },
          { lat: 43.011, lon: -78.7592 },
        ],
      },
    ]
    const { tells } = categorizeFeatures(pond)
    expect(tells.waterAreas.length).toBe(0) // not a containment body
    expect(tells.waterPts.every((p) => p.w < 0.3)).toBe(true) // negligible weight
  })

  it('treats a large lake as open water (containment + full weight) even when unnamed', () => {
    // ~1 km square ≈ 100 ha — unmistakably a real lake; size alone clears the open-water bar.
    const lake: OverpassElement[] = [
      {
        type: 'way',
        id: 22,
        tags: { natural: 'water' }, // unnamed but large
        geometry: [
          { lat: 43.00, lon: -78.80 }, { lat: 43.009, lon: -78.80 },
          { lat: 43.009, lon: -78.788 }, { lat: 43.00, lon: -78.788 },
          { lat: 43.00, lon: -78.80 },
        ],
      },
    ]
    const { tells } = categorizeFeatures(lake)
    expect(tells.waterAreas.length).toBe(1)
    expect(tells.waterPts.some((p) => p.w >= 0.7)).toBe(true)
  })

  it('keeps a named natural=water as open water regardless of size', () => {
    // Same tiny footprint as the retention pond, but NAMED → a real (small) lake people care about.
    const namedPond: OverpassElement[] = [
      {
        type: 'way',
        id: 23,
        tags: { natural: 'water', name: 'Glen Pond' },
        geometry: [
          { lat: 43.011, lon: -78.7592 }, { lat: 43.0115, lon: -78.7592 },
          { lat: 43.0115, lon: -78.7585 }, { lat: 43.011, lon: -78.7585 },
          { lat: 43.011, lon: -78.7592 },
        ],
      },
    ]
    const { tells } = categorizeFeatures(namedPond)
    expect(tells.waterAreas.length).toBe(1)
    expect(tells.waterPts.some((p) => p.w >= 0.7)).toBe(true)
  })

  it('handles relations via member geometry and skips untagged/geometryless elements', () => {
    const rel: OverpassElement[] = [
      {
        type: 'relation',
        id: 9,
        tags: { natural: 'water', name: 'Lake X' },
        members: [
          { geometry: [{ lat: 42.4, lon: -78.5 }, { lat: 42.41, lon: -78.5 }, { lat: 42.41, lon: -78.49 }] },
        ],
      },
      { type: 'node', id: 10 }, // no tags, no geometry → skipped
    ]
    const { tells, pois } = categorizeFeatures(rel)
    expect(tells.waterAreas.length).toBe(1)
    expect(pois.find((p) => p.name === 'Lake X')?.kind).toBe('water')
  })
})

describe('fetchFeatureCatalog', () => {
  it('caches per center+radius — a repeat call hits the network only once', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        elements: [
          { type: 'node', id: 1, lat: 42.5, lon: -78.6, tags: { tourism: 'viewpoint', name: 'V' } },
        ],
      }),
    )
    globalThis.fetch = fetchMock

    const first = await fetchFeatureCatalog(HOME, 8)
    expect(first.tells.view.length).toBe(1)
    expect(first.pois[0].kind).toBe('viewpoint')

    const second = await fetchFeatureCatalog(HOME, 8)
    expect(second).toBe(first) // same cached object
    expect(fetchMock.mock.calls.length).toBe(1) // catalog reused from cache
  })

  it('rethrows on a fetch failure (does not swallow it)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}, false, 504))
    await expect(fetchFeatureCatalog(HOME, 8)).rejects.toThrow()
  })
})
