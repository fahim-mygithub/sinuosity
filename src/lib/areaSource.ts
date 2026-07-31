// Chooses where a scan's data comes from: the precomputed tile corpus, or live Overpass.
//
// This is the only place that decision is made. `scanArea` in overpass.ts stays exactly as it was
// and remains the fallback implementation, so a bug in the tile path can never leave the app worse
// off than it was before tiles existed — it degrades to today's behaviour.
//
// See docs/plans/2026-07-31-precomputed-tiles-design.md.

import type { LatLng } from './geometry';
import { scanArea, type AreaScan } from './overpass';
import { scanAreaFromTiles, inCoverage } from './tileSource';

/** Where a completed scan's data came from — surfaced so the UI can explain a slow scan. */
export type ScanSource = 'tiles' | 'overpass';

export interface SourcedAreaScan {
  scan: AreaScan;
  source: ScanSource;
}

/**
 * Fetch an area scan, preferring the precomputed corpus.
 *
 * Falls back to live Overpass when the centre is outside built coverage, or when the tile path
 * fails for any reason other than the caller aborting. An abort is propagated untouched: the user
 * cancelled or the overall timeout fired, and silently starting a 25s Overpass query at that point
 * would be the opposite of what they asked for.
 */
export async function fetchAreaScan(
  center: LatLng,
  radiusKm: number,
  signal?: AbortSignal,
): Promise<SourcedAreaScan> {
  if (inCoverage(center)) {
    try {
      return { scan: await scanAreaFromTiles(center, radiusKm, signal), source: 'tiles' };
    } catch (e) {
      if (signal?.aborted || (e as Error).name === 'AbortError') throw e;
      // Anything else — a missing tile, a malformed payload, a network blip — is recoverable by
      // asking Overpass. Logged rather than silent so a systematically broken corpus is findable.
      console.warn('[scan] tile corpus unavailable, falling back to Overpass:', (e as Error).message);
    }
  }
  return { scan: await scanArea(center, radiusKm, signal), source: 'overpass' };
}
