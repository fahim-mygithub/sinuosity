import type { LatLng } from './geometry';
import { sinuosityScore, curvature10, pathLength, haversine } from './geometry';
import type { ScannedRoad, ScoredRoad, ScenicRubric } from '../data/types';
import { fetchFeatureCatalog, type FeatureCatalog } from './features';
import { measureRubric } from './sceneryTells';

/**
 * Public Overpass mirrors, tried in order. The pool was rebuilt from browser-side probes of the
 * deployed origin: overpass-api.de and overpass.openstreetmap.fr both answer WITH CORS for our
 * area, so they are the two reliable, planet-wide instances. (overpass.osm.ch is CORS-OK but only
 * serves Switzerland; maps.mail.ru works but is VK-hosted; kumi.systems / private.coffee were
 * unreachable from the app's network — all excluded.) The client bounds the whole sequence via
 * the caller's AbortSignal.
 */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter', // canonical, highest capacity
  'https://overpass.openstreetmap.fr/api/interpreter', // OSM-France — CORS-verified fallback
];

/**
 * Server-side query budget (seconds). A wide "all roads in a radius" query legitimately takes
 * ~20-25s of server time when the public instances are busy, so this can't be tight — too low
 * and the server self-aborts and returns 0 ways (the old `15` was the real cause of "always
 * busy": heavy scans never had time to finish). The client still bounds wall-clock below.
 */
const SERVER_TIMEOUT_S = 25;

/**
 * Per-mirror wall-clock budget (ms). This must EXCEED the real query time (~20-25s busy), or we
 * abandon a mirror that was about to answer — which is exactly the bug that made heavy scans look
 * permanently "busy" (the old 6-8s killed a 23s query every time). A truly dead mirror still
 * fails fast (connection refused / CORS error throw immediately); this budget only governs a
 * mirror that accepted the request but is grinding. The caller's overall timeout (see App) caps
 * the full sequence, so a stalled lead still leaves room for one fallback attempt.
 */
const PER_MIRROR_TIMEOUT_MS = 26000;

export class OverpassError extends Error {
  constructor(message: string, public kind: 'timeout' | 'http' | 'network' | 'empty') {
    super(message);
    this.name = 'OverpassError';
  }
}

/** One Overpass element. Permissive on purpose: roads are ways with `geometry`, but the scenic
 *  feature catalog (features.ts) also reads nodes (viewpoint/peak — `lat`/`lon`) and relations
 *  (lake/forest multipolygons — `members[].geometry`). */
export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
  members?: { geometry?: { lat: number; lon: number }[] }[];
  tags?: Record<string, string>;
}
export interface OverpassResponse {
  elements?: OverpassElement[];
  remark?: string;
}

/**
 * POST a query to the first responsive Overpass mirror. Detects the silent-failure
 * mode where the server returns HTTP 200 with an empty `elements` array and a
 * `remark` describing a runtime timeout — that is a failure, not an empty result.
 * On a recoverable failure it advances to the next mirror; a client abort stops
 * immediately (the user/timeout cancelled).
 */
export async function fetchOverpass(query: string, signal?: AbortSignal): Promise<OverpassResponse> {
  let lastErr: OverpassError | null = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    if (signal?.aborted) throw new OverpassError('Scan cancelled', 'timeout');

    // Bound each mirror with its own timer AND forward the caller's signal, so a stalled mirror
    // is abandoned after PER_MIRROR_TIMEOUT_MS while a real cancel/overall-timeout still stops us.
    const attempt = new AbortController();
    const onCallerAbort = () => attempt.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; attempt.abort(); }, PER_MIRROR_TIMEOUT_MS);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: attempt.signal,
      });

      if (!res.ok) {
        lastErr = new OverpassError(`Overpass returned ${res.status}`, 'http');
        continue; // try next mirror
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('json')) {
        lastErr = new OverpassError('Overpass returned a non-JSON response', 'http');
        continue;
      }

      const data = (await res.json()) as OverpassResponse;

      // HTTP 200 + a runtime-error remark is a *failure*, not a 0-result success.
      if (data.remark && /timed out|runtime error|rate_limited|too many|busy/i.test(data.remark)) {
        lastErr = new OverpassError(data.remark, 'timeout');
        continue; // a different mirror may be less loaded
      }
      return data;
    } catch (e) {
      // An abort we did NOT trigger (the caller cancelled or the overall timeout fired) stops the
      // whole sequence. Our own per-mirror timeout just fails this mirror over to the next one.
      if ((e as Error).name === 'AbortError' && !timedOut) {
        throw new OverpassError('Scan timed out', 'timeout');
      }
      lastErr = timedOut
        ? new OverpassError(`Mirror timed out: ${endpoint}`, 'timeout')
        : new OverpassError('Network request failed', 'network');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  throw lastErr ?? new OverpassError('All Overpass mirrors are unavailable', 'network');
}

/** Parse Overpass `out geom` ways into scored roads. No threshold filter — that is applied
 * at return time so a cached corpus can be re-filtered by twistiness with no new query. */
function parseRoads(elements: OverpassElement[]): ScannedRoad[] {
  const roads: ScannedRoad[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const pts: LatLng[] = el.geometry.map((g) => [g.lat, g.lon] as LatLng);
    if (pts.length <= 3) continue;

    const s = sinuosityScore(pts);
    roads.push({
      id: `scan-${el.id}`,
      name: el.tags?.name ?? 'Unnamed road',
      curveDensity: s,
      sinuosity: Math.min(10, s * 4),
      score: Math.min(100, Math.round(s * 30)),
      coords: pts,
    });
  }
  return roads;
}

/**
 * In-memory cache of the full (unfiltered) road corpus per query, keyed by center+radius. This
 * makes "always busy" stop mattering for anywhere you've already scanned this session: a repeat
 * scan — or a change to the twistiness threshold (which only re-filters, never re-queries) —
 * returns instantly with zero network. Bounded so a long session can't grow it without limit.
 */
const scanCache = new Map<string, ScannedRoad[]>();
const SCAN_CACHE_CAP = 16;

/** Drop all cached scans (used by tests; harmless to call at runtime). */
export function clearScanCache(): void {
  scanCache.clear();
}

/**
 * Scan secondary/tertiary/unclassified roads within `radiusKm` of a center point,
 * scoring each by measured curvature. Pure geometry — no scenery estimates here.
 *
 * Uses `out geom;` (inline geometry) instead of `out body;>;` node recursion — this
 * is dramatically lighter on the server and completes where the recursive query
 * times out, while returning the same polylines. The unfiltered corpus is cached
 * per center+radius so repeat scans / threshold changes don't re-hit Overpass.
 */
export async function scanRoads(
  center: LatLng,
  radiusKm: number,
  minSinuosity: number,
  signal?: AbortSignal,
): Promise<ScannedRoad[]> {
  const radiusM = Math.round(radiusKm * 1000);
  const query =
    `[out:json][timeout:${SERVER_TIMEOUT_S}];` +
    `way["highway"~"^(secondary|tertiary|unclassified)$"](around:${radiusM},${center[0]},${center[1]});` +
    `out geom;`;

  let corpus = scanCache.get(query);
  if (corpus) {
    // Refresh recency (cheap LRU) so a hot area survives eviction.
    scanCache.delete(query);
    scanCache.set(query, corpus);
  } else {
    const data = await fetchOverpass(query, signal);
    corpus = parseRoads(data.elements ?? []);
    scanCache.set(query, corpus);
    if (scanCache.size > SCAN_CACHE_CAP) scanCache.delete(scanCache.keys().next().value!);
  }

  return corpus
    .filter((r) => r.curveDensity >= minSinuosity)
    .sort((a, b) => b.score - a.score);
}

/** The full result of a multi-criteria area scan: every candidate road with its MEASURED rubric,
 *  plus the scenic-feature catalog used to build rides and place stops. */
export interface AreaScan {
  roads: ScoredRoad[];
  catalog: FeatureCatalog;
  center: LatLng;
  radiusKm: number;
}

const areaCache = new Map<string, AreaScan>();

/** Drop cached area scans (tests; harmless at runtime). */
export function clearAreaCache(): void {
  areaCache.clear();
}

/**
 * Multi-criteria scan: pull the road network AND the scenic-feature catalog (water, woods,
 * viewpoints, peaks, notable places) within `radiusKm`, then MEASURE the full scenery rubric for
 * each candidate road from those features — the same methodology the build-time pipeline uses,
 * run live. Curvature alone no longer decides the score; the caller re-ranks by a user-weighted
 * composite and stitches rides without re-querying.
 *
 * The rubric pass is O(roads × samples × tells), so the candidate set is bounded to the roads
 * worth riding (real length, some curve) and capped — keeping the browser responsive on a wide
 * radius. The whole result is cached per center+radius so bias-slider changes never re-hit OSM.
 */
export async function scanArea(
  center: LatLng,
  radiusKm: number,
  signal?: AbortSignal,
): Promise<AreaScan> {
  const key = `${center[0].toFixed(4)},${center[1].toFixed(4)},${radiusKm}`;
  const cached = areaCache.get(key);
  if (cached) {
    areaCache.delete(key);
    areaCache.set(key, cached);
    return cached;
  }

  const radiusM = Math.round(radiusKm * 1000);
  const roadQuery =
    `[out:json][timeout:${SERVER_TIMEOUT_S}];` +
    `way["highway"~"^(secondary|tertiary|unclassified)$"](around:${radiusM},${center[0]},${center[1]});` +
    `out geom;`;

  // Roads and scenic features in parallel — two Overpass calls, each with its own mirror failover.
  const [roadData, catalog] = await Promise.all([
    fetchOverpass(roadQuery, signal),
    fetchFeatureCatalog(center, radiusKm, signal),
  ]);

  const corpus = parseRoads(roadData.elements ?? []);
  // Bound the rubric pass: only score roads with real length and at least a hint of curve, capped
  // to the strongest candidates. (Ruler-straight grid roads are almost never the ride you want.)
  const candidates = corpus
    .filter((r) => pathLength(r.coords) >= 0.5 && r.curveDensity >= 0.12)
    .sort((a, b) => b.curveDensity - a.curveDensity)
    .slice(0, 300);

  const viewPts = catalog.tells.view;
  const roads: ScoredRoad[] = candidates.map((r) => {
    // viewMinM (nearest viewpoint to this road) lifts notability when a viewpoint sits on the road.
    let viewMinM = Infinity;
    for (const c of r.coords) {
      for (const v of viewPts) {
        const d = haversine(c, v) * 1000;
        if (d < viewMinM) viewMinM = d;
      }
    }
    const m = measureRubric(r.coords, { ...catalog.tells, viewMinM });
    const rubric: ScenicRubric = {
      curvature: curvature10(r.coords),
      scenery: m.scenery,
      greenery: m.greenery,
      water: m.water,
      notability: m.notability,
    };
    return { ...r, rubric };
  });

  const result: AreaScan = { roads, catalog, center, radiusKm };
  areaCache.set(key, result);
  if (areaCache.size > SCAN_CACHE_CAP) areaCache.delete(areaCache.keys().next().value!);
  return result;
}

/**
 * Collapse same-named OSM ways (a single road is often split into many `way`
 * entities) into one list row, keeping the highest-scoring segment per name.
 * Unnamed roads are never merged together. The full `roads` array (every polyline)
 * should still be drawn on the map; this only de-clutters the result list.
 */
export function dedupeByName(roads: ScannedRoad[]): ScannedRoad[] {
  const best = new Map<string, ScannedRoad>();
  const unnamed: ScannedRoad[] = [];
  for (const r of roads) {
    if (r.name === 'Unnamed road') {
      unnamed.push(r);
      continue;
    }
    const prev = best.get(r.name);
    if (!prev || r.score > prev.score) best.set(r.name, r);
  }
  return [...best.values(), ...unnamed].sort((a, b) => b.score - a.score);
}
