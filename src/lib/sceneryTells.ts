// Deterministic roadside-"prettiness" measurement from OSM map-tells (the L0 layer of the
// scenery methodology). Pure functions, no network — the enrich script does the Overpass I/O
// and hands these categorized features + the route polyline.
//
// Philosophy mirrors curvature: MEASURE the rubric from real geo-features instead of letting an
// LLM guess it. Area features (forest, park, lake) are measured by polygon CONTAINMENT (is the
// road inside it?) plus EDGE proximity (does it run along the shore/treeline?); a centroid would
// sit far from a road skirting a big polygon and silently read ~0. Linear/point features (rivers,
// coastline, viewpoints, peaks) are measured by corridor proximity. Scenery is fused
// CONDITIONALLY (multiplicatively) with naturalness — a lone viewpoint in a built-up area must
// not max the field (the validators' tree-tunnel / cornfield trap).
//
// Faithful TS port of scripts/lib/scenery-tells.mjs. Unit-tested in sceneryTells.test.ts.

import { haversine, type LatLng } from './geometry'

/** Distance in meters between two points (haversine returns km). */
const haversineM = (a: LatLng, b: LatLng): number => haversine(a, b) * 1000

/** A point tell carrying a size/importance weight (e.g. a lake-shore vertex). */
export interface WeightedTell {
  pt: LatLng
  w: number
}

/** Categorized OSM "tells" along/near a corridor, handed to {@link measureRubric}. */
export interface RubricTells {
  waterPts: WeightedTell[]
  waterAreas: LatLng[][]
  greenAreas: LatLng[][]
  greenPts: LatLng[]
  uglyAreas: LatLng[][]
  uglyPts: LatLng[]
  view: LatLng[]
  peak: LatLng[]
  notable: WeightedTell[]
  viewMinM?: number
}

/** The measured 0-10 rubric fields plus the provenance of which tells fired. */
export interface MeasuredScenery {
  scenery: number
  greenery: number
  water: number
  notability: number
  provenance: Record<string, number>
}

// Proximity decay length scales (metres) per feature family — how far a feature still "counts".
export const TAU = { water: 500, green: 320, view: 800, peak: 1500, ugly: 240 }
// A route sample point is "adjacent" to a family if its nearest feature is within this (metres).
export const ADJ_M = 260
// Size weights for water features (a Great Lake shore reads far stronger than a ditch).
export const WATER_SIZE = { coastline: 1.0, canal: 0.85, lake: 0.8, river: 0.5, stream: 0.3 }
// "Open water you can actually see alongside you" vs an incidental ditch/screened creek/retention
// pond. The Heim Rd Street-View audit showed proximity ALONE is dishonest: 0.25–1.3 ha unnamed
// ponds set behind houses, plus a creek screened in a wooded gully, drove a 7.6 water score with NO
// visible water. So the water score rewards OPEN water (weight ≥ OPEN_WATER_W) within sight distance
// for a sustained fraction of the corridor, plus containment; a minor watercourse (river/stream
// centerline, OPEN_WATER_W > w ≥ MINOR_WATER_W) adds only a small, capped amount.
export const OPEN_WATER_W = 0.7
export const MINOR_WATER_W = 0.3
export const WATER_SIGHT_M = 120

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x))
const round1 = (x: number): number => Math.round(x * 10) / 10
/** Saturating 0..1 ramp for non-negative x (diminishing returns). */
export const sat = (x: number): number => 1 - Math.exp(-Math.max(0, x))

/** Evenly downsample a polyline to at most `max` points (keeps the corridor scan cheap). */
export function sampleRoute(coords: LatLng[], max = 60): LatLng[] {
  if (coords.length <= max) return coords.map((c) => [c[0], c[1]] as LatLng)
  const step = (coords.length - 1) / (max - 1)
  const out: LatLng[] = []
  for (let i = 0; i < max; i++) out.push(coords[Math.round(i * step)])
  return out
}

/** Ray-casting point-in-polygon. pt and ring vertices are [lat,lon] (lon=x, lat=y). */
export function pointInRing(pt: LatLng, ring: LatLng[]): boolean {
  const x = pt[1]
  const y = pt[0]
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][1]
    const yi = ring[i][0]
    const xj = ring[j][1]
    const yj = ring[j][0]
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

/**
 * Bounding boxes for a polygon list, cached per array.
 *
 * A point inside a ring is always inside that ring's bbox, so rejecting on the bbox first is exact.
 * A tile-sourced scan merges ~6000 forest/park polygons, and routeBuilder re-measures every stitched
 * ride against all of them.
 */
const bboxCache = new WeakMap<LatLng[][], [number, number, number, number][]>()
function bboxesFor(polygons: LatLng[][]): [number, number, number, number][] {
  let boxes = bboxCache.get(polygons)
  if (boxes) return boxes
  boxes = polygons.map((poly) => {
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity
    for (const p of poly) {
      if (p[0] < s) s = p[0]
      if (p[0] > n) n = p[0]
      if (p[1] < w) w = p[1]
      if (p[1] > e) e = p[1]
    }
    return [s, w, n, e] as [number, number, number, number]
  })
  bboxCache.set(polygons, boxes)
  return boxes
}

/** Fraction of route sample points that fall inside ANY of the given polygons (rings). */
export function fractionInside(routePts: LatLng[], polygons: LatLng[][]): number {
  if (!polygons || !polygons.length || !routePts.length) return 0
  const boxes = bboxesFor(polygons)
  let c = 0
  for (const rp of routePts) {
    for (let i = 0; i < polygons.length; i++) {
      const b = boxes[i]
      if (rp[0] < b[0] || rp[0] > b[2] || rp[1] < b[1] || rp[1] > b[3]) continue
      if (polygons[i].length >= 3 && pointInRing(rp, polygons[i])) { c++; break }
    }
  }
  return c / routePts.length
}

// ------------------------------------------------------------------------------------------------
// Exact nearest-feature acceleration. Mirrors scripts/lib/scenery-tells.mjs.
//
// Both signals below need only the NEAREST tell (corridorSignal) or the STRONGEST w*exp(-d/tau)
// (weightedSignal) per route sample point. Neither sums over all tells, so a spatial index returns
// EXACTLY the same answer as the brute-force scan — an indexing change, not an approximation.
//
// It became necessary when the Scan tab started reading precomputed tiles: a tile-sourced scan
// merges the tells of ~6-9 whole tiles rather than just the queried radius (a Buffalo scan carries
// ~255,000 water vertices), and routeBuilder re-measures the rubric on every stitched ride against
// all of them. Brute force there froze the page outright.
// ------------------------------------------------------------------------------------------------

/** Below this many tells the scan is already cheap and a grid would only add overhead. */
const GRID_MIN = 512
/** Grid cell edge (metres). Small enough that few points share a cell, big enough to bound rings. */
const CELL_M = 250
const M_PER_DEG_LAT = 111320

interface Grid<T> {
  cells: Map<string, T[]>
  dLat: number
  dLon: number
  iMin: number
  iMax: number
  jMin: number
  jMax: number
}

const gridCache = new WeakMap<object, Grid<unknown>>()

function buildGrid<T>(tells: T[], ptOf: (t: T) => LatLng): Grid<T> {
  let latSum = 0
  for (const t of tells) latSum += ptOf(t)[0]
  const lat0 = latSum / tells.length
  const dLat = CELL_M / M_PER_DEG_LAT
  const dLon = CELL_M / (M_PER_DEG_LAT * Math.max(0.05, Math.cos((lat0 * Math.PI) / 180)))

  const cells = new Map<string, T[]>()
  // The occupied extent, in cell coordinates. Ring search stops once it has swept past this, which
  // is what makes termination exact: an arbitrary ring cap would silently report "nothing found"
  // for a route far from all data, where brute force still returns a real (if tiny) distance.
  let iMin = Infinity, iMax = -Infinity, jMin = Infinity, jMax = -Infinity
  for (const t of tells) {
    const p = ptOf(t)
    const i = Math.floor(p[0] / dLat)
    const j = Math.floor(p[1] / dLon)
    if (i < iMin) iMin = i
    if (i > iMax) iMax = i
    if (j < jMin) jMin = j
    if (j > jMax) jMax = j
    const key = `${i},${j}`
    let bucket = cells.get(key)
    if (!bucket) cells.set(key, (bucket = []))
    bucket.push(t)
  }
  return { cells, dLat, dLon, iMin, iMax, jMin, jMax }
}

function gridFor<T>(tells: T[], ptOf: (t: T) => LatLng): Grid<T> {
  let g = gridCache.get(tells as unknown as object) as Grid<T> | undefined
  if (!g) gridCache.set(tells as unknown as object, (g = buildGrid(tells, ptOf)) as Grid<unknown>)
  return g
}

/**
 * Walk grid rings outward from `rp` until no ring could improve on what has been found.
 * `stillWorth(best, ringMinM)` returning false is what makes the early exit exact.
 */
function ringSearch<T, B>(
  grid: Grid<T>,
  rp: LatLng,
  seed: B,
  consider: (best: B, t: T) => B,
  stillWorth: (best: B, ringMinM: number) => boolean,
): B {
  const ci = Math.floor(rp[0] / grid.dLat)
  const cj = Math.floor(rp[1] / grid.dLon)
  let best = seed

  // Skip straight to the first ring that can intersect occupied space; cells nearer than this are
  // provably outside the occupied bbox, so nothing is missed and empty rings are not walked.
  const r0 = Math.max(
    Math.max(grid.iMin - ci, ci - grid.iMax, 0),
    Math.max(grid.jMin - cj, cj - grid.jMax, 0),
  )

  for (let r = r0; ; r++) {
    // Anything in ring r is at least (r-1) cells away; 0.9 absorbs lat/lon cell anisotropy.
    const ringMinM = r === 0 ? 0 : (r - 1) * CELL_M * 0.9
    if (r > r0 && !stillWorth(best, ringMinM)) break

    for (let i = Math.max(ci - r, grid.iMin); i <= Math.min(ci + r, grid.iMax); i++) {
      for (let j = Math.max(cj - r, grid.jMin); j <= Math.min(cj + r, grid.jMax); j++) {
        // Only the perimeter of ring r is new; the interior was covered by earlier rings.
        if (r > 0 && i !== ci - r && i !== ci + r && j !== cj - r && j !== cj + r) continue
        const bucket = grid.cells.get(`${i},${j}`)
        if (!bucket) continue
        for (const t of bucket) best = consider(best, t)
      }
    }

    if (ci - r <= grid.iMin && ci + r >= grid.iMax && cj - r <= grid.jMin && cj + r >= grid.jMax) break
  }
  return best
}

/**
 * Is any weighted tell within `maxM` of `pt`? Exact, and short-circuits on the first hit.
 *
 * Exists for the "does this road genuinely run ALONGSIDE water" tests in routeBuilder, which ask
 * this question for every vertex of every stitched ride. Those ran brute force over a filtered copy
 * of every water vertex in the scan; once the Scan tab began merging whole tiles (~255,000 water
 * vertices for a Buffalo scan) that became ~50M distance calls per ride and took 20s of main-thread
 * time. The grid makes it a bounded local lookup with the same answer.
 *
 * Pass a STABLE array — the grid is cached per array identity, so rebuilding the filtered list on
 * every call would rebuild the index every call too.
 */
export function anyWithinM(tells: WeightedTell[], pt: LatLng, maxM: number): boolean {
  if (!tells.length) return false
  if (tells.length < GRID_MIN) {
    for (const t of tells) if (haversineM(pt, t.pt) <= maxM) return true
    return false
  }
  const grid = gridFor(tells, (t) => t.pt)
  return ringSearch<WeightedTell, boolean>(
    grid, pt, false,
    (found, t) => found || haversineM(pt, t.pt) <= maxM,
    // Stop as soon as a hit is found, or once no ring can still be within maxM.
    (found, ringMinM) => !found && ringMinM <= maxM,
  )
}

/**
 * Corridor signal for one set of feature points: for each route sample point find its nearest
 * feature, then return the fraction of route points "adjacent" (within adjM) and the mean
 * proximity weight exp(-d/tau). Both bounded [0,1] and monotone in closeness/density.
 */
export function corridorSignal(
  routePts: LatLng[],
  tellPts: LatLng[],
  tauM: number,
  adjM = ADJ_M,
): { adj: number; prox: number; minM: number } {
  if (!tellPts || !tellPts.length || !routePts.length) return { adj: 0, prox: 0, minM: Infinity }
  const grid = tellPts.length >= GRID_MIN ? gridFor(tellPts, (p) => p) : null

  let adjCount = 0
  let proxSum = 0
  let minM = Infinity
  for (const rp of routePts) {
    let nearest: number
    if (grid) {
      nearest = ringSearch<LatLng, number>(
        grid, rp, Infinity,
        (best, tp) => { const d = haversineM(rp, tp); return d < best ? d : best },
        // Keep expanding only while a point out at ringMinM could still be nearer than `best`.
        (best, ringMinM) => ringMinM < best,
      )
    } else {
      nearest = Infinity
      for (const tp of tellPts) {
        const d = haversineM(rp, tp)
        if (d < nearest) nearest = d
      }
    }
    if (nearest <= adjM) adjCount++
    proxSum += Math.exp(-nearest / tauM)
    if (nearest < minM) minM = nearest
  }
  return { adj: adjCount / routePts.length, prox: proxSum / routePts.length, minM }
}

/**
 * Size-weighted corridor proximity (for water, where feature size matters): per route point take
 * the strongest w*exp(-d/tau) over weighted tells, then average. Bounded [0, maxWeight].
 */
export function weightedSignal(
  routePts: LatLng[],
  weightedTells: WeightedTell[],
  tauM: number,
): { prox: number; adj: number } {
  if (!weightedTells || !weightedTells.length || !routePts.length) return { prox: 0, adj: 0 }
  const grid = weightedTells.length >= GRID_MIN ? gridFor(weightedTells, (t) => t.pt) : null
  // A far point can still win if its weight is high, so the ring bound uses the LARGEST weight
  // present: nothing beyond ringMinM can beat `best` once wMax*exp(-ringMinM/tau) <= best.
  let wMax = 0
  if (grid) for (const t of weightedTells) if (t.w > wMax) wMax = t.w

  let sum = 0
  let adj = 0
  const thresh = Math.exp(-1)
  for (const rp of routePts) {
    let best: number
    if (grid) {
      best = ringSearch<WeightedTell, number>(
        grid, rp, 0,
        (b, t) => { const v = t.w * Math.exp(-haversineM(rp, t.pt) / tauM); return v > b ? v : b },
        (b, ringMinM) => wMax * Math.exp(-ringMinM / tauM) > b,
      )
    } else {
      best = 0
      for (const t of weightedTells) {
        const v = t.w * Math.exp(-haversineM(rp, t.pt) / tauM)
        if (v > best) best = v
      }
    }
    sum += best
    if (best >= thresh) adj++
  }
  return { prox: sum / routePts.length, adj: adj / routePts.length }
}

/**
 * Build the measured 0-10 rubric fields from categorized tells along a route.
 *
 * tells = {
 *   waterPts:   [{ pt:[lat,lon], w:number }],  // vertices of coastline/river/stream/lake edge
 *   waterAreas: [ [[lat,lon],...], ... ],       // lake polygons (containment)
 *   greenAreas: [ poly, ... ],  greenPts: [[lat,lon],...],  // forest/park polygons + their edges
 *   uglyAreas:  [ poly, ... ],  uglyPts:  [[lat,lon],...],  // industrial/quarry/retail
 *   view: [[lat,lon],...],  peak: [[lat,lon],...],
 *   notable: [{ pt:[lat,lon], w:number }],      // wikidata/wikipedia-tagged or protected
 *   viewMinM?: number                            // nearest viewpoint distance, if known
 * }
 * Returns { scenery, greenery, water, notability } each rounded to 0.1 in [0,10], plus a
 * `provenance` object so the UI / audit can see which tells fired.
 */
export function measureRubric(coords: LatLng[], tells: Partial<RubricTells>): MeasuredScenery {
  const route = sampleRoute(coords)

  // WATER — honest "water you actually ride alongside", not mere proximity (see OPEN_WATER_W note).
  // Open water within sight distance, for a sustained fraction of the corridor, plus containment for
  // roads that skirt/cross a real body. A screened creek/stream contributes only a small capped term.
  const waterPts = tells.waterPts ?? []
  const openTells = waterPts.filter((t) => t.w >= OPEN_WATER_W)
  const minorTells = waterPts.filter((t) => t.w >= MINOR_WATER_W && t.w < OPEN_WATER_W)
  const waterAreas = tells.waterAreas ?? []
  let alongHits = 0
  for (const rp of route) {
    let near = false
    for (const t of openTells) {
      if (haversineM(rp, t.pt) <= WATER_SIGHT_M) { near = true; break }
    }
    if (!near) near = waterAreas.some((poly) => poly.length >= 3 && pointInRing(rp, poly))
    if (near) alongHits++
  }
  const alongFrac = route.length ? alongHits / route.length : 0
  const waterContain = fractionInside(route, waterAreas)
  const openProx = weightedSignal(route, openTells, TAU.water).prox
  const minorProx = weightedSignal(route, minorTells, TAU.water).prox
  const water = clamp(10 * sat(2.6 * alongFrac) + 2.5 * waterContain + 2.2 * sat(2 * minorProx), 0, 10)

  // GREENERY — forest/park CONTAINMENT (road inside the woods) + treeline adjacency, minus ugly.
  const greenContain = fractionInside(route, tells.greenAreas ?? [])
  const ge = corridorSignal(route, tells.greenPts ?? [], TAU.green)
  const uglyContain = fractionInside(route, tells.uglyAreas ?? [])
  const us = corridorSignal(route, tells.uglyPts ?? [], TAU.ugly)
  const uglyFactor = Math.max(uglyContain, us.adj)
  const greenery = clamp(10 * (0.6 * greenContain + 0.4 * ge.adj) - 5 * uglyFactor, 0, 10)

  // SCENERY — viewpoints + peaks fused CONDITIONALLY with naturalness (multiply, don't sum):
  // a lone viewpoint in built-up land is damped, a feature amid woods/water is rewarded.
  const vs = corridorSignal(route, tells.view ?? [], TAU.view)
  const ps = corridorSignal(route, tells.peak ?? [], TAU.peak)
  const featureBase = 0.62 * sat(2.2 * vs.prox) + 0.38 * sat(1.6 * ps.prox)
  const waterNatural = openProx + 0.4 * minorProx
  const naturalness = clamp(
    0.3 + 0.7 * (1 - uglyFactor) * Math.max(greenContain, sat(2.5 * waterNatural + 1.2 * ge.adj)),
    0,
    1,
  )
  const scenery = clamp(10 * featureBase * naturalness + 2 * waterContain, 0, 10)

  // NOTABILITY — discrete "other people care about this" signal; max of available evidence.
  const ns = weightedSignal(route, tells.notable ?? [], TAU.green) // tau ~ a few hundred m
  let notability = 10 * sat(3 * ns.prox)
  if (Number.isFinite(tells.viewMinM) && (tells.viewMinM as number) < 150) notability = Math.max(notability, 7)
  notability = clamp(notability, 0, 10)

  return {
    scenery: round1(scenery),
    greenery: round1(greenery),
    water: round1(water),
    notability: round1(notability),
    provenance: {
      waterAlong: round1(alongFrac),
      waterContain: round1(waterContain),
      greenContain: round1(greenContain),
      greenAdj: round1(ge.adj),
      uglyFactor: round1(uglyFactor),
      viewProx: round1(vs.prox),
      peakProx: round1(ps.prox),
      naturalness: round1(naturalness),
    },
  }
}
