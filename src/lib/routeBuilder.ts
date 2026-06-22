import { haversine, pathLength, cleanCoords, flowCurvature, bearing, type LatLng } from './geometry';
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

/**
 * Build rides from the scored candidate roads. Pure + deterministic: same roads + same bias ⇒ same
 * rides, so re-running on a bias-slider change (no network) is cheap and stable.
 */
export function buildRides(roads: ScoredRoad[], catalog: FeatureCatalog, opts: BuildOptions): ScenicRoute[] {
  const targetKm = opts.targetKm ?? 22;
  const minKm = opts.minKm ?? 4;
  const maxRides = opts.maxRides ?? 8;
  const bias = opts.bias;

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

  const used = new Set<number>();
  const bestUnusedAt = (k: string, self: number): number | null => {
    let best: number | null = null;
    for (const i of endpoints.get(k) ?? []) {
      if (i === self || used.has(i)) continue;
      if (best === null || comp[i] > comp[best]) best = i;
    }
    return best;
  };

  const rides: ScenicRoute[] = [];
  let palette = 0;

  for (const seed of order) {
    if (rides.length >= maxRides) break;
    if (used.has(seed)) continue;
    used.add(seed);

    const chain: LatLng[][] = [roads[seed].coords];
    const chainKm = () => chain.reduce((s, c) => s + pathLength(c), 0);

    // Grow off the tail.
    let tailKey = key(roads[seed].coords[roads[seed].coords.length - 1]);
    while (chainKm() < targetKm && chain.length < 14) {
      const next = bestUnusedAt(tailKey, seed);
      if (next === null) break;
      used.add(next);
      let nc = roads[next].coords;
      if (key(nc[0]) !== tailKey) nc = reversed(nc);
      chain.push(nc);
      tailKey = key(nc[nc.length - 1]);
    }
    // Grow off the head.
    let headKey = key(roads[seed].coords[0]);
    while (chainKm() < targetKm && chain.length < 14) {
      const prev = bestUnusedAt(headKey, seed);
      if (prev === null) break;
      used.add(prev);
      let pc = roads[prev].coords;
      if (key(pc[pc.length - 1]) !== headKey) pc = reversed(pc);
      chain.unshift(pc);
      headKey = key(pc[0]);
    }

    const merged = cleanCoords(chain.flat());
    const coords = downsample(merged, 150);
    const km = pathLength(coords);
    if (km < minKm || coords.length < 4) continue;

    rides.push(toScenicRoute(coords, km, roads[seed], chain, catalog, bias, PALETTE[palette % PALETTE.length], opts.areaLabel));
    palette++;
  }

  return rides.sort((a, b) => b.score - a.score);
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
  const name = rideName(seed, chain, rubric, { shore, creek, greenContain });

  return {
    id: `scan-${seed.id}-${Math.round(km * 10)}-${coords.length}`,
    name,
    theme,
    region: areaLabel ? `near ${areaLabel}` : 'Live scan',
    distanceKm: +km.toFixed(1),
    drivingTime: formatMinutes((km / 55) * 60),
    summary,
    whyRide,
    rubric,
    score,
    color,
    coords,
    stops,
  };
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
function rideName(seed: ScoredRoad, chain: LatLng[][], rubric: ScenicRubric, ctx: { shore: number; creek: number; greenContain: number }): string {
  const base = seed.name && seed.name !== 'Unnamed road' ? seed.name : null;
  const descriptor =
    ctx.shore >= TRUE_SHORE_FRAC ? 'Shoreline Run'
      : ctx.greenContain >= WOODED_CONTAIN ? 'Woodland Run'
        : rubric.curvature >= 6 ? 'Carver'
          : ctx.creek >= CREEK_FRAC ? 'Creek Run'
            : rubric.notability >= 5 ? 'Landmark Loop'
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
