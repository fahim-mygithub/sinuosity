// The measured `cleanliness` signal for the Reel category: built-up (`highway=residential|service`)
// way density around a point. Separate query, separate categoriser, separate cache — deliberately,
// because a whole-scan regression sits one careless line away.
//
// WARNING — NEVER route these classes through `categorizeFeatures` in features.ts, and never add
// them to `buildTellsQuery`. That categoriser ends in a CATCH-ALL branch (features.ts:199,
// `else if (t.landuse || t.man_made === 'works')`) that files anything it did not recognise into
// `uglyAreas`. `uglyAreas` becomes `uglyFactor`, which subtracts 5x from `greenery` and pins
// `naturalness` at 0.3, so folding residential roads into the shared query would silently rescore
// EVERY Scenic, Curated and Scan result everywhere — and every rescored result would still look
// entirely plausible, which is what makes it dangerous rather than merely wrong. Nothing in this
// file builds, reads or returns a `RubricTells`, and the query below names no tag key that
// `categorizeFeatures` switches on.
//
// Why way density, and not the two obvious alternatives — both were measured and both were
// REJECTED, recorded here so they are not re-tried:
//   - `landuse=residential`: FOUR such polygons within 15 km of Ellicottville, and ZERO at every
//     rural site sampled. It cannot rank rural roads against each other, which is the entire job.
//   - buildings: the signal INVERTS exactly where it is needed — Ellicottville village returned
//     1116 buildings against suburban Amherst's 959.
// `highway=residential|service` separates 20.6x and is MONOTONE across the whole range —
// 1888 / 1609 / 559 / 198 / 130 / 54 / 13 ways, suburban Amherst out to rural Zoar Valley. Roads
// are the best-mapped class in OSM. Power lines separate 68x but are absent at four of seven sites,
// so they stay out of v1 rather than being averaged in as a mostly-zero column.

import { fetchOverpass, overpassSettings, MAXSIZE_FEATURES_MIB, type OverpassElement } from './overpass';
import { haversine, type LatLng } from './geometry';

/**
 * Overpass QL for the built-up density query: a bare `highway=residential|service` way selector
 * within `radiusM` of `center`, and nothing else. Every tag key this query does not name is a tag
 * key that cannot reach `categorizeFeatures` — see the warning at the top of this file.
 *
 * The settings prefix comes from {@link overpassSettings} rather than being written out as a
 * literal. When those two drifted apart before, the divergent query kept its own too-tight budget
 * and blew it during `print` — i.e. AFTER the server had already gathered the data — so the browser
 * downloaded a multi-MB payload only for `fetchOverpass` to read the `remark` and throw it away.
 *
 * `out ids geom;`: `ids` for verbosity because nothing downstream reads a tag, and this is the DENSE
 * class (1,888 ways in 12.6 km² of suburbia), so the tag block would be pure waste. Verified by
 * execution against overpass-api.de on 2026-08-02 rather than assumed, because the failure would
 * have been silent in the worst possible way — `ids` reads like it might suppress geometry too, and
 * a response with no geometry would make {@link countBuiltWays} return zero ways and every road in
 * the world score as perfectly clean. It does return geometry: id + bounds + full vertex list, and
 * zero tag blocks, at 566 bytes/way against 719 for `out geom` (~21% off the wire).
 *
 * `out ids center;` would be lighter still — one representative point per way is all
 * {@link countBuiltWays} keeps — but Overpass returns that in a `center` field which the shared
 * `OverpassElement` in overpass.ts does not declare, and widening a type other modules import is the
 * wrong trade for bytes: wall time here is dispatch-dominated (measured 24.4 s at 1.9 MB against
 * 34.9 s at 55 MB), so the bytes are very nearly free while the type change is not.
 *
 * Declares the FEATURES maxsize rather than the ROADS one because this class outnumbers
 * secondary/tertiary/unclassified by an order of magnitude, and 256 MiB is a claim Overpass is
 * already known to admit for the scenic union.
 */
export function buildBuiltUpQuery(center: LatLng, radiusM: number): string {
  return (
    `${overpassSettings(MAXSIZE_FEATURES_MIB)};` +
    `way["highway"~"^(residential|service)$"](around:${radiusM},${center[0]},${center[1]});` +
    `out ids geom;`
  );
}

/**
 * One degree of latitude in metres ON THE SPHERE `geometry.ts` uses (R = 6371 km).
 *
 * It has to be that sphere and not the WGS84 111,320 that sceneryTells carries: the cell window in
 * {@link builtDensityNear} is derived from this constant while the in/out test is `haversine`, so a
 * value 0.11% too large shrinks the swept window inside the query disc and silently drops ways
 * sitting within a metre of the rim. Small error, but it turns an exact count into an approximate
 * one for no reason.
 */
const M_PER_DEG_LAT = (6371000 * Math.PI) / 180;

/**
 * Grid cell edge (m). INVENTED, not measured: cleanliness asks for density at radii of a few hundred
 * metres up to about a kilometre, and 500 m keeps the swept window to a handful of cells at the
 * small end without making individual buckets so fat that the exact haversine pass dominates.
 */
const CELL_M = 500;

/** Below this many ways a linear scan is already cheap and the grid would only add overhead. */
const GRID_MIN = 512;

/**
 * A spatial index over the built-up ways of one queried area: one representative point per way,
 * bucketed into a lat/lon grid. Full geometry is deliberately not kept — the only question anyone
 * asks of this is "how many ways are near here", and a suburban 30 km scan holds tens of thousands
 * of ways whose vertex lists would be an order of magnitude more memory for no extra answer.
 *
 * The grid, rather than a linear scan, because of the query count: `cleanliness` wants a density at
 * every 400 m window of every candidate road, which is hundreds to thousands of lookups per scan
 * against a corpus measured at 1,888 ways in 12.6 km² of suburbia. It is an INDEXING change and not
 * an approximation — the swept cell window strictly contains the query disc and every candidate
 * still gets an exact haversine test, so the count is identical to brute force.
 */
export interface BuiltIndex {
  /** One representative point per way, in query order. `pts.length` is the way count. */
  pts: LatLng[];
  /** Cell key `"i,j"` → the representative points falling in that cell. Empty below
   *  {@link GRID_MIN} ways, where {@link builtDensityNear} scans `pts` directly. */
  cells: Map<string, LatLng[]>;
  /** Cell edge in degrees. Stored so a query reproduces the exact cell coordinates the index was
   *  built with — recomputing them from the query point's own latitude would not. */
  dLat: number;
  dLon: number;
}

/**
 * Index a list of representative points. `lat0` only sets the longitudinal cell WIDTH, so it can be
 * the mean latitude: cells need to be roughly square, not exactly square.
 */
function buildIndex(pts: LatLng[]): BuiltIndex {
  let latSum = 0;
  for (const p of pts) latSum += p[0];
  const lat0 = pts.length ? latSum / pts.length : 0;
  const dLat = CELL_M / M_PER_DEG_LAT;
  const dLon = CELL_M / (M_PER_DEG_LAT * Math.max(0.05, Math.cos((lat0 * Math.PI) / 180)));

  const cells = new Map<string, LatLng[]>();
  if (pts.length >= GRID_MIN) {
    for (const p of pts) {
      const key = `${Math.floor(p[0] / dLat)},${Math.floor(p[1] / dLon)}`;
      let bucket = cells.get(key);
      if (!bucket) cells.set(key, (bucket = []));
      bucket.push(p);
    }
  }
  return { pts, cells, dLat, dLon };
}

/**
 * Reduce raw Overpass elements to a {@link BuiltIndex}: one point per `highway=residential|service`
 * way. Non-way elements and ways without usable geometry are skipped rather than counted at a
 * fallback position — a way we cannot place is a way we cannot attribute to a window, and inventing
 * a position for it would move a density somewhere.
 *
 * The representative point is the MIDDLE vertex, not the first. A residential way is one street
 * block, so any of its vertices is within ~100 m of the rest and the choice barely registers at the
 * ≥400 m radii cleanliness asks about; but `service` also covers long alleys, farm tracks and
 * driveways, where the first vertex sits at one end and the middle one does not.
 *
 * One point per WAY, never per vertex: the measured series that calibrates this signal is a way
 * count, and weighting by vertices would weight by how finely each street happens to have been
 * traced, which is a mapper artifact rather than a property of the place.
 */
export function countBuiltWays(elements: OverpassElement[]): BuiltIndex {
  const pts: LatLng[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const verts = el.geometry.filter((g) => g && Number.isFinite(g.lat) && Number.isFinite(g.lon));
    if (!verts.length) continue;
    const mid = verts[verts.length >> 1];
    pts.push([mid.lat, mid.lon]);
  }
  return buildIndex(pts);
}

/**
 * Built-up ways per km² within `radiusM` of `pt`.
 *
 * Divided by the ACTUAL disc area so the result is comparable across query radii and against
 * {@link import('./reelTypes').FULL_BUILT_DENSITY}, rather than being a raw count that silently
 * means something different at every radius.
 *
 * CALIBRATION — this function is the reason `FULL_BUILT_DENSITY` is 48 and not 600, so the
 * arithmetic is recorded here as well as on the constant. The seven-site series behind that
 * constant (1888 / 1609 / … / 13) is a series of raw COUNTS, and on the one occasion an area was
 * recorded alongside a count it was 1,888 ways in 12.6 km² — i.e. 150 ways/km². 12.6 km² is exactly
 * the area of a 2 km-radius disc (pi * 2² = 12.57), so the series in the units THIS function returns
 * is 150 down to 1.0 ways/km². A live count on 2026-08-02 agrees on the order: 1,094
 * `residential|service` ways within 2 km of the app's home point in suburban Amherst = 87 ways/km².
 *
 * Nothing in this function changed; the constant it is compared against did. Do not "fix" a future
 * reading that looks small by raising the constant back — 150 ways/km² IS the densest suburbia ever
 * measured here, and a saturation point above it means the penalty can never saturate at all.
 *
 * Two honest limits on the number itself. Within `radiusM` of the edge of the queried disc the
 * count is truncated, because ways beyond the query radius were never fetched, so density there is
 * under-reported; and a representative point is a point, so a way that merely reaches into the disc
 * is counted only if its middle vertex does.
 */
export function builtDensityNear(index: BuiltIndex, pt: LatLng, radiusM: number): number {
  if (radiusM <= 0 || !index.pts.length) return 0;

  const areaKm2 = Math.PI * (radiusM / 1000) ** 2;
  let n = 0;

  if (!index.cells.size) {
    for (const p of index.pts) if (haversine(pt, p) * 1000 <= radiusM) n++;
    return n / areaKm2;
  }

  // Degree half-spans that bound the disc. The longitudinal one uses the cosine at the POLE-WARD
  // edge of the latitude span, which is the smallest cosine anywhere in the window and therefore
  // the widest (conservative) span — the window must strictly contain the disc for the exact
  // haversine pass below to be a filter rather than a second approximation.
  const latSpan = radiusM / M_PER_DEG_LAT;
  const cosMin = Math.max(0.05, Math.cos(((Math.abs(pt[0]) + latSpan) * Math.PI) / 180));
  const lonSpan = radiusM / (M_PER_DEG_LAT * cosMin);

  const iLo = Math.floor((pt[0] - latSpan) / index.dLat);
  const iHi = Math.floor((pt[0] + latSpan) / index.dLat);
  const jLo = Math.floor((pt[1] - lonSpan) / index.dLon);
  const jHi = Math.floor((pt[1] + lonSpan) / index.dLon);

  for (let i = iLo; i <= iHi; i++) {
    for (let j = jLo; j <= jHi; j++) {
      const bucket = index.cells.get(`${i},${j}`);
      if (!bucket) continue;
      for (const p of bucket) if (haversine(pt, p) * 1000 <= radiusM) n++;
    }
  }
  return n / areaKm2;
}

/**
 * Built-up indexes per scanned area, keyed by center+radius — bounded and LRU-evicted exactly like
 * `featureCache` in features.ts, so a long session cannot grow it without limit.
 */
const builtCache = new Map<string, BuiltIndex>();
const BUILT_CACHE_CAP = 16;

/** Drop all cached built-up indexes (used by tests; harmless to call at runtime). */
export function clearBuiltCache(): void {
  builtCache.clear();
}

/**
 * Fetch and index the built-up ways within `radiusKm` of `center`. One request, cached per
 * center+radius. Returns `null` on failure instead of throwing.
 *
 * THE HONEST COST: this is not cheap in the way that matters. Overpass wall time is near-constant
 * dispatch overhead — measured 24.4 s for a 1.9 MB response against 34.9 s for a 55 MB one — so
 * asking for this adds ~20–25 s to a scan that otherwise resolves from precomputed tiles in about a
 * second. That is precisely why the caller runs it in the BACKGROUND and refines an already-ranked
 * result, rather than blocking the ranking on it.
 *
 * Which is also why failure returns `null` rather than throwing: `cleanliness` has a junction-density
 * proxy over `AreaScan.corpus` that is free and always available, so a failed query must degrade the
 * score's PRECISION (`CleanReading.provisional` stays true) and must never break the ranking. An
 * aborted scan lands here too, and null is the right answer there as well — there is nothing left to
 * refine.
 *
 * A failure is deliberately NOT cached: it is usually a loaded mirror rather than a property of the
 * area, and caching it would permanently deny that area its refinement for the rest of the session.
 * A genuinely empty result IS cached — rural areas really do return almost no built-up ways, and
 * `fetchOverpass` already separates that from a runtime timeout dressed up as an empty response.
 */
export async function fetchBuiltIndex(
  center: LatLng,
  radiusKm: number,
  signal?: AbortSignal,
): Promise<BuiltIndex | null> {
  const key = `${center[0]},${center[1]},${radiusKm}`;

  const cached = builtCache.get(key);
  if (cached) {
    // Refresh recency (cheap LRU) so a hot area survives eviction.
    builtCache.delete(key);
    builtCache.set(key, cached);
    return cached;
  }

  try {
    const query = buildBuiltUpQuery(center, Math.round(radiusKm * 1000));
    const data = await fetchOverpass(query, signal);
    const index = countBuiltWays(data.elements ?? []);
    builtCache.set(key, index);
    if (builtCache.size > BUILT_CACHE_CAP) builtCache.delete(builtCache.keys().next().value!);
    return index;
  } catch {
    return null;
  }
}
