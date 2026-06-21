// MEASURE the scenery rubric for the shipped routes from OSM map-tells — the L0 layer of the
// roadside-prettiness methodology (docs/plans/2026-06-21-scenic-discovery-and-prettiness.md).
//
// scenery/greenery/water/notability were GUESSED by the LLM compose stage and make up 0.50 of
// every route's composite score. This pass replaces those guesses with values MEASURED from real
// OSM features along each route corridor (proximity to water / viewpoints / peaks / forest+park,
// minus an ugly-landuse penalty), exactly the way curvature is already measured. Geometry, stops,
// distance and curvature are untouched; only the four scenery fields + the composite + the slate
// order change — so every dataset invariant (score == compositeScore(rubric), sorted desc) holds.
//
// No LLM, no imagery, $0. Run: node scripts/enrich-scenery.mjs   (or: npm run scenic:enrich)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { curvature10, compositeScore, haversineM, COMPOSITE_WEIGHTS } from './lib/scenic-metrics.mjs';
import { measureRubric, WATER_SIZE } from './lib/scenery-tells.mjs';

const FILES = [
  { path: '../src/data/scenicRoutes.ts', constName: 'SCENIC_ROUTES' },
  { path: '../src/data/curatedRoutes.ts', constName: 'CURATED_ROUTES' },
];
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'Sinuosity/2.0 scenery enrich (scenic ride finder; contact: github.com/sinuosity)',
};
const PAD = 0.02; // ~2km bbox pad around a route so corridor features are captured
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, label) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const ep = MIRRORS[attempt % MIRRORS.length];
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 60000);
    try {
      const res = await fetch(ep, { method: 'POST', headers: HEADERS, body: 'data=' + encodeURIComponent(query), signal: ctl.signal });
      clearTimeout(to);
      if (!res.ok) { lastErr = `HTTP ${res.status}`; await sleep(2000 * (attempt + 1)); continue; }
      const j = await res.json();
      if (j.remark && /timed out|runtime error|rate_limited|too many|busy/i.test(j.remark)) { lastErr = j.remark; await sleep(3000 * (attempt + 1)); continue; }
      return j.elements || [];
    } catch (e) {
      clearTimeout(to);
      lastErr = String(e.name || e);
      await sleep(2000 * (attempt + 1));
    }
  }
  throw new Error(`[${label}] Overpass failed after retries: ${lastErr}`);
}

function bbox(coords) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [lat, lon] of coords) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  return `${(s - PAD).toFixed(4)},${(w - PAD).toFixed(4)},${(n + PAD).toFixed(4)},${(e + PAD).toFixed(4)}`;
}

function tellsQuery(bb) {
  // `out geom` returns full vertex lists for ways (and member geometry for relations) so we can
  // measure area features (forest/park/lake) by containment + edge proximity rather than by a
  // single far-off centroid.
  return (
    `[out:json][timeout:90];(` +
    `nwr["tourism"="viewpoint"](${bb});` +
    `nwr["natural"~"^(peak|cliff)$"](${bb});` +
    `way["natural"="water"](${bb});relation["natural"="water"](${bb});` +
    `way["natural"="coastline"](${bb});` +
    `way["waterway"~"^(river|stream|canal)$"](${bb});` +
    `nwr["natural"="wood"](${bb});` +
    `way["landuse"="forest"](${bb});relation["landuse"="forest"](${bb});` +
    `nwr["leisure"~"^(park|nature_reserve)$"](${bb});` +
    `nwr["boundary"~"^(national_park|protected_area)$"](${bb});` +
    `way["landuse"~"^(industrial|retail|commercial|quarry|landfill)$"](${bb});` +
    `nwr["man_made"="works"](${bb});` +
    `);out geom;`
  );
}

const DS = 40; // cap vertices kept per feature (downsample big polygons/lines)
function downsamplePts(pts, max = DS) {
  if (pts.length <= max) return pts;
  const step = (pts.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

// Representative point + full vertex ring/line for an element (node | way w/ geometry | relation).
function geomOf(el) {
  if (Number.isFinite(el.lat) && Number.isFinite(el.lon)) return { pt: [el.lat, el.lon], ring: null };
  if (Array.isArray(el.geometry) && el.geometry.length) {
    const ring = el.geometry.filter((g) => g && Number.isFinite(g.lat)).map((g) => [g.lat, g.lon]);
    return ring.length ? { pt: ring[0], ring } : null;
  }
  if (Array.isArray(el.members)) {
    const ring = [];
    for (const m of el.members) if (Array.isArray(m.geometry)) for (const g of m.geometry) if (g && Number.isFinite(g.lat)) ring.push([g.lat, g.lon]);
    return ring.length ? { pt: ring[0], ring } : null;
  }
  return null;
}

function categorize(elements, coords) {
  const tells = {
    waterPts: [], waterAreas: [], greenAreas: [], greenPts: [],
    uglyAreas: [], uglyPts: [], view: [], peak: [], notable: [],
  };
  let viewMinM = Infinity;
  for (const el of elements) {
    const g = geomOf(el);
    const t = el.tags;
    if (!g || !t) continue;
    const verts = g.ring ? downsamplePts(g.ring) : [g.pt];
    const notable = !!(t.wikidata || t.wikipedia);

    if (t.tourism === 'viewpoint') {
      tells.view.push(g.pt);
      for (const c of coords) { const d = haversineM(c, g.pt); if (d < viewMinM) viewMinM = d; }
      if (notable) tells.notable.push({ pt: g.pt, w: 1.0 });
    } else if (t.natural === 'peak' || t.natural === 'cliff') {
      tells.peak.push(g.pt);
      if (notable) tells.notable.push({ pt: g.pt, w: 0.8 });
    } else if (t.natural === 'coastline') {
      for (const v of verts) tells.waterPts.push({ pt: v, w: WATER_SIZE.coastline });
    } else if (t.natural === 'water') {
      if (g.ring) tells.waterAreas.push(g.ring);
      for (const v of verts) tells.waterPts.push({ pt: v, w: WATER_SIZE.lake });
      if (notable) tells.notable.push({ pt: g.pt, w: 0.9 });
    } else if (t.waterway) {
      const w = WATER_SIZE[t.waterway === 'stream' ? 'stream' : 'river'];
      for (const v of verts) tells.waterPts.push({ pt: v, w });
    } else if (t.natural === 'wood' || t.landuse === 'forest' || t.leisure === 'park' || t.leisure === 'nature_reserve' || t.boundary === 'national_park' || t.boundary === 'protected_area') {
      if (g.ring) tells.greenAreas.push(g.ring);
      for (const v of verts) tells.greenPts.push(v);
      if (notable || t.boundary === 'national_park') tells.notable.push({ pt: g.pt, w: t.boundary === 'national_park' ? 1.0 : 0.7 });
    } else if (t.landuse || t.man_made === 'works') {
      if (g.ring) tells.uglyAreas.push(g.ring);
      for (const v of verts) tells.uglyPts.push(v);
    }
  }
  tells.viewMinM = viewMinM;
  return tells;
}

function parseRoutes(txt) {
  return JSON.parse(txt.slice(txt.indexOf('= [') + 2, txt.lastIndexOf(';')));
}

function headerFor(constName) {
  const w = COMPOSITE_WEIGHTS;
  const note =
    constName === 'CURATED_ROUTES'
      ? `the hand-picked editorial classics (seed: scripts/data/curated-seed.mjs), built by curate-routes.mjs`
      : `generated by the build-time pipeline (gather -> compose/judge -> snap -> assemble)`;
  return (
    `import type { ScenicRoute } from './types';\n\n` +
    `/**\n` +
    ` * Scenic WNY motorcycle routes — ${note}, then enriched by scripts/enrich-scenery.mjs.\n` +
    ` * Geometry is OSRM-snapped, cleaned of duplicate points / out-and-back spurs; rubric.curvature\n` +
    ` * is MEASURED from that geometry (radians/km -> 0-10). scenery/greenery/water/notability are now\n` +
    ` * MEASURED from OSM map-tells along the corridor (proximity to water/viewpoints/peaks/forest+park\n` +
    ` * minus ugly-landuse) — no longer LLM guesses. score is the transparent motorcycle-weighted\n` +
    ` * composite (curvature ${w.curvature}, scenery ${w.scenery}, greenery ${w.greenery}, water ${w.water}, notability ${w.notability}).\n` +
    ` * Do not hand-edit — re-run scripts/enrich-scenery.mjs (and the upstream pipeline) instead.\n` +
    ` */\n`
  );
}

(async () => {
  for (const { path, constName } of FILES) {
    const file = fileURLToPath(new URL(path, import.meta.url));
    const txt = readFileSync(file, 'utf8');
    const routes = parseRoutes(txt);
    console.log(`\n=== ${constName} (${routes.length} routes) ===`);
    console.log('id'.padEnd(42), ' scen  green water  notab   score(was→now)');

    for (const r of routes) {
      const coords = r.coords.map((c) => [c[0], c[1]]);
      const els = await overpass(tellsQuery(bbox(coords)), r.id);
      const tells = categorize(els, coords);
      const m = measureRubric(coords, tells);

      const was = r.score;
      r.rubric = {
        curvature: curvature10(coords), // re-measure to stay invariant-true
        scenery: m.scenery, greenery: m.greenery, water: m.water, notability: m.notability,
      };
      r.score = compositeScore(r.rubric);
      console.log(
        r.id.padEnd(42),
        String(m.scenery).padStart(5), String(m.greenery).padStart(6),
        String(m.water).padStart(5), String(m.notability).padStart(6),
        `   ${String(was).padStart(3)}→${String(r.score).padStart(3)}`,
        ` [${els.length} tells]`,
      );
      await sleep(1100);
    }

    routes.sort((a, b) => b.score - a.score);
    writeFileSync(file, headerFor(constName) + `export const ${constName}: ScenicRoute[] = ${JSON.stringify(routes)};\n`);
    console.log(`New order: ${routes.map((r) => r.id).join('  >  ')}`);
    console.log(`Wrote ${file}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
