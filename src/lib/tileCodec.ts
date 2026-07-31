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
 * Measured on the WNY spike tile (568 ways): longest 14.4km, p99 10.0km, median 1.6km. Half the
 * longest is ~7.2km, so 12km covers ways up to 24km with real headroom. scripts/build-tiles.mjs
 * ASSERTS no way exceeds 2x this, so a longer way anywhere in the grid fails the build loudly
 * instead of quietly degrading scans.
 *
 * (An earlier version padded by a whole tile. At 0.5deg that is 40-55km — it made a 30km scan load
 * up to 20 tiles instead of 6, for no correctness gain.)
 */
export const MARGIN_KM = 12;

/** Every tile a scan of `radiusKm` around `center` must load, including {@link MARGIN_KM}. */
export function tilesForBounds(lat: number, lon: number, radiusKm: number): [number, number][] {
  const padded = radiusKm + MARGIN_KM;
  const dLat = padded / 111;
  const dLon = padded / (111 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const [sLat, sLon] = tileIndex(lat - dLat, lon - dLon);
  const [nLat, nLon] = tileIndex(lat + dLat, lon + dLon);

  const tiles: [number, number][] = [];
  for (let a = sLat; a <= nLat; a++) {
    for (let b = sLon; b <= nLon; b++) tiles.push([a, b]);
  }
  return tiles;
}
