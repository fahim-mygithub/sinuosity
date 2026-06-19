import type { LatLng } from './geometry';
import { sinuosityScore } from './geometry';
import type { ScannedRoad } from '../data/types';

/**
 * Public Overpass mirrors, tried in order. overpass-api.de is the most reliable
 * primary; the others are fallbacks for when it is overloaded. The client times out
 * the whole attempt sequence via the caller's AbortSignal.
 */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** Server-side query budget (seconds). Kept tight so a stuck query fails fast. */
const SERVER_TIMEOUT_S = 15;

export class OverpassError extends Error {
  constructor(message: string, public kind: 'timeout' | 'http' | 'network' | 'empty') {
    super(message);
    this.name = 'OverpassError';
  }
}

interface OverpassGeomWay {
  type: 'way';
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}
interface OverpassResponse {
  elements?: OverpassGeomWay[];
  remark?: string;
}

/**
 * POST a query to the first responsive Overpass mirror. Detects the silent-failure
 * mode where the server returns HTTP 200 with an empty `elements` array and a
 * `remark` describing a runtime timeout — that is a failure, not an empty result.
 * On a recoverable failure it advances to the next mirror; a client abort stops
 * immediately (the user/timeout cancelled).
 */
async function fetchOverpass(query: string, signal?: AbortSignal): Promise<OverpassResponse> {
  let lastErr: OverpassError | null = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal,
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
      // A client-side abort (manual cancel or our timeout) should not retry.
      if ((e as Error).name === 'AbortError') throw new OverpassError('Scan timed out', 'timeout');
      lastErr = new OverpassError('Network request failed', 'network');
    }
  }

  throw lastErr ?? new OverpassError('All Overpass mirrors are unavailable', 'network');
}

/**
 * Scan secondary/tertiary/unclassified roads within `radiusKm` of a center point,
 * scoring each by measured curvature. Pure geometry — no scenery estimates here.
 *
 * Uses `out geom;` (inline geometry) instead of `out body;>;` node recursion — this
 * is dramatically lighter on the server and completes where the recursive query
 * times out, while returning the same polylines.
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

  const data = await fetchOverpass(query, signal);
  const elements = data.elements ?? [];

  const roads: ScannedRoad[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const pts: LatLng[] = el.geometry.map((g) => [g.lat, g.lon] as LatLng);
    if (pts.length <= 3) continue;

    const s = sinuosityScore(pts);
    if (s < minSinuosity) continue;

    roads.push({
      id: `scan-${el.id}`,
      name: el.tags?.name ?? 'Unnamed road',
      curveDensity: s,
      sinuosity: Math.min(10, s * 4),
      score: Math.min(100, Math.round(s * 30)),
      coords: pts,
    });
  }

  roads.sort((a, b) => b.score - a.score);
  return roads;
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
