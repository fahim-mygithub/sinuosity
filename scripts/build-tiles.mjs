// Precomputed road/scenic tile builder — the batch job that replaces runtime Overpass for the
// Scan tab. See docs/plans/2026-07-31-precomputed-tiles-design.md.
//
// Crawls a 0.5-degree grid, and for each tile writes public/tiles/t_{latIdx}_{lonIdx}.json holding
// the full road corpus (geometry + baked curvature + baked rubric), the categorized scenic tells,
// and the POIs. The browser (src/lib/tileSource.ts) decodes these into exactly the AreaScan shape
// the Overpass path returns.
//
// Two subtleties that are easy to get wrong and expensive to debug:
//
//   1. Ways are NEVER clipped at tile edges — a split polyline corrupts sinuosityScore, which is
//      the app's entire differentiator. Each way is assigned whole to the tile containing its
//      MIDPOINT. Overpass `way(bbox)` + `out geom` returns the complete geometry of any way with a
//      node in the bbox, so a way straddling a boundary comes back intact from both tiles and is
//      simply stored once, in the tile its midpoint falls in.
//
//   2. Rubric is measured against a PADDED tells set (tile + PAD_DEG), because corridor signals
//      reach up to 1.5km (TAU.peak) past a road. Only tells whose representative point is inside
//      the tile are STORED, so neighbouring tiles do not duplicate them; the client loads a
//      one-tile margin, which covers the same reach at scan time.
//
// Resumable: an existing tile file is skipped unless --force, so a rate-limited crawl can be
// re-run rather than restarted.
//
// Usage:
//   node scripts/build-tiles.mjs                       # fill in missing tiles only
//   node scripts/build-tiles.mjs --only 85,-157        # one tile (the spike)
//   node scripts/build-tiles.mjs --force               # rebuild every tile
//   node scripts/build-tiles.mjs --refresh-oldest 40   # re-crawl the 40 stalest tiles
//   node scripts/build-tiles.mjs --dry-run             # measure sizes, write nothing

import { writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { encodePath, decodePath, tileIndex, tileKey, tileBounds, TILE_DEG, MARGIN_KM } from './lib/tile-codec.mjs';
import { categorizeFeatures } from './lib/feature-catalog.mjs';
import { measureRubric } from './lib/scenery-tells.mjs';
import { sinuosityScore, flowCurvature, pathLengthKm, haversineM } from './lib/scenic-metrics.mjs';

const OUT_DIR = fileURLToPath(new URL('../public/tiles/', import.meta.url));

/** NY State, per the design doc. Outside this the app falls back to live Overpass. */
const GRID = { s: 40.5, w: -79.8, n: 45.0, e: -71.8 };

/** Degrees of pad around a tile when fetching tells. TAU.peak is 1500m; 0.02deg is ~2.2km. */
const PAD_DEG = 0.02;

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'Sinuosity/2.0 tile builder (scenic ride finder; contact: github.com/fahim-mygithub/sinuosity)',
};

/** Server budget for a batch crawl. Far above the app's 45s: nobody is waiting on this, and a
 *  tile-sized bbox query is heavier than a 30km radial one. */
const SERVER_TIMEOUT_S = 180;
const CLIENT_TIMEOUT_MS = 200000;

/** Candidate gate — mirrors overpass.ts scanArea. Roads below this never get a baked rubric (the
 *  ~300-road cap is NOT applied here: it must happen at scan time, across the merged tile set). */
const MIN_LENGTH_KM = 0.5;
const MIN_CURVE_DENSITY = 0.12;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

async function overpass(query, label) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const ep = MIRRORS[attempt % MIRRORS.length];
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch(ep, { method: 'POST', headers: HEADERS, body: 'data=' + encodeURIComponent(query), signal: ctl.signal });
      clearTimeout(to);
      if (!res.ok) { lastErr = `HTTP ${res.status}`; await sleep(3000 * (attempt + 1)); continue; }
      const j = await res.json();
      if (j.remark && /timed out|runtime error|rate_limited|too many|busy/i.test(j.remark)) {
        lastErr = j.remark; await sleep(5000 * (attempt + 1)); continue;
      }
      return j.elements || [];
    } catch (e) {
      clearTimeout(to);
      lastErr = String(e.name || e);
      await sleep(3000 * (attempt + 1));
    }
  }
  console.warn(`  [${label}] FAILED after retries: ${lastErr}`);
  return null;
}

const roadsQuery = (s, w, n, e) =>
  `[out:json][timeout:${SERVER_TIMEOUT_S}];` +
  `way["highway"~"^(secondary|tertiary|unclassified)$"](${s},${w},${n},${e});out geom;`;

/** Mirrors src/lib/features.ts buildTellsQuery, as a bbox instead of a radial selector. */
const tellsQuery = (s, w, n, e) => {
  const b = `${s},${w},${n},${e}`;
  return (
    `[out:json][timeout:${SERVER_TIMEOUT_S}];(` +
    `nwr["tourism"="viewpoint"](${b});` +
    `nwr["natural"~"^(peak|cliff)$"](${b});` +
    `way["natural"="water"](${b});relation["natural"="water"](${b});` +
    `way["natural"="coastline"](${b});` +
    `way["waterway"~"^(river|stream|canal)$"](${b});` +
    `nwr["natural"="wood"](${b});` +
    `way["landuse"="forest"](${b});relation["landuse"="forest"](${b});` +
    `nwr["leisure"~"^(park|nature_reserve)$"](${b});` +
    `nwr["boundary"~"^(national_park|protected_area)$"](${b});` +
    `way["landuse"~"^(industrial|retail|commercial|quarry|landfill)$"](${b});` +
    `nwr["man_made"="works"](${b});` +
    `);out geom;`
  );
};

const UNPAVED = new Set(['unpaved', 'compacted', 'dirt', 'gravel', 'fine_gravel', 'sand', 'grass', 'ground', 'pebblestone', 'mud', 'clay', 'earth', 'soil']);
/** Mirrors src/lib/geometry.ts isPaved: undefined stays undefined (unknown != unpaved). */
const isPaved = (surface) => (surface === undefined ? undefined : !UNPAVED.has(surface));

/** Mirrors src/lib/geometry.ts parseMaxspeedMph. */
function parseMaxspeedMph(v) {
  if (!v) return undefined;
  const mph = /mph/i.test(v);
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(mph ? n : n * 0.621371);
}

/** Geometric midpoint (by vertex index) of a way — decides which tile owns it. */
const midpointOf = (pts) => pts[Math.floor(pts.length / 2)];

/** Representative point of a categorized tell/POI entry. */
const inTile = (pt, [s, w, n, e]) => pt[0] >= s && pt[0] < n && pt[1] >= w && pt[1] < e;

async function buildTile(latIdx, lonIdx, opts) {
  const key = tileKey(latIdx, lonIdx);
  const outPath = `${OUT_DIR}${key}.json`;
  if (!opts.force && !opts.dryRun && existsSync(outPath)) return { key, skipped: true };

  const [s, w, n, e] = tileBounds(latIdx, lonIdx);
  const pad = [s - PAD_DEG, w - PAD_DEG, n + PAD_DEG, e + PAD_DEG];

  const [roadEls, tellEls] = await Promise.all([
    overpass(roadsQuery(s, w, n, e), `${key} roads`),
    overpass(tellsQuery(...pad), `${key} tells`),
  ]);
  if (roadEls === null || tellEls === null) return { key, failed: true };

  // --- roads: keep only ways this tile OWNS (midpoint inside), never clipped ------------------
  const roads = [];
  for (const el of roadEls) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length <= 3) continue;
    const pts = el.geometry.map((g) => [g.lat, g.lon]);
    if (!inTile(midpointOf(pts), [s, w, n, e])) continue;
    const surface = el.tags?.surface;
    roads.push({
      id: el.id,
      name: el.tags?.name,
      ref: el.tags?.ref,
      highway: el.tags?.highway,
      surface,
      maxspeedMph: parseMaxspeedMph(el.tags?.maxspeed),
      paved: isPaved(surface),
      oneway: el.tags?.oneway,
      curveDensity: sinuosityScore(pts),
      geom: encodePath(pts),
      _pts: pts,
    });
  }

  // --- tells: measured against the PADDED set, stored only for this tile ----------------------
  const padded = categorizeFeatures(tellEls);
  const viewPts = padded.pois.filter((p) => p.kind === 'viewpoint' && (p.notable || !!p.name)).map((p) => p.pt);

  let baked = 0;
  for (const r of roads) {
    if (pathLengthKm(r._pts) < MIN_LENGTH_KM || r.curveDensity < MIN_CURVE_DENSITY) continue;
    let viewMinM = Infinity;
    for (const c of r._pts) for (const v of viewPts) {
      const d = haversineM(c, v);
      if (d < viewMinM) viewMinM = d;
    }
    const m = measureRubric(r._pts, { ...padded.tells, viewMinM });
    r.rubric = {
      curvature: flowCurvature(r._pts),
      scenery: m.scenery, greenery: m.greenery, water: m.water, notability: m.notability,
    };
    baked++;
  }
  for (const r of roads) delete r._pts;

  const own = {
    waterPts: padded.tells.waterPts.filter((t) => inTile(t.pt, [s, w, n, e])),
    waterAreas: padded.tells.waterAreas.filter((ring) => inTile(ring[0], [s, w, n, e])),
    greenAreas: padded.tells.greenAreas.filter((ring) => inTile(ring[0], [s, w, n, e])),
    greenPts: padded.tells.greenPts.filter((p) => inTile(p, [s, w, n, e])),
    uglyAreas: padded.tells.uglyAreas.filter((ring) => inTile(ring[0], [s, w, n, e])),
    uglyPts: padded.tells.uglyPts.filter((p) => inTile(p, [s, w, n, e])),
    view: padded.tells.view.filter((p) => inTile(p, [s, w, n, e])),
    peak: padded.tells.peak.filter((p) => inTile(p, [s, w, n, e])),
    notable: padded.tells.notable.filter((t) => inTile(t.pt, [s, w, n, e])),
  };

  const tile = {
    v: 1,
    bbox: [s, w, n, e],
    roads,
    tells: {
      // Weighted point sets are stored as ONE delta-encoded sequence plus a parallel weight array,
      // never as per-point `encodePath([pt])`. Encoding each point on its own emits an absolute
      // coordinate pair every time and defeats the whole scheme: measured on this tile, 21.5k
      // per-point water entries cost 485KB while 12.7k sequence-encoded green points cost 44KB.
      waterPts: { pts: encodePath(own.waterPts.map((t) => t.pt)), w: own.waterPts.map((t) => t.w) },
      waterAreas: own.waterAreas.map(encodePath),
      greenAreas: own.greenAreas.map(encodePath),
      greenPts: encodePath(own.greenPts),
      uglyAreas: own.uglyAreas.map(encodePath),
      uglyPts: encodePath(own.uglyPts),
      view: encodePath(own.view),
      peak: encodePath(own.peak),
      notable: { pts: encodePath(own.notable.map((t) => t.pt)), w: own.notable.map((t) => t.w) },
    },
    pois: (() => {
      const own_ = padded.pois.filter((p) => inTile(p.pt, [s, w, n, e]));
      return {
        pts: encodePath(own_.map((p) => p.pt)),
        meta: own_.map((p) => ({ name: p.name, kind: p.kind, notable: p.notable, source: p.source, weight: p.weight })),
      };
    })(),
  };

  // Round-trip assertion: a codec bug must fail the BUILD, not ship geometry that decodes to junk.
  if (roads.length) {
    const back = decodePath(roads[0].geom);
    if (back.length * 2 !== roads[0].geom.length) throw new Error(`${key}: geometry round-trip length mismatch`);
  }

  // Margin assertion. Ways are owned by the tile holding their midpoint, so the scan-time margin
  // must exceed HALF the longest way or roads inside the radius silently vanish from results. Fail
  // the build rather than ship a corpus that quietly under-reports.
  const longest = roads.reduce((mx, r) => Math.max(mx, pathLengthKm(decodePath(r.geom))), 0);
  if (longest > 2 * MARGIN_KM) {
    throw new Error(
      `${key}: way of ${longest.toFixed(1)}km exceeds 2x MARGIN_KM (${2 * MARGIN_KM}km). ` +
      `Raise MARGIN_KM in tileCodec.ts AND tile-codec.mjs, or scans will miss this road.`,
    );
  }

  const json = JSON.stringify(tile);
  const gz = gzipSync(json).length;
  if (!opts.dryRun) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(outPath, json);
  }
  return { key, roads: roads.length, baked, pois: tile.pois.meta.length, bytes: json.length, gz };
}

/**
 * The `refreshOldest` slice: the N stalest existing tiles, oldest first.
 *
 * Without this the scheduled rebuild is a no-op the moment the grid is complete — every tile
 * already exists, so every tile is skipped, and the corpus silently ages forever. Forcing a FULL
 * rebuild instead would rewrite all 170 tiles every month, which for a corpus committed to git
 * means the repo grows by the whole corpus each time. Rotating a slice keeps the data moving
 * without that churn: at 40/month the grid fully refreshes about every four months.
 */
function stalestTiles(cells, n) {
  return cells
    .map(([a, b]) => ({ cell: [a, b], path: `${OUT_DIR}${tileKey(a, b)}.json` }))
    .filter((t) => existsSync(t.path))
    .map((t) => ({ ...t, mtime: statSync(t.path).mtimeMs }))
    .sort((x, y) => x.mtime - y.mtime)
    .slice(0, n)
    .map((t) => t.cell);
}

(async () => {
  const opts = { force: has('--force'), dryRun: has('--dry-run') };
  const only = argVal('--only');
  const refreshOldest = Number(argVal('--refresh-oldest')) || 0;

  let cells = [];
  if (only) {
    const [a, b] = only.split(',').map(Number);
    cells = [[a, b]];
  } else {
    const [sLat, sLon] = tileIndex(GRID.s, GRID.w);
    const [nLat, nLon] = tileIndex(GRID.n, GRID.e);
    for (let a = sLat; a <= nLat; a++) for (let b = sLon; b <= nLon; b++) cells.push([a, b]);
  }

  if (refreshOldest) {
    const stale = stalestTiles(cells, refreshOldest);
    const missing = cells.filter(([a, b]) => !existsSync(`${OUT_DIR}${tileKey(a, b)}.json`));
    // Missing tiles always win a slot — a hole in coverage matters more than a stale tile.
    cells = [...missing, ...stale];
    opts.force = true;
    console.log(`refresh mode: ${missing.length} missing + ${stale.length} stalest`);
  }

  console.log(`Building ${cells.length} tile(s) at ${TILE_DEG}deg${opts.dryRun ? ' (dry run)' : ''}`);
  let totalGz = 0, built = 0, skipped = 0, failed = 0;
  const t0 = Date.now();

  for (const [a, b] of cells) {
    const r = await buildTile(a, b, opts);
    if (r.skipped) { skipped++; continue; }
    if (r.failed) { failed++; continue; }
    built++;
    totalGz += r.gz;
    console.log(
      `  ${r.key}  roads ${String(r.roads).padStart(5)}  rubric ${String(r.baked).padStart(5)}` +
      `  pois ${String(r.pois).padStart(4)}  ${(r.bytes / 1024).toFixed(0)}KB -> ${(r.gz / 1024).toFixed(0)}KB gz`,
    );
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\nbuilt ${built}, skipped ${skipped}, failed ${failed} in ${mins} min`);
  console.log(`total ${(totalGz / 1024 / 1024).toFixed(2)} MB gzipped`);
  if (built && cells.length > built) {
    console.log(`projected full grid: ~${((totalGz / built) * cells.length / 1024 / 1024).toFixed(1)} MB gzipped`);
  }
  if (failed) process.exitCode = 1;
})();
