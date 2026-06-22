import { haversine, pathLength, cleanCoords, flowCurvature, bearing, dropBacktracks, type LatLng } from './geometry';
import { measureRubric, pointInRing, OPEN_WATER_W, MINOR_WATER_W, type RubricTells } from './sceneryTells';
import { compositeScore, type BiasWeights } from './composite';
import type { FeatureCatalog, ScenicPOI } from './features';
import type { ScoredRoad, ScenicRoute, ScenicRubric, ScenicStop } from '../data/types';

/**
 * Stitch scored roads into composite "discovered rides" and dress each as a full ScenicRoute so it
 * opens the same cruise page as the curated/scenic rides. This is the runtime answer to "catalog
 * the data in the radius, then create paths that incorporate them": adjacent candidate roads are
 * chained head-to-tail through the graph (preferring high composite under the rider's bias), the
 * combined polyline's rubric is re-MEASURED from the OSM feature catalog, and nearby viewpoints /
 * water / woods become the numbered stops.
 */

const PALETTE = ['#10b981', '#f97316', '#e11d48', '#06b6d4', '#a855f7', '#eab308', '#ef4444', '#14b8a6'];

export interface BuildOptions {
  bias: BiasWeights;
  /** Stop chaining once a ride reaches roughly this length (km). */
  targetKm?: number;
  /** Discard a stitched ride shorter than this (km). */
  minKm?: number;
  /** Most rides to return. */
  maxRides?: number;
  /** Shown as the ride's region line, e.g. the scan-center label. */
  areaLabel?: string;
}

const round4 = (n: number) => n.toFixed(4);
const key = (p: LatLng) => `${round4(p[0])},${round4(p[1])}`;
const reversed = (c: LatLng[]) => [...c].reverse();

const RETURN_BIAS = 0.6; // homeward pull strength, capped so it can never starve a ride below minKm
const RETURN_EPS = 0.05; // km — a biased pick must reduce dist-to-start by at least this to be taken
const TAIL_CAP = 18; // max roads in a chain (raised from 14 to offset dropped head-growth)

/** Shape of a stitched ride. A `loop` returns near its start through the graph; everything else is
 *  an honest `out-and-back` (you retrace to come home). */
export type RideShape = 'loop' | 'out-and-back';

/** Loop-closure radius (km) for shape classification — tighter than growth. clamp(target*0.08,0.3,2). */
function loopCloseKm(targetKm: number): number {
  return Math.min(2.0, Math.max(0.3, targetKm * 0.08));
}

/**
 * Build rides from the scored candidate roads. Pure + deterministic: same roads + same bias ⇒ same
 * rides, so re-running on a bias-slider change (no network) is cheap and stable.
 *
 * Output is sorted by an internal `rank = score * rideabilityFactor` (B6); `.score` itself stays a
 * PURE composite of the re-measured rubric so the 0–100 badge always matches the rubric meters.
 */
export function buildRides(roads: ScoredRoad[], catalog: FeatureCatalog, opts: BuildOptions): ScenicRoute[] {
  const targetKm = opts.targetKm ?? 22;
  const minKm = opts.minKm ?? 4;
  const maxRides = opts.maxRides ?? 8;
  const bias = opts.bias;
  const closeKm = loopCloseKm(targetKm);

  // Composite under the current bias decides both seed order and which neighbour to chain next.
  const comp = roads.map((r) => compositeScore(r.rubric, bias));
  const order = roads.map((_, i) => i).sort((a, b) => comp[b] - comp[a]);

  // Endpoint index: rounded coordinate → road indices that touch it. OSM ways split at junctions
  // share the junction node exactly, so equal keys mean the roads genuinely connect.
  const endpoints = new Map<string, number[]>();
  const addEnd = (k: string, i: number) => {
    const list = endpoints.get(k);
    if (list) list.push(i);
    else endpoints.set(k, [i]);
  };
  roads.forEach((r, i) => {
    if (r.coords.length < 2) return;
    addEnd(key(r.coords[0]), i);
    addEnd(key(r.coords[r.coords.length - 1]), i);
  });

  // Committed roads (B2): a chain reserves indices in `claimed`; they join `used` ONLY after the
  // minKm/length gate passes, so a discarded chain frees its roads for later seeds.
  const used = new Set<number>();

  const built: { route: ScenicRoute; rank: number }[] = [];
  let palette = 0;

  for (const seed of order) {
    if (built.length >= maxRides) break;
    if (used.has(seed)) continue;

    const seedRoad = roads[seed];
    if (seedRoad.coords.length < 2) continue;
    const start = seedRoad.coords[0]; // the TRUE anchor — tail-only growth keeps it fixed (B3)

    const claimed = new Set<number>([seed]);
    const isFree = (i: number) => !used.has(i) && !claimed.has(i);

    const chain: LatLng[][] = [seedRoad.coords];
    const chainRoads: ScoredRoad[] = [seedRoad];
    const chainKm = () => chain.reduce((s, c) => s + pathLength(c), 0);

    // The candidate road's endpoint that is NOT the current tail (i.e. where the chain would
    // advance to if we appended it).
    const farEndpoint = (i: number, fromKey: string): LatLng => {
      const c = roads[i].coords;
      return key(c[0]) === fromKey ? c[c.length - 1] : c[0];
    };
    const distToStart = (p: LatLng) => haversine(p, start);

    // Tail-only growth (B3). Composite stays dominant; past the halfway mark a homeward NUDGE is
    // applied and accepted only if it strictly reduces distance-to-start. RETURN_BIAS is capped and
    // a dead-ended biased walk falls back to the un-biased best (never returns less than today).
    let tailKey = key(seedRoad.coords[seedRoad.coords.length - 1]);
    while (chainKm() < targetKm && chain.length < TAIL_CAP) {
      const km = chainKm();
      const progress = Math.max(0, Math.min(1, (km - targetKm * 0.5) / (targetKm * 0.5)));

      const candidates: number[] = [];
      for (const i of endpoints.get(tailKey) ?? []) {
        if (i === seed || !isFree(i)) continue;
        candidates.push(i);
      }
      if (!candidates.length) break;

      // Un-biased best (the fallback that guarantees we never grow LESS than before).
      let best = candidates[0];
      for (const i of candidates) if (comp[i] > comp[best]) best = i;

      let pick = best;
      if (progress > 0 && RETURN_BIAS > 0) {
        const tailPt = lastPoint(chain);
        const curTailDist = distToStart(tailPt);
        let bestBiased: number | null = null;
        let bestBiasedScore = -Infinity;
        for (const i of candidates) {
          const fe = farEndpoint(i, tailKey);
          const s = comp[i] - RETURN_BIAS * progress * distToStart(fe);
          if (s > bestBiasedScore) { bestBiasedScore = s; bestBiased = i; }
        }
        if (bestBiased !== null) {
          const newTailDist = distToStart(farEndpoint(bestBiased, tailKey));
          // Accept the homeward pick ONLY if it strictly gets us closer to start.
          if (newTailDist < curTailDist - RETURN_EPS) pick = bestBiased;
        }
      }

      claimed.add(pick);
      let nc = roads[pick].coords;
      if (key(nc[0]) !== tailKey) nc = reversed(nc);
      chain.push(nc);
      chainRoads.push(roads[pick]);
      tailKey = key(nc[nc.length - 1]);
    }

    // C2 wire order: clean (flat) → dropBacktracks(start, shape) → downsample(150) → recompute km.
    const cleaned = cleanCoords(chain.flat());
    const shape = classifyShape(cleaned, chain, chainRoads, start, closeKm);
    // bandM < the smallest legitimate limb offset: a 40–60 m hairpin's parallel limbs fall OUTSIDE
    // the 25 m band → not read as a retrace → preserved (spec C1 hairpin invariant), while a true
    // draw-over-itself backtrack (near-coincident limbs, <25 m) still collapses. This decouples
    // bandM from rejoinM's default (=rejoinM) so the production wiring honours the hardening
    // hairpin-preservation invariant, which overrides the bandM=rejoinM default.
    const debacktracked = dropBacktracks(cleaned, { start, shape, loopCloseKm: closeKm, bandM: 25 });
    const coords = downsample(debacktracked, 150);
    const km = pathLength(coords);
    if (km < minKm || coords.length < 4) continue; // discard → claimed roads stay free (B2)

    // Commit: the chain is a keeper, so its roads are now used.
    for (const i of claimed) used.add(i);

    const route = toScenicRoute(
      coords, km, seedRoad, chain, chainRoads, shape,
      catalog, bias, PALETTE[palette % PALETTE.length], opts.areaLabel,
    );
    built.push({ route, rank: rideRank(route, chainRoads) });
    palette++;
  }

  // Sort by internal rank (score × rideability); .score itself is untouched/pure (B6).
  built.sort((a, b) => b.rank - a.rank);
  return built.map((b) => b.route);
}

/** Last coordinate of a chain of polylines. */
function lastPoint(chain: LatLng[][]): LatLng {
  const last = chain[chain.length - 1];
  return last[last.length - 1];
}

/**
 * Honest shape classification (B4/M10). A ride is a `loop` ONLY when the walk closes through the
 * graph — its tail endpoint coincides (by junction key) with a node already on the chain or the
 * start node, a REAL cycle — AND the start/end are euclidean-close (`≤ loopCloseKm`). Euclidean
 * proximity is necessary, not sufficient. A closure that would require driving a `oneway` road the
 * wrong way is refused. Everything else is an honest `out-and-back`.
 */
function classifyShape(
  coords: LatLng[],
  chain: LatLng[][],
  chainRoads: ScoredRoad[],
  start: LatLng,
  closeKm: number,
): RideShape {
  if (coords.length < 2) return 'out-and-back';
  const end = coords[coords.length - 1];
  if (haversine(start, end) > closeKm) return 'out-and-back';

  // Graph closure: the tail's junction key must match a junction already visited on the chain
  // (the start node or any internal seam). Collect every junction key the chain passes through.
  const tailKey = key(lastPoint(chain));
  const visited = new Set<string>();
  // start of the chain
  visited.add(key(chain[0][0]));
  // each seam between consecutive legs is a shared junction; also the head of each leg
  for (let k = 0; k < chain.length - 1; k++) {
    visited.add(key(chain[k][chain[k].length - 1]));
  }
  if (!visited.has(tailKey)) return 'out-and-back';

  // Wrong-way guard: refuse a closure whose final leg is a oneway traversed backwards.
  const lastRoad = chainRoads[chainRoads.length - 1];
  if (lastRoad && isOneway(lastRoad.oneway)) {
    const lastLeg = chain[chain.length - 1];
    // The leg was oriented head→tail during growth; a oneway is only legal forward (matching its
    // own coord order). If we reversed it to stitch, the closure drives it backwards → refuse.
    const original = lastRoad.coords;
    const orientedReversed = key(lastLeg[0]) === key(original[original.length - 1]);
    if (orientedReversed) return 'out-and-back';
  }

  return 'loop';
}

/** Whether an OSM `oneway` tag means the road is directed (yes/true/1/-1). `no`/absent ⇒ false. */
function isOneway(oneway?: string): boolean {
  if (!oneway) return false;
  const v = oneway.trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1' || v === '-1';
}

const RIDEABILITY_MIN = 0.6;
const RIDEABILITY_MAX = 1.1;

/**
 * Rideability multiplier in [0.6, 1.1] from the chain's per-leg tags (B5/M6/M7). NEVER touches
 * `.score` — it only re-orders the list. Neutrality is the contract: a chain with no known speeds
 * and no known-unpaved legs returns EXACTLY 1.0, so an untagged WNY backroad ranks on geometry as
 * it does today. We penalize only KNOWN ≤30 mph, reward only KNOWN ≥45 mph, give a small class
 * bonus to tertiary/secondary over unclassified, and a small penalty per known-unpaved leg.
 */
export function rideabilityFactor(chainRoads: ScoredRoad[]): number {
  if (!chainRoads.length) return 1.0;
  let factor = 1.0;
  for (const r of chainRoads) {
    const v = r.maxspeedMph;
    if (v != null) {
      if (v <= 30) factor -= 0.05; // slow/urban leg — known low speed only
      else if (v >= 45) factor += 0.03; // open, sweeping leg — known high speed only
    }
    // Small class bonus: tertiary/secondary tend to be the good motorcycle roads.
    if (r.highway === 'tertiary' || r.highway === 'secondary') factor += 0.01;
    // Small penalty per KNOWN-unpaved leg (paved===false only; unknown surface stays neutral).
    if (r.paved === false) factor -= 0.04;
  }
  return Math.max(RIDEABILITY_MIN, Math.min(RIDEABILITY_MAX, factor));
}

/**
 * Internal ranking key (B6): the pure composite `.score` scaled by {@link rideabilityFactor}. Shape
 * is only a tie-breaker — there is NO score multiplier for an out-and-back (the old flat ×0.9 is
 * gone). Exported so the ordering test can assert the documented order without re-deriving it.
 */
export function rideRank(route: ScenicRoute, chainRoads: ScoredRoad[]): number {
  return route.score * rideabilityFactor(chainRoads);
}

/** Evenly downsample a dense polyline so the drawn line stays smooth and the URL stays short. */
function downsample(coords: LatLng[], max: number): LatLng[] {
  if (coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1);
  const out: LatLng[] = [];
  for (let i = 0; i < max; i++) out.push(coords[Math.round(i * step)]);
  return out;
}

const SHORELINE_NEAR_M = 90; // open water (w ≥ OPEN_WATER_W) this close, for a stretch = true shoreline
const TRUE_SHORE_FRAC = 0.22; // ≥ this fraction of the corridor alongside open water → "Shoreline"
const CREEK_NEAR_M = 70; // a creek/river centerline this close, for a stretch = a real creekside run
const CREEK_FRAC = 0.15; // ≥ this fraction alongside a minor watercourse → honest "Creekside"
const WOODED_CONTAIN = 0.35; // road inside tree cover for ≥ this fraction → "Woodland/Backwoods"

/**
 * Fraction of the corridor that genuinely runs ALONGSIDE open water (a lake/canal/coastline within
 * ~90 m, or inside a water polygon). This is the honesty lever the Street-View audit exposed: the
 * water *rubric* fires on any water within 500 m, so a suburban arterial that crosses a creek or
 * runs behind riverfront houses scores high — but only a genuinely shore-hugging road has a high
 * shoreline fraction. We label "Shoreline" only when this is real, and "Creekside" otherwise.
 */
function shorelineFraction(coords: LatLng[], tells: RubricTells): number {
  const open = tells.waterPts.filter((t) => t.w >= OPEN_WATER_W);
  if (!open.length && !tells.waterAreas.length) return 0;
  let hits = 0;
  for (const c of coords) {
    let near = false;
    for (const t of open) {
      if (haversine(c, t.pt) * 1000 <= SHORELINE_NEAR_M) { near = true; break; }
    }
    if (!near) near = tells.waterAreas.some((poly) => poly.length >= 3 && pointInRing(c, poly));
    if (near) hits++;
  }
  return coords.length ? hits / coords.length : 0;
}

/**
 * Fraction of the corridor that genuinely runs ALONGSIDE a minor watercourse (a creek/river
 * centerline within ~70 m). This is what makes a ride honestly "Creekside" — you actually track a
 * creek — as opposed to the old `rubric.water >= 5` label, which (pre-fix) fired on retention ponds
 * and a screened creek the road merely crossed (the Heim Rd audit). Open water is excluded here; a
 * lake/canal alongside is a Shoreline (see {@link shorelineFraction}), not a Creekside.
 */
function creekFraction(coords: LatLng[], tells: RubricTells): number {
  const creeks = tells.waterPts.filter((t) => t.w >= MINOR_WATER_W && t.w < OPEN_WATER_W);
  if (!creeks.length) return 0;
  let hits = 0;
  for (const c of coords) {
    for (const t of creeks) {
      if (haversine(c, t.pt) * 1000 <= CREEK_NEAR_M) { hits++; break; }
    }
  }
  return coords.length ? hits / coords.length : 0;
}

function toScenicRoute(
  coords: LatLng[],
  km: number,
  seed: ScoredRoad,
  chain: LatLng[][],
  chainRoads: ScoredRoad[],
  shape: RideShape,
  catalog: FeatureCatalog,
  bias: BiasWeights,
  color: string,
  areaLabel?: string,
): ScenicRoute {
  // Only VERIFIED viewpoints (named or wiki-tagged) feed the notability floor — bare unnamed
  // `tourism=viewpoint` map-tells are unreliable (the audit found off-road, no-imagery points).
  const verifiedViews = catalog.pois
    .filter((p) => p.kind === 'viewpoint' && (p.notable || !!p.name))
    .map((p) => p.pt);
  let viewMinM = Infinity;
  for (const c of coords) for (const v of verifiedViews) {
    const d = haversine(c, v) * 1000;
    if (d < viewMinM) viewMinM = d;
  }
  const m = measureRubric(coords, { ...catalog.tells, viewMinM });
  const rubric: ScenicRubric = {
    curvature: flowCurvature(coords), // rideable flow, junction corners excluded (see geometry.ts)
    scenery: m.scenery,
    greenery: m.greenery,
    water: m.water,
    notability: m.notability,
  };
  const score = compositeScore(rubric, bias);
  const shore = shorelineFraction(coords, catalog.tells);
  const creek = creekFraction(coords, catalog.tells);
  const greenContain = m.provenance?.greenContain ?? 0;
  const stops = synthesizeStops(coords, catalog.pois, rubric, shore);
  const { theme, summary, whyRide } = describe(rubric, km, { shore, creek, greenContain, stopCount: stops.length });
  // Shape clause appended to copy only; the theme cascade & descriptors stay byte-for-byte (B7).
  const startEndGapKm = coords.length >= 2 ? haversine(coords[0], coords[coords.length - 1]) : 0;
  const shapeClause = shapeClauseFor(shape, startEndGapKm);
  const name = rideName(seed, chain, rubric, shape, { shore, creek, greenContain });

  return {
    id: `scan-${seed.id}-${Math.round(km * 10)}-${coords.length}`,
    name,
    theme,
    region: areaLabel ? `near ${areaLabel}` : 'Live scan',
    distanceKm: +km.toFixed(1),
    drivingTime: formatMinutes((km / scanSpeedMph(chainRoads)) * 60),
    summary: `${summary} ${shapeClause}`,
    whyRide: `${whyRide} ${shapeClause}`,
    rubric,
    score,
    color,
    coords,
    stops,
  };
}

/**
 * Shape clause for the ride copy (B7/N4). A loop notes it returns near the start; an out-and-back
 * is upfront that you retrace your path. When the start/finish gap is non-trivial we report the
 * distance instead of promising a clean return.
 */
function shapeClauseFor(shape: RideShape, gapKm: number): string {
  if (shape === 'loop') return 'Loops back near where it starts.';
  if (gapKm >= 1) return `Out-and-back — you'll retrace your path to return. Ends about ${gapKm.toFixed(0)} km from the start.`;
  return "Out-and-back — you'll retrace your path to return.";
}

/**
 * Scan-path driving speed (mph) for the time estimate (B8/M12): the chain-weighted average of the
 * KNOWN posted speeds (each leg weighted by its length), clamped to a sane 25–60 mph band. Falls
 * back to 55 when no leg has a known posted speed (today's behaviour). Baked datasets untouched.
 */
function scanSpeedMph(chainRoads: ScoredRoad[]): number {
  let wSum = 0;
  let lenSum = 0;
  for (const r of chainRoads) {
    if (r.maxspeedMph == null) continue;
    const len = pathLength(r.coords);
    if (len <= 0) continue;
    wSum += r.maxspeedMph * len;
    lenSum += len;
  }
  if (lenSum <= 0) return 55;
  return Math.max(25, Math.min(60, wSum / lenSum));
}

const STOP_NEAR_M = 450; // a feature this close to the corridor is "on the ride"
const STOP_SPACING_M = 600; // don't cluster two pins on the same spot
const MAX_STOPS = 6;

const KIND_TITLE: Record<ScenicStop['kind'], string> = {
  viewpoint: 'Viewpoint (mapped)', waterfall: 'Waterfall', gorge: 'Gorge', water: 'Near water',
  overlook: 'Overlook', village: 'Village', forest: 'Wooded stretch', bridge: 'Bridge', caution: 'Caution',
};
// Deliberately measured wording — the Street-View audit showed "close on the map" often isn't a
// visible view, so the copy says what's mapped, not what you're promised to see.
const KIND_BLURB: Record<ScenicStop['kind'], string> = {
  viewpoint: 'A spot mapped as a viewpoint just off the route — scout it before counting on the view.',
  waterfall: 'Falling water mapped close to the road — worth the short stop.',
  gorge: 'The land drops away beside the route here.',
  water: 'The route passes near water here — it may be open or screened by trees/homes.',
  overlook: 'A spot to pull off and look out over the country.',
  village: 'A small settlement to slow through.',
  forest: 'Tree cover along the road through here.',
  bridge: 'A crossing with a look up- and downstream.',
  caution: 'Take this stretch with care.',
};

/** Stop ranking: verified (named/wiki-tagged) features first, then closest. Keeps an unnamed
 *  `viewpoint` map-tell from outranking a named lake/park when both are nearby. */
const poiQuality = (p: ScenicPOI): number => (p.notable ? 2 : 0) + (p.name ? 1 : 0);

/**
 * Pick the numbered stops: scenic features within ~450 m of the corridor, notable ones first,
 * de-clustered, ordered along the route. Viewpoints/peaks sit AT the feature (you detour to them);
 * water/woods sit on the nearest road point with the camera aimed at the feature. Falls back to a
 * couple of terrain stops from the rubric so a ride is never empty.
 */
export function synthesizeStops(
  coords: LatLng[],
  pois: ScenicPOI[],
  rubric: ScenicRubric,
  shore = 0,
): ScenicStop[] {
  type Cand = { poi: ScenicPOI; idx: number; distM: number };
  const cands: Cand[] = [];
  for (const poi of pois) {
    let best = Infinity, bi = 0;
    for (let i = 0; i < coords.length; i++) {
      const d = haversine(coords[i], poi.pt) * 1000;
      if (d < best) { best = d; bi = i; }
    }
    if (best <= STOP_NEAR_M) cands.push({ poi, idx: bi, distM: best });
  }
  // Verified (named/wiki-tagged) first, then closest — an anonymous viewpoint map-tell ranks last.
  cands.sort((a, b) => poiQuality(b.poi) - poiQuality(a.poi) || a.distM - b.distM);

  const chosen: Cand[] = [];
  for (const c of cands) {
    if (chosen.length >= MAX_STOPS) break;
    if (chosen.some((ch) => haversine(ch.poi.pt, c.poi.pt) * 1000 < STOP_SPACING_M)) continue;
    chosen.push(c);
  }
  chosen.sort((a, b) => a.idx - b.idx);

  // True shoreline → name the water stop honestly; otherwise keep the hedged "near water" copy.
  const waterBlurb = shore >= TRUE_SHORE_FRAC ? 'The ride runs right along open water here.' : KIND_BLURB.water;

  const stops: ScenicStop[] = chosen.map((c) => {
    const atFeature = c.poi.kind === 'viewpoint';
    const anchor = atFeature ? c.poi.pt : coords[c.idx];
    return {
      lat: anchor[0],
      lon: anchor[1],
      title: c.poi.name || KIND_TITLE[c.poi.kind],
      blurb: c.poi.kind === 'water' ? waterBlurb : KIND_BLURB[c.poi.kind],
      kind: c.poi.kind,
      heading: bearing(coords[c.idx], c.poi.pt),
      ...(c.poi.source ? { source: c.poi.source } : {}),
    };
  });

  if (stops.length >= 2) return stops;
  return fallbackStops(coords, rubric, stops);
}

/** When the corridor has no tagged features nearby, mark the terrain itself at even positions. */
function fallbackStops(coords: LatLng[], rubric: ScenicRubric, existing: ScenicStop[]): ScenicStop[] {
  const kind: ScenicStop['kind'] =
    rubric.water >= 5 ? 'water' : rubric.greenery >= 5 ? 'forest' : rubric.scenery >= 5 ? 'overlook' : 'viewpoint';
  const want = 2;
  const out = [...existing];
  const taken = new Set(existing.map((s) => `${s.lat.toFixed(3)},${s.lon.toFixed(3)}`));
  for (let k = 1; k <= want; k++) {
    const i = Math.round((coords.length - 1) * (k / (want + 1)));
    const p = coords[i];
    const id = `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
    if (taken.has(id)) continue;
    taken.add(id);
    const ahead = coords[Math.min(coords.length - 1, i + 1)];
    out.push({
      lat: p[0], lon: p[1],
      title: KIND_TITLE[kind],
      blurb: KIND_BLURB[kind],
      kind,
      heading: bearing(p, ahead),
    });
  }
  return out.sort((a, b) => indexAlong(coords, a) - indexAlong(coords, b));
}

function indexAlong(coords: LatLng[], s: ScenicStop): number {
  let best = Infinity, bi = 0;
  for (let i = 0; i < coords.length; i++) {
    const d = haversine(coords[i], [s.lat, s.lon]);
    if (d < best) { best = d; bi = i; }
  }
  return bi;
}

interface RideContext { shore: number; creek: number; greenContain: number; stopCount: number }

/**
 * Templated, deterministic theme/summary/why-ride — gated on the HONEST signals, not raw proximity.
 * "Shoreline" needs open water genuinely alongside; "Backwoods" needs the road inside tree cover;
 * "Creekside" is the honest label for near-but-not-on water. No LLM at runtime.
 */
function describe(rubric: ScenicRubric, km: number, ctx: RideContext): { theme: string; summary: string; whyRide: string } {
  const trueShore = ctx.shore >= TRUE_SHORE_FRAC;
  const creekside = !trueShore && ctx.creek >= CREEK_FRAC; // genuinely tracks a creek (not open shore)
  const wooded = ctx.greenContain >= WOODED_CONTAIN; // road actually inside tree cover
  const scenicView = !wooded && rubric.scenery >= 5;
  const notable = rubric.notability >= 5;
  const curve = rubric.curvature >= 6 ? 'serpentine' : rubric.curvature >= 3.5 ? 'flowing' : 'easygoing';

  const theme =
    trueShore ? 'Shoreline'
      : wooded ? 'Backwoods'
        : scenicView ? 'Scenic'
          : creekside ? 'Creekside'
            : notable ? 'Landmark'
              : rubric.curvature >= 4 ? 'Twisty'
                : 'Backroad';

  const clauses: string[] = [`A ${curve} ${km.toFixed(0)} km run`];
  if (trueShore) clauses.push('running right along open water');
  else if (creekside) clauses.push('tracking a creek nearby (often set back behind trees or homes)');
  if (wooded) clauses.push('through real tree cover');
  if (scenicView) clauses.push('with some open country views');
  if (notable) clauses.push('passing a spot mapped as notable');
  const summary =
    clauses.join(', ').replace(/,([^,]*)$/, ' and$1') +
    `. Stitched live from OpenStreetMap geometry; curvature is measured as rideable flow (junction ` +
    `corners excluded) and scenery/water/greenery from nearby mapped features — "close on the map" ` +
    `is reported honestly, not oversold.` +
    (ctx.stopCount ? ` ${ctx.stopCount} stop${ctx.stopCount === 1 ? '' : 's'} flagged along the way.` : '');

  const whyRide =
    rubric.curvature >= 6 && (trueShore || scenicView)
      ? 'Sustained corners with scenery to match.'
      : trueShore
        ? 'Open water in the frame for much of the ride.'
        : wooded
          ? 'A cool, tree-covered backroad with real curve to it.'
          : creekside
            ? 'A quiet run near the water — the views come and go, so scout it.'
            : notable
              ? 'Strings together a few spots worth slowing for.'
              : rubric.curvature >= 4
                ? 'A genuinely twisty stretch the scan turned up nearby.'
                : 'An easy backroad cruise the scan surfaced nearby.';

  return { theme, summary, whyRide };
}

/** Name a ride after the strongest-named road in its chain, plus an HONEST terrain descriptor
 *  (Shoreline only for real shoreline; Creek Run for creek-adjacent; Woodland needs containment). */
function rideName(seed: ScoredRoad, chain: LatLng[][], rubric: ScenicRubric, shape: RideShape, ctx: { shore: number; creek: number; greenContain: number }): string {
  const base = seed.name && seed.name !== 'Unnamed road' ? seed.name : null;
  // Notable descriptor is shape-aware: only a genuine loop earns "Landmark Loop"; an out-and-back
  // notable ride is a "Landmark Run" so the name never promises a loop it doesn't make (B7/M11).
  const landmark = shape === 'loop' ? 'Landmark Loop' : 'Landmark Run';
  const descriptor =
    ctx.shore >= TRUE_SHORE_FRAC ? 'Shoreline Run'
      : ctx.greenContain >= WOODED_CONTAIN ? 'Woodland Run'
        : rubric.curvature >= 6 ? 'Carver'
          : ctx.creek >= CREEK_FRAC ? 'Creek Run'
            : rubric.notability >= 5 ? landmark
              : rubric.curvature >= 4 ? 'Run'
                : 'Backroad';
  if (base) return chain.length > 1 ? `${base} ${descriptor}` : base;
  return `Discovered ${descriptor}`;
}

function formatMinutes(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
