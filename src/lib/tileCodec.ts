// Wire format + grid math for the precomputed road/scenic tile corpus.
//
// Shared by the browser (src/lib/tileSource.ts) and the build-time crawler
// (scripts/build-tiles.mjs) so an encoder change can never desync from the decoder.
//
// Why delta-encoded integers and NOT golfed key names: gzip (which GitHub Pages applies to text
// on the fly) compresses repeated JSON key names almost to nothing, so shortening them buys ~0 and
// costs readability. What gzip CANNOT compress is thousands of high-entropy absolute coordinates
// like -78.500456. Quantizing to a fixed grid and storing deltas turns those into small integers
// that both shrink outright and compress well. That is the entire size lever.

import type { LatLng } from './geometry';

/**
 * Version of the wire format described below. scripts/build-tiles.mjs stamps this number into every
 * tile and into the manifest; the reader (tileSource.ts) checks it before decoding anything.
 *
 * Bumping it is what invalidates a stale cache, and the reason the guard exists at all is that the
 * failure without it is invisible. Tiles are ordinary static files on GitHub Pages, so a browser can
 * hold one from the previous corpus indefinitely. Decoded against a reader whose fields have since
 * moved, it reaches `decodePath(undefined)` and throws a TypeError three frames deep, which
 * areaSource.ts's blanket catch turns into a permanent fallback to Overpass: every scan for the rest
 * of the session takes ~25 s instead of ~1 s, with a single console.warn to show for it. A version
 * mismatch has to fail ON the version, where the message can say so.
 *
 * Bump this for any change that makes an old tile undecodable — a renamed or removed field, a
 * different encoding, a changed array pairing. Adding a field the reader already treats as optional
 * does not need a bump; removing one always does.
 *
 * The writer's half of that failure is symmetric and was live until 2026-08-02: build-tiles.mjs used
 * to stamp the literal `1` into each tile and the manifest, so bumping this constant alone would
 * have branded a freshly rebuilt corpus with the OLD version and made every scan in the app fall
 * back. It now imports scripts/lib/tile-codec.mjs's TILE_FORMAT_V, and since Node cannot import this
 * TS module, src/lib/tileSource.test.ts reads that file from disk and asserts the two numbers agree.
 * Bump BOTH, or that test goes red.
 */
export const TILE_FORMAT_V = 1;

/** Quantization step in degrees (~1.1 m at NY latitudes). Matches elevation.ts's round5, and is far
 *  finer than the curvature metrics can resolve — sinuosityScore works on segments of 100s of m. */
export const QUANT = 1e-5;
const SCALE = 1 / QUANT; // 100000

/** Grid cell size in degrees. 0.5 deg is ~55km x 40km at NY latitudes, so a 30km-radius scan (the
 *  slider's max, App.tsx) touches a handful of tiles rather than dozens. */
export const TILE_DEG = 0.5;

/**
 * Quantize + delta-encode a polyline into a flat integer array: `[lat0, lon0, dLat1, dLon1, ...]`.
 *
 * Deltas are taken against the ROUNDED running position, not the original coordinate, so decode
 * reproduces the encoder's own path exactly and error cannot accumulate over a long way.
 */
export function encodePath(coords: LatLng[]): number[] {
  const out: number[] = [];
  let prevLat = 0;
  let prevLon = 0;
  for (let i = 0; i < coords.length; i++) {
    const lat = Math.round(coords[i][0] * SCALE);
    const lon = Math.round(coords[i][1] * SCALE);
    out.push(i === 0 ? lat : lat - prevLat, i === 0 ? lon : lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return out;
}

/** Inverse of {@link encodePath}. */
export function decodePath(enc: number[]): LatLng[] {
  const out: LatLng[] = [];
  let lat = 0;
  let lon = 0;
  for (let i = 0; i + 1 < enc.length; i += 2) {
    if (i === 0) {
      lat = enc[0];
      lon = enc[1];
    } else {
      lat += enc[i];
      lon += enc[i + 1];
    }
    out.push([lat / SCALE, lon / SCALE]);
  }
  return out;
}

/**
 * Grid indices for a coordinate. Uses `Math.floor`, which is what makes the western hemisphere
 * work: `Math.trunc(-78.0 / 0.5)` and `Math.trunc(-77.99 / 0.5)` both give -155, silently merging
 * two distinct tiles, whereas floor keeps them apart.
 */
export function tileIndex(lat: number, lon: number): [number, number] {
  return [Math.floor(lat / TILE_DEG), Math.floor(lon / TILE_DEG)];
}

/** Filename-safe tile key. Negative indices keep their sign (`t_85_-157`). */
export function tileKey(latIdx: number, lonIdx: number): string {
  return `t_${latIdx}_${lonIdx}`;
}

/** South-west corner + bbox of a tile, as `[s, w, n, e]`. */
export function tileBounds(latIdx: number, lonIdx: number): [number, number, number, number] {
  const s = latIdx * TILE_DEG;
  const w = lonIdx * TILE_DEG;
  return [s, w, s + TILE_DEG, w + TILE_DEG];
}

/**
 * Margin (km) added around a scan's bounding box when choosing tiles.
 *
 * Ways are assigned whole to the tile containing their MIDPOINT (never clipped — a split polyline
 * corrupts sinuosityScore), so a road running inside the scan radius can legitimately be stored in
 * a neighbouring tile. The margin must therefore exceed HALF the longest way, or such roads
 * silently vanish from the scan — the worst kind of bug, because the result still looks plausible.
 *
 * Sized from measurement, then corrected by one. The WNY spike tile (568 ways) had a longest way of
 * 14.4km (p99 10.0km, median 1.6km), suggesting 12km was ample — but crawling the rest of the state
 * turned up a 25.9km way in the Southern Tier, which the build assertion caught. 25 covers ways up
 * to 50km. scripts/build-tiles.mjs ASSERTS no way exceeds 2x this, so if a longer one ever appears
 * the build fails loudly instead of quietly degrading scans; that assertion is the reason this
 * number is trustworthy rather than a guess that happened to hold on the tile I sampled.
 *
 * Raising it does not invalidate built tiles — it only affects which tiles a scan loads.
 *
 * (An earlier version padded by a whole tile. At 0.5deg that is 40-55km — it made a 30km scan load
 * up to 20 tiles for no correctness gain.)
 */
export const MARGIN_KM = 25;

/** Tiles intersecting a box of `reachKm` around the point. */
function tilesWithin(lat: number, lon: number, reachKm: number): [number, number][] {
  const dLat = reachKm / 111;
  const dLon = reachKm / (111 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const [sLat, sLon] = tileIndex(lat - dLat, lon - dLon);
  const [nLat, nLon] = tileIndex(lat + dLat, lon + dLon);

  const tiles: [number, number][] = [];
  for (let a = sLat; a <= nLat; a++) {
    for (let b = sLon; b <= nLon; b++) tiles.push([a, b]);
  }
  return tiles;
}

/**
 * Tiles a scan REQUIRES — those overlapping the scanned radius itself.
 *
 * If any of these is missing the corpus cannot answer the scan honestly: the result would look
 * normal while omitting whole sectors of the circle. Callers treat a gap here as a hard miss and
 * fall back to Overpass. (Coverage is a state outline, not the grid rectangle, so a scan just
 * outside NY genuinely does hit this.)
 */
export function tilesForRadius(lat: number, lon: number, radiusKm: number): [number, number][] {
  return tilesWithin(lat, lon, radiusKm);
}

/**
 * Every tile a scan should LOAD — the required set plus {@link MARGIN_KM} of neighbours holding
 * ways whose midpoints fall outside the radius. Margin tiles are best-effort: a missing one costs
 * a few edge roads, not the integrity of the scan.
 */
export function tilesForBounds(lat: number, lon: number, radiusKm: number): [number, number][] {
  return tilesWithin(lat, lon, radiusKm + MARGIN_KM);
}
