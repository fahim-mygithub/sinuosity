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
    // river weight mirrors the tells weight
    expect(byName('Cattaraugus Creek')?.weight).toBeCloseTo(0.6)
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
