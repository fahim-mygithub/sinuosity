import { haversine, pathLength, cleanCoords, curvature10, bearing, type LatLng } from './geometry';
import { measureRubric } from './sceneryTells';
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
  // Re-measure the rubric on the FULL stitched corridor (not just the seed segment).
  let viewMinM = Infinity;
  for (const c of coords) for (const v of catalog.tells.view) {
    const d = haversine(c, v) * 1000;
    if (d < viewMinM) viewMinM = d;
  }
  const m = measureRubric(coords, { ...catalog.tells, viewMinM });
  const rubric: ScenicRubric = {
    curvature: curvature10(coords),
    scenery: m.scenery,
    greenery: m.greenery,
    water: m.water,
    notability: m.notability,
  };
  const score = compositeScore(rubric, bias);
  const stops = synthesizeStops(coords, catalog.pois, rubric);
  const { theme, summary, whyRide } = describe(rubric, stops, km);
  const name = rideName(seed, chain, rubric);

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
  viewpoint: 'Scenic viewpoint', waterfall: 'Waterfall', gorge: 'Gorge', water: 'Waterside',
  overlook: 'Overlook', village: 'Village', forest: 'Woodland stretch', bridge: 'Bridge', caution: 'Caution',
};
const KIND_BLURB: Record<ScenicStop['kind'], string> = {
  viewpoint: 'An OSM-tagged viewpoint right off the route — pull over and take it in.',
  waterfall: 'Falling water close to the road — worth the short stop.',
  gorge: 'The land drops away beside the route here.',
  water: 'The ride runs close to open water along this stretch.',
  overlook: 'A spot to pull off and look out over the country.',
  village: 'A small settlement to slow through.',
  forest: 'Tree cover closes in around the road through here.',
  bridge: 'A crossing with a view up- and downstream.',
  caution: 'Take this stretch with care.',
};

/**
 * Pick the numbered stops: scenic features within ~450 m of the corridor, notable ones first,
 * de-clustered, ordered along the route. Viewpoints/peaks sit AT the feature (you detour to them);
 * water/woods sit on the nearest road point with the camera aimed at the feature. Falls back to a
 * couple of terrain stops from the rubric so a ride is never empty.
 */
export function synthesizeStops(coords: LatLng[], pois: ScenicPOI[], rubric: ScenicRubric): ScenicStop[] {
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
  // Notable first, then closest.
  cands.sort((a, b) => Number(b.poi.notable) - Number(a.poi.notable) || a.distM - b.distM);

  const chosen: Cand[] = [];
  for (const c of cands) {
    if (chosen.length >= MAX_STOPS) break;
    if (chosen.some((ch) => haversine(ch.poi.pt, c.poi.pt) * 1000 < STOP_SPACING_M)) continue;
    chosen.push(c);
  }
  chosen.sort((a, b) => a.idx - b.idx);

  const stops: ScenicStop[] = chosen.map((c) => {
    const atFeature = c.poi.kind === 'viewpoint';
    const anchor = atFeature ? c.poi.pt : coords[c.idx];
    return {
      lat: anchor[0],
      lon: anchor[1],
      title: c.poi.name || KIND_TITLE[c.poi.kind],
      blurb: KIND_BLURB[c.poi.kind],
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

/** Templated, deterministic theme/summary/why-ride from the measured rubric (no LLM at runtime). */
function describe(rubric: ScenicRubric, stops: ScenicStop[], km: number): { theme: string; summary: string; whyRide: string } {
  const curve = rubric.curvature >= 6 ? 'serpentine' : rubric.curvature >= 4 ? 'flowing' : 'easygoing';
  const wet = rubric.water >= 5;
  const green = rubric.greenery >= 5;
  const scenic = rubric.scenery >= 5;
  const notable = rubric.notability >= 5;

  // Theme keys off the strongest non-curvature dimension.
  const dims: [string, number][] = [
    ['Waterside', rubric.water], ['Backwoods', rubric.greenery],
    ['Scenic', rubric.scenery], ['Landmark', rubric.notability],
  ];
  dims.sort((a, b) => b[1] - a[1]);
  const theme = dims[0][1] >= 4 ? dims[0][0] : 'Twisty';

  const clauses: string[] = [`A ${curve} ${km.toFixed(0)} km run`];
  if (wet) clauses.push('tracing open water');
  if (green) clauses.push('threading deep woods');
  if (scenic && !green) clauses.push('opening onto big country views');
  if (notable) clauses.push('past a spot riders mark on the map');
  const summary =
    clauses.join(', ').replace(/,([^,]*)$/, ' and$1') +
    `. Stitched live from OpenStreetMap geometry and scored on measured curvature plus nearby water, woods, viewpoints and notable places.` +
    (stops.length ? ` ${stops.length} stop${stops.length === 1 ? '' : 's'} along the way.` : '');

  const why =
    rubric.curvature >= 6 && (wet || scenic)
      ? 'Tight, sustained corners with scenery to match.'
      : wet
        ? 'Corner work with water in the frame most of the way.'
        : green
          ? 'A cool, tree-tunnelled backroad with real curve to it.'
          : notable
            ? 'A backroad that strings together places worth slowing for.'
            : 'A genuinely twisty stretch the scan turned up nearby.';

  return { theme, summary, whyRide: why };
}

/** Name a ride after the strongest-named road in its chain, plus a terrain descriptor. */
function rideName(seed: ScoredRoad, chain: LatLng[][], rubric: ScenicRubric): string {
  const base = seed.name && seed.name !== 'Unnamed road' ? seed.name : null;
  const descriptor =
    rubric.water >= 6 ? 'Shoreline Run'
      : rubric.greenery >= 6 ? 'Woodland Run'
        : rubric.curvature >= 6 ? 'Carver'
          : rubric.notability >= 6 ? 'Landmark Loop'
            : 'Backroad';
  if (base) return chain.length > 1 ? `${base} ${descriptor}` : base;
  return `Discovered ${descriptor}`;
}

function formatMinutes(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
