// Runtime OSM scenic-feature catalog for the live scan radius — the browser-side twin of the
// build-time crawl in scripts/enrich-scenery.mjs (tellsQuery + categorize). It fetches the same
// feature classes (viewpoints, peaks, water, forest/park, ugly landuse) once per scanned area via
// the app's shared Overpass infrastructure, categorizes them into RubricTells for per-road rubric
// measurement, AND collects a flat ScenicPOI list for stop synthesis. Pure catalog: tells.viewMinM
// is left undefined here — it is nearest-viewpoint distance, computed per-road by the caller.

import { fetchOverpass, type OverpassElement } from './overpass'
import type { LatLng } from './geometry'
import type { RubricTells, WeightedTell } from './sceneryTells'
import type { ScenicStop } from '../data/types'

/** Size weights for water features (a Great-Lake shore reads far stronger than a ditch). Mirrors
 *  WATER_SIZE in sceneryTells / scripts/lib/scenery-tells.mjs. Weight ≥ OPEN_WATER_W (0.7) means
 *  "open water you can actually see alongside you"; below that is a screened creek/minor watercourse. */
const WATER_SIZE = { coastline: 1.0, canal: 0.85, lake: 0.8, river: 0.5, stream: 0.3 }
/** An unnamed `natural=water` polygon smaller than {@link BIG_WATER_M2} is almost always a
 *  subdivision retention or backyard pond (the Heim Rd Street-View audit found 0.25–1.3 ha unnamed
 *  ponds set behind houses driving a bogus 7.6 water score). It gets a negligible weight so it can
 *  never read as a waterside ride; a *named/notable* or genuinely large body is real open water. */
const SMALL_POND_W = 0.2
const BIG_WATER_M2 = 40000 // ~4 ha; at/above this (or if named/notable) a water body is "open water"

/**
 * A scenic point of interest collected alongside the rubric tells, for synthesizing route stops.
 * `kind` is constrained to {@link ScenicStop.kind} so a POI can become a stop directly. `weight`
 * mirrors the strength the same feature carries in the tells (notable peak > minor viewpoint).
 */
export interface ScenicPOI {
  pt: LatLng
  name?: string
  kind: ScenicStop['kind']
  notable: boolean
  source?: string
  weight: number
}

/** The categorized tells (for rubric measurement) + flat POIs (for stop synthesis) of one area. */
export interface FeatureCatalog {
  tells: RubricTells
  pois: ScenicPOI[]
}

/**
 * Overpass QL for the scenic feature catalog within `radiusM` of `center`, using `(around:...)`
 * radial selectors (the live-scan equivalent of enrich-scenery's bbox tellsQuery). Same feature
 * classes, same `out geom;` so area features return full vertex rings. `timeout:25` matches the
 * app's server budget (see overpass.ts SERVER_TIMEOUT_S).
 */
export function buildTellsQuery(center: LatLng, radiusM: number): string {
  const a = `around:${radiusM},${center[0]},${center[1]}`
  return (
    `[out:json][timeout:25];(` +
    `nwr["tourism"="viewpoint"](${a});` +
    `nwr["natural"~"^(peak|cliff)$"](${a});` +
    `way["natural"="water"](${a});relation["natural"="water"](${a});` +
    `way["natural"="coastline"](${a});` +
    `way["waterway"~"^(river|stream|canal)$"](${a});` +
    `nwr["natural"="wood"](${a});` +
    `way["landuse"="forest"](${a});relation["landuse"="forest"](${a});` +
    `nwr["leisure"~"^(park|nature_reserve)$"](${a});` +
    `nwr["boundary"~"^(national_park|protected_area)$"](${a});` +
    `way["landuse"~"^(industrial|retail|commercial|quarry|landfill)$"](${a});` +
    `nwr["man_made"="works"](${a});` +
    `);out geom;`
  )
}

/** Approximate polygon area in m² (shoelace on a local equirectangular projection). Used to tell a
 *  genuine open-water body (lake/large pond) from an incidental subdivision retention pond. */
function polygonAreaM2(ring: LatLng[]): number {
  if (ring.length < 3) return 0
  const lat0 = ring.reduce((s, p) => s + p[0], 0) / ring.length
  const R = 6371000
  const k = Math.cos((lat0 * Math.PI) / 180)
  const xy = ring.map((p) => [((p[1] * Math.PI) / 180) * R * k, ((p[0] * Math.PI) / 180) * R] as const)
  let a = 0
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i]
    const [x2, y2] = xy[(i + 1) % xy.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a) / 2
}

const DS = 40 // cap vertices kept per feature (downsample big polygons/lines)

/** Evenly downsample a vertex list to at most `max` points (keeps the corridor scan cheap). */
function downsamplePts(pts: LatLng[], max = DS): LatLng[] {
  if (pts.length <= max) return pts
  const step = (pts.length - 1) / (max - 1)
  const out: LatLng[] = []
  for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)])
  return out
}

/** Representative point + full vertex ring for an element (node | way w/ geometry | relation). */
function geomOf(el: OverpassElement): { pt: LatLng; ring: LatLng[] | null } | null {
  if (Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
    return { pt: [el.lat as number, el.lon as number], ring: null }
  }
  if (Array.isArray(el.geometry) && el.geometry.length) {
    const ring = el.geometry
      .filter((g) => g && Number.isFinite(g.lat))
      .map((g) => [g.lat, g.lon] as LatLng)
    return ring.length ? { pt: ring[0], ring } : null
  }
  if (Array.isArray(el.members)) {
    const ring: LatLng[] = []
    for (const m of el.members) {
      if (Array.isArray(m.geometry)) {
        for (const g of m.geometry) if (g && Number.isFinite(g.lat)) ring.push([g.lat, g.lon])
      }
    }
    return ring.length ? { pt: ring[0], ring } : null
  }
  return null
}

/**
 * Categorize raw Overpass elements into {@link RubricTells} + a flat {@link ScenicPOI} list. Port
 * of categorize() in scripts/enrich-scenery.mjs: same tag→tell mapping and weights. POIs are
 * collected in parallel — viewpoint→'viewpoint'; peak/cliff→'viewpoint'; water/waterway→'water';
 * wood/forest/park/reserve/protected→'forest'. `viewMinM` is NOT set here (per-road, set later).
 */
export function categorizeFeatures(elements: OverpassElement[]): FeatureCatalog {
  const tells: RubricTells = {
    waterPts: [],
    waterAreas: [],
    greenAreas: [],
    greenPts: [],
    uglyAreas: [],
    uglyPts: [],
    view: [],
    peak: [],
    notable: [],
  }
  const pois: ScenicPOI[] = []
  const pushNotable = (t: WeightedTell): void => {
    tells.notable.push(t)
  }

  for (const el of elements) {
    const g = geomOf(el)
    const t = el.tags
    if (!g || !t) continue
    const verts = g.ring ? downsamplePts(g.ring) : [g.pt]
    const notable = !!(t.wikidata || t.wikipedia)

    if (t.tourism === 'viewpoint') {
      tells.view.push(g.pt)
      if (notable) pushNotable({ pt: g.pt, w: 1.0 })
      pois.push({ pt: g.pt, name: t.name, kind: 'viewpoint', notable, source: t.wikidata, weight: 1.0 })
    } else if (t.natural === 'peak' || t.natural === 'cliff') {
      tells.peak.push(g.pt)
      if (notable) pushNotable({ pt: g.pt, w: 0.8 })
      pois.push({ pt: g.pt, name: t.name, kind: 'viewpoint', notable, source: t.wikidata, weight: 0.8 })
    } else if (t.natural === 'coastline') {
      for (const v of verts) tells.waterPts.push({ pt: v, w: WATER_SIZE.coastline })
      pois.push({ pt: g.pt, name: t.name, kind: 'water', notable, weight: WATER_SIZE.coastline })
    } else if (t.natural === 'water') {
      // Open water only if it's sizable OR named/notable — otherwise it's a retention/backyard pond
      // that the rider never sees, so it must not count as shoreline or fill the containment test.
      const areaM2 = g.ring ? polygonAreaM2(g.ring) : 0
      const open = areaM2 >= BIG_WATER_M2 || notable || !!t.name
      const w = open ? WATER_SIZE.lake : SMALL_POND_W
      if (g.ring && open) tells.waterAreas.push(g.ring)
      for (const v of verts) tells.waterPts.push({ pt: v, w })
      if (notable) pushNotable({ pt: g.pt, w: 0.9 })
      pois.push({ pt: g.pt, name: t.name, kind: 'water', notable, source: t.wikidata, weight: w })
    } else if (t.waterway) {
      const w =
        t.waterway === 'canal' ? WATER_SIZE.canal : t.waterway === 'river' ? WATER_SIZE.river : WATER_SIZE.stream
      for (const v of verts) tells.waterPts.push({ pt: v, w })
      pois.push({ pt: g.pt, name: t.name, kind: 'water', notable, weight: w })
    } else if (
      t.natural === 'wood' ||
      t.landuse === 'forest' ||
      t.leisure === 'park' ||
      t.leisure === 'nature_reserve' ||
      t.boundary === 'national_park' ||
      t.boundary === 'protected_area'
    ) {
      if (g.ring) tells.greenAreas.push(g.ring)
      for (const v of verts) tells.greenPts.push(v)
      const isPark = t.boundary === 'national_park'
      if (notable || isPark) pushNotable({ pt: g.pt, w: isPark ? 1.0 : 0.7 })
      pois.push({
        pt: g.pt,
        name: t.name,
        kind: 'forest',
        notable: notable || isPark,
        source: t.wikidata,
        weight: isPark ? 1.0 : 0.7,
      })
    } else if (t.landuse || t.man_made === 'works') {
      if (g.ring) tells.uglyAreas.push(g.ring)
      for (const v of verts) tells.uglyPts.push(v)
    }
  }

  return { tells, pois }
}

/**
 * In-memory cache of the categorized feature catalog per scanned area, keyed by center+radius.
 * A repeat scan of the same area returns instantly with zero network — bounded + LRU-evicted like
 * overpass.ts scanCache so a long session can't grow it without limit.
 */
const featureCache = new Map<string, FeatureCatalog>()
const FEATURE_CACHE_CAP = 16

/** Drop all cached feature catalogs (used by tests; harmless to call at runtime). */
export function clearFeatureCache(): void {
  featureCache.clear()
}

/**
 * Fetch + categorize the scenic feature catalog within `radiusKm` of `center`, reusing the app's
 * Overpass mirror logic. Cached per center+radius. A fetch error is RETHROWN for the caller to
 * handle (an empty area is a valid result; a network/timeout failure is not).
 */
export async function fetchFeatureCatalog(
  center: LatLng,
  radiusKm: number,
  signal?: AbortSignal,
): Promise<FeatureCatalog> {
  const key = `${center[0]},${center[1]},${radiusKm}`

  const cached = featureCache.get(key)
  if (cached) {
    // Refresh recency (cheap LRU) so a hot area survives eviction.
    featureCache.delete(key)
    featureCache.set(key, cached)
    return cached
  }

  const radiusM = Math.round(radiusKm * 1000)
  const data = await fetchOverpass(buildTellsQuery(center, radiusM), signal)
  const catalog = categorizeFeatures(data.elements ?? [])

  featureCache.set(key, catalog)
  if (featureCache.size > FEATURE_CACHE_CAP) featureCache.delete(featureCache.keys().next().value!)

  return catalog
}
