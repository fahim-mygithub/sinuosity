// Build-time twin of src/lib/tileCodec.ts — the encoder half of the tile wire format.
//
// The app decodes with the TS module; this script encodes with this one. A desync between them
// would silently produce garbage geometry, so src/lib/tileCodec.test.ts contains a PARITY test
// that runs both implementations over the same inputs and asserts identical output. If you change
// one, change the other or that test goes red.
//
// (The project already duplicates src/lib/sceneryTells.ts into scripts/lib/scenery-tells.mjs for
// the same Node-cannot-import-TS reason; this follows that convention but adds the parity guard,
// because a wire format desyncs far more destructively than a metric does.)

/**
 * Wire format version stamped into every tile and into manifest.json. Twin of tileCodec.ts's
 * TILE_FORMAT_V; see there for what warrants a bump.
 *
 * It lives HERE, next to the encoder, rather than as a literal in build-tiles.mjs, because the
 * writer and the reader fail symmetrically. The reader rejecting a stale tile is the bug the guard
 * was written for; the WRITER stamping a stale number is just as bad and less visible — bump the TS
 * constant for a real format change, miss the script, rebuild, and every tile ships branded with the
 * old version, so every scan throws TileMissError, areaSource.ts's blanket catch swallows it, and
 * the app falls back to a ~25s Overpass query for the rest of the session behind one console.warn.
 *
 * Node cannot import the TS, so the two files cannot share a definition. src/lib/tileSource.test.ts
 * reads this file and asserts the numbers match — that test is the only thing standing between the
 * two, so do not delete it when moving this constant.
 */
export const TILE_FORMAT_V = 1;

export const QUANT = 1e-5;
const SCALE = 1 / QUANT;
export const TILE_DEG = 0.5;

/** Scan-time tile margin (km). See tileCodec.ts — build-tiles.mjs asserts no way exceeds 2x this. */
export const MARGIN_KM = 25;

/** Quantize + delta-encode a polyline to `[lat0, lon0, dLat1, dLon1, ...]`. */
export function encodePath(coords) {
  const out = [];
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

/** Inverse of {@link encodePath} (used by the builder's own round-trip assertion). */
export function decodePath(enc) {
  const out = [];
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

/** Grid indices for a coordinate. Math.floor, not trunc — see tileCodec.ts. */
export function tileIndex(lat, lon) {
  return [Math.floor(lat / TILE_DEG), Math.floor(lon / TILE_DEG)];
}

/** Filename-safe tile key. */
export function tileKey(latIdx, lonIdx) {
  return `t_${latIdx}_${lonIdx}`;
}

/** Tile bbox as `[s, w, n, e]`. */
export function tileBounds(latIdx, lonIdx) {
  const s = latIdx * TILE_DEG;
  const w = lonIdx * TILE_DEG;
  return [s, w, s + TILE_DEG, w + TILE_DEG];
}
