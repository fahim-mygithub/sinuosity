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

/** Fraction of route sample points that fall inside ANY of the given polygons (rings). */
export function fractionInside(routePts: LatLng[], polygons: LatLng[][]): number {
  if (!polygons || !polygons.length || !routePts.length) return 0
  let c = 0
  for (const rp of routePts) if (polygons.some((poly) => poly.length >= 3 && pointInRing(rp, poly))) c++
  return c / routePts.length
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
  let adjCount = 0
  let proxSum = 0
  let minM = Infinity
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
  let sum = 0
  let adj = 0
  const thresh = Math.exp(-1)
  for (const rp of routePts) {
    let best = 0
    for (const t of weightedTells) {
      const v = t.w * Math.exp(-haversineM(rp, t.pt) / tauM)
      if (v > best) best = v
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
