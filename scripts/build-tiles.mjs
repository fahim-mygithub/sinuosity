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
//   node scripts/build-tiles.mjs --prune               # delete tiles outside NY, crawl nothing

import { writeFileSync, existsSync, mkdirSync, statSync, readdirSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { encodePath, decodePath, tileIndex, tileKey, tileBounds, TILE_DEG, MARGIN_KM, TILE_FORMAT_V } from './lib/tile-codec.mjs';
import { categorizeFeatures } from './lib/feature-catalog.mjs';
import { measureRubric } from './lib/scenery-tells.mjs';
import { sinuosityScore, flowCurvature, pathLengthKm, haversineM } from './lib/scenic-metrics.mjs';

const OUT_DIR = fileURLToPath(new URL('../public/tiles/', import.meta.url));

/** Bounding rectangle of the covered region. Tiles are then clipped to {@link NY_OUTLINE}. */
const GRID = { s: 40.5, w: -79.8, n: 45.0, e: -71.8 };

/**
 * The region actually precomputed: New York State, MINUS the New York City metro and Long Island.
 *
 * Two separate reasons, both about size:
 *
 * 1. NY is an irregular shape inside a 4.5deg x 8deg box, so the raw grid rectangle is roughly half
 *    out-of-state. The parts it wasted effort on were the worst possible ones — dense Philadelphia
 *    and northern-NJ tiles measured 2.3-3.4MB raw (573-980KB gzipped) against 178KB for a rural WNY
 *    tile — while containing nothing this app looks for.
 *
 * 2. The southern boundary stops around 41.25 rather than following the real state line. NYC, Staten
 *    Island and Long Island are genuinely New York, but they hold no twisty backroads and are by far
 *    the most expensive tiles to carry: the Staten Island tile measured 10,247 ways, 7.7MB raw and
 *    2.1MB gzipped. A handful of them would dominate the committed corpus in order to serve scans
 *    that return nothing anyone wants to ride.
 *
 * Neither is a capability loss — scans in those areas still work, they just take the Overpass
 * fallback like anywhere else outside the corpus. Coverage is published in manifest.json so the
 * client never has to guess where it ends.
 *
 * Deliberately coarse and inclusive along the rest: a tile is kept if it touches the outline at all,
 * so border tiles carry some PA/VT/Ontario collateral. That matches discover-roads.mjs, which
 * accepts near-border roads rather than risk clipping real NY ones.
 */
const NY_OUTLINE = [
  [42.00, -79.76], [42.52, -79.76], [42.87, -78.91], [43.07, -79.06], [43.37, -78.00],
  [43.35, -77.00], [43.28, -76.50], [43.80, -76.20], [44.13, -76.37], [44.60, -75.40],
  [44.99, -74.72], [45.01, -73.35], [43.60, -73.43], [42.75, -73.27], [42.05, -73.49],
  [41.30, -73.48], [41.25, -74.30], [41.35, -74.70], [41.60, -75.05], [42.00, -75.36],
];

/** Ray-cast point-in-polygon (same method as scenery-tells pointInRing). */
function inPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if ((yi > pt[0]) !== (yj > pt[0]) && pt[1] < ((xj - xi) * (pt[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Does this tile touch New York? Samples the tile's interior AND checks whether any outline vertex
 * falls inside it — the second test is what catches narrow protrusions (the Niagara frontier, the
 * eastern tip of Long Island) that a coarse interior sample can step straight over.
 */
function tileTouchesNY(latIdx, lonIdx) {
  const [s, w, n, e] = tileBounds(latIdx, lonIdx);
  const STEPS = 6;
  for (let a = 0; a <= STEPS; a++) {
    for (let b = 0; b <= STEPS; b++) {
      if (inPolygon([s + ((n - s) * a) / STEPS, w + ((e - w) * b) / STEPS], NY_OUTLINE)) return true;
    }
  }
  return NY_OUTLINE.some(([la, lo]) => la >= s && la < n && lo >= w && lo < e);
}

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
    // Never a literal: the reader rejects any tile whose stamp is not its own TILE_FORMAT_V, so a
    // hardcoded version here turns a forgotten edit into a permanent Overpass fallback app-wide.
    v: TILE_FORMAT_V,
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

  // Longest way in this tile, reported (not thrown) so the crawl can measure the whole grid in one
  // pass. Ways are owned by the tile holding their midpoint, so the scan-time margin must exceed
  // HALF the longest way or roads inside the radius silently vanish from results. Throwing here
  // would surface the maximum one tile at a time, forcing a raise-and-restart cycle per offender;
  // the tiles themselves are valid regardless, since MARGIN_KM only affects which tiles a scan
  // loads. The check is enforced once, over the whole grid, at the end of the run.
  const longest = roads.reduce((mx, r) => Math.max(mx, pathLengthKm(decodePath(r.geom))), 0);

  const json = JSON.stringify(tile);
  const gz = gzipSync(json).length;
  if (!opts.dryRun) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(outPath, json);
    writeManifest(); // keep a partial crawl usable — see writeManifest()
  }
  return { key, roads: roads.length, baked, pois: tile.pois.meta.length, bytes: json.length, gz, longest };
}

/**
 * Publish the manifest from what is actually on disk.
 *
 * Written after EVERY tile, not just at the end of a run: the client refuses to serve a scan unless
 * every tile overlapping its radius is listed, so a manifest that only appears on completion makes
 * a partial or interrupted crawl useless rather than partially useful. Cheap enough to do per tile
 * (a few dozen short strings).
 */
function writeManifest() {
  const tiles = readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  writeFileSync(
    `${OUT_DIR}manifest.json`,
    JSON.stringify({ v: TILE_FORMAT_V, tileDeg: TILE_DEG, marginKm: MARGIN_KM, tiles }),
  );
  return tiles.length;
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
    let inBox = 0;
    for (let a = sLat; a <= nLat; a++) {
      for (let b = sLon; b <= nLon; b++) {
        inBox++;
        if (tileTouchesNY(a, b)) cells.push([a, b]);
      }
    }
    console.log(`grid: ${cells.length} tiles touch NY (${inBox - cells.length} of ${inBox} skipped as out-of-state)`);
  }

  if (refreshOldest) {
    const stale = stalestTiles(cells, refreshOldest);
    const missing = cells.filter(([a, b]) => !existsSync(`${OUT_DIR}${tileKey(a, b)}.json`));
    // Missing tiles always win a slot — a hole in coverage matters more than a stale tile.
    cells = [...missing, ...stale];
    opts.force = true;
    console.log(`refresh mode: ${missing.length} missing + ${stale.length} stalest`);
  }

  // Drop any tile the current outline no longer selects. Run after narrowing NY_OUTLINE (or the
  // grid) so the committed corpus does not keep serving — and paying repo weight for — regions the
  // build would no longer produce.
  if (has('--prune')) {
    const wanted = new Set(cells.map(([a, b]) => tileKey(a, b)));
    // manifest.json lives in this directory too and is regenerated below — never prune it as if it
    // were a stale tile.
    const files = existsSync(OUT_DIR)
      ? readdirSync(OUT_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json')
      : [];
    let removed = 0, freed = 0;
    for (const f of files) {
      if (wanted.has(f.replace(/\.json$/, ''))) continue;
      freed += statSync(`${OUT_DIR}${f}`).size;
      rmSync(`${OUT_DIR}${f}`);
      removed++;
      console.log(`  pruned ${f}`);
    }
    console.log(`pruned ${removed} tile(s), freed ${(freed / 1024 / 1024).toFixed(1)} MB`);
    console.log(`manifest: ${writeManifest()} tile(s)`);
    return;
  }

  console.log(`Building ${cells.length} tile(s) at ${TILE_DEG}deg${opts.dryRun ? ' (dry run)' : ''}`);
  let totalGz = 0, built = 0, skipped = 0, failed = 0;
  let longestWayKm = 0, longestWayTile = null;
  const t0 = Date.now();

  for (const [a, b] of cells) {
    const r = await buildTile(a, b, opts);
    if (r.skipped) { skipped++; continue; }
    if (r.failed) { failed++; continue; }
    built++;
    totalGz += r.gz;
    if (r.longest > longestWayKm) { longestWayKm = r.longest; longestWayTile = r.key; }
    console.log(
      `  ${r.key}  roads ${String(r.roads).padStart(5)}  rubric ${String(r.baked).padStart(5)}` +
      `  pois ${String(r.pois).padStart(4)}  ${(r.bytes / 1024).toFixed(0)}KB -> ${(r.gz / 1024).toFixed(0)}KB gz`,
    );
  }

  if (!opts.dryRun && existsSync(OUT_DIR)) console.log(`manifest: ${writeManifest()} tile(s)`);

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\nbuilt ${built}, skipped ${skipped}, failed ${failed} in ${mins} min`);
  console.log(`total ${(totalGz / 1024 / 1024).toFixed(2)} MB gzipped`);
  if (built && cells.length > built) {
    console.log(`projected full grid: ~${((totalGz / built) * cells.length / 1024 / 1024).toFixed(1)} MB gzipped`);
  }

  // Enforced once, over everything this run produced. Only meaningful on a full crawl — a resumed
  // run skips existing tiles, so it sees only the subset it rebuilt.
  if (built) {
    console.log(`longest way: ${longestWayKm.toFixed(1)}km (${longestWayTile}), MARGIN_KM=${MARGIN_KM} covers ${2 * MARGIN_KM}km`);
    if (longestWayKm > 2 * MARGIN_KM) {
      console.error(
        `\nERROR: ${longestWayTile} holds a ${longestWayKm.toFixed(1)}km way, over 2x MARGIN_KM ` +
        `(${2 * MARGIN_KM}km). Ways are owned by the tile containing their midpoint, so scans ` +
        `within ${MARGIN_KM}km of that road will silently miss it. Raise MARGIN_KM to at least ` +
        `${Math.ceil(longestWayKm / 2)} in BOTH src/lib/tileCodec.ts and scripts/lib/tile-codec.mjs ` +
        `(the parity test enforces they match). Tiles themselves are valid and need no rebuild.`,
      );
      process.exitCode = 1;
    }
  }
  if (failed) process.exitCode = 1;
})();
