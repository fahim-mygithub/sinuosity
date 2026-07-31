// Reads the precomputed tile corpus (public/tiles/) and assembles the same AreaScan the live
// Overpass path produces. See docs/plans/2026-07-31-precomputed-tiles-design.md.
//
// Everything expensive already happened at build time: curvature, the per-road rubric, and the
// scenic-feature categorization. This module decodes, merges the handful of tiles a scan touches,
// and filters to the radius. No measurement, no network beyond the static fetches.

import type { LatLng } from './geometry';
import { haversine } from './geometry';
import type { ScannedRoad, ScoredRoad, ScenicRubric } from '../data/types';
import type { ScenicPOI } from './features';
import type { RubricTells } from './sceneryTells';
import type { AreaScan } from './overpass';
import { decodePath, tileKey, tilesForBounds, TILE_DEG } from './tileCodec';

/** Built coverage, mirroring GRID in scripts/build-tiles.mjs. Outside this, callers use Overpass. */
export const COVERAGE = { s: 40.5, w: -79.8, n: 45.0, e: -71.8 };

/** Is a scan centre inside the precomputed corpus? */
export function inCoverage(center: LatLng): boolean {
  return center[0] >= COVERAGE.s && center[0] < COVERAGE.n && center[1] >= COVERAGE.w && center[1] < COVERAGE.e;
}

/** Base path for tile fetches. Vite rewrites BASE_URL to `/sinuosity/` in a production build. */
const TILE_BASE = `${import.meta.env.BASE_URL}tiles/`;

interface WireTile {
  v: number;
  bbox: [number, number, number, number];
  roads: {
    id: number; name?: string; ref?: string; highway?: string; surface?: string;
    maxspeedMph?: number; paved?: boolean; oneway?: string;
    curveDensity: number; geom: number[];
    rubric?: Omit<ScenicRubric, 'gradeDrama'> & { gradeDrama?: number };
  }[];
  tells: {
    waterPts: { pts: number[]; w: number[] };
    waterAreas: number[][]; greenAreas: number[][]; greenPts: number[];
    uglyAreas: number[][]; uglyPts: number[];
    view: number[]; peak: number[];
    notable: { pts: number[]; w: number[] };
  };
  pois: { pts: number[]; meta: Omit<ScenicPOI, 'pt'>[] };
}

/** Pair a delta-encoded point sequence back up with its parallel weight array. */
function weighted(enc: { pts: number[]; w: number[] }): { pt: LatLng; w: number }[] {
  const pts = decodePath(enc.pts);
  return pts.map((pt, i) => ({ pt, w: enc.w[i] }));
}

function decodeTile(t: WireTile): { roads: ScannedRoad[]; scored: ScoredRoad[]; tells: RubricTells; pois: ScenicPOI[] } {
  const roads: ScannedRoad[] = [];
  const scored: ScoredRoad[] = [];

  for (const r of t.roads) {
    const coords = decodePath(r.geom);
    const road: ScannedRoad = {
      // Same `scan-<osmId>` shape the Overpass path produces, so downstream identity is unchanged.
      id: `scan-${r.id}`,
      name: r.name ?? 'Unnamed road',
      curveDensity: r.curveDensity,
      sinuosity: Math.min(10, r.curveDensity * 4),
      score: Math.min(100, Math.round(r.curveDensity * 30)),
      coords,
      highway: r.highway,
      ref: r.ref,
      surface: r.surface,
      maxspeedMph: r.maxspeedMph,
      paved: r.paved,
      oneway: r.oneway,
    };
    roads.push(road);
    if (r.rubric) scored.push({ ...road, rubric: r.rubric });
  }

  const tells: RubricTells = {
    waterPts: weighted(t.tells.waterPts),
    waterAreas: t.tells.waterAreas.map(decodePath),
    greenAreas: t.tells.greenAreas.map(decodePath),
    greenPts: decodePath(t.tells.greenPts),
    uglyAreas: t.tells.uglyAreas.map(decodePath),
    uglyPts: decodePath(t.tells.uglyPts),
    view: decodePath(t.tells.view),
    peak: decodePath(t.tells.peak),
    notable: weighted(t.tells.notable),
  };

  const poiPts = decodePath(t.pois.pts);
  const pois: ScenicPOI[] = t.pois.meta.map((m, i) => ({ ...m, pt: poiPts[i] }));

  return { roads, scored, tells, pois };
}

/** Thrown when the corpus cannot serve this scan; the caller falls back to Overpass. */
export class TileMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TileMissError';
  }
}

/** Cap on scored candidates, mirroring overpass.ts scanArea. Applied AFTER merging tiles — a
 *  per-tile cap would bias the result toward whichever tile happened to be denser. */
const CANDIDATE_CAP = 300;

/**
 * Build an {@link AreaScan} from the precomputed corpus.
 *
 * Throws {@link TileMissError} if any tile the scan needs is unavailable. That is deliberately
 * strict: a partial tile set produces a scan that looks fine but is quietly missing whole regions,
 * which is worse than falling back to the (slower, complete) Overpass path.
 */
export async function scanAreaFromTiles(
  center: LatLng,
  radiusKm: number,
  signal?: AbortSignal,
): Promise<AreaScan> {
  const keys = tilesForBounds(center[0], center[1], radiusKm);

  const loaded = await Promise.all(
    keys.map(async ([a, b]) => {
      const url = `${TILE_BASE}${tileKey(a, b)}.json`;
      const res = await fetch(url, { signal });
      // A tile outside the built grid legitimately 404s — the scan bbox can overhang the coverage
      // edge. Treat it as empty rather than a miss; inCoverage() already gated the centre.
      if (res.status === 404) return null;
      if (!res.ok) throw new TileMissError(`tile ${tileKey(a, b)}: HTTP ${res.status}`);
      return decodeTile((await res.json()) as WireTile);
    }),
  );

  const present = loaded.filter((t): t is NonNullable<typeof t> => t !== null);
  if (!present.length) throw new TileMissError('no tiles available for this area');

  const corpus: ScannedRoad[] = [];
  const scoredAll: ScoredRoad[] = [];
  const tells: RubricTells = {
    waterPts: [], waterAreas: [], greenAreas: [], greenPts: [],
    uglyAreas: [], uglyPts: [], view: [], peak: [], notable: [],
  };
  const pois: ScenicPOI[] = [];

  for (const t of present) {
    corpus.push(...t.roads);
    scoredAll.push(...t.scored);
    tells.waterPts.push(...t.tells.waterPts);
    tells.waterAreas.push(...t.tells.waterAreas);
    tells.greenAreas.push(...t.tells.greenAreas);
    tells.greenPts.push(...t.tells.greenPts);
    tells.uglyAreas.push(...t.tells.uglyAreas);
    tells.uglyPts.push(...t.tells.uglyPts);
    tells.view.push(...t.tells.view);
    tells.peak.push(...t.tells.peak);
    tells.notable.push(...t.tells.notable);
    pois.push(...t.pois);
  }

  // Ways are stored whole, so a tile-owned road can reach outside the scan. Keep any road with a
  // vertex inside the radius — the same "touches the area" semantics Overpass's (around:) gives.
  const touches = (coords: LatLng[]): boolean => coords.some((c) => haversine(c, center) <= radiusKm);

  const roads = scoredAll
    .filter((r) => touches(r.coords))
    .sort((a, b) => b.curveDensity - a.curveDensity)
    .slice(0, CANDIDATE_CAP);

  return {
    roads,
    catalog: { tells, pois },
    center,
    radiusKm,
    corpus: corpus.filter((r) => touches(r.coords)),
  };
}

/** Exposed for tests: how many tiles a scan of this size touches. */
export const tileCountFor = (center: LatLng, radiusKm: number): number =>
  tilesForBounds(center[0], center[1], radiusKm).length;

export { TILE_DEG };
