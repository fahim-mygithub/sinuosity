// Build-time data gather for the Sinuosity scenic pipeline.
// Pulls scenic point-of-interest signals from OpenStreetMap (Overpass) across the
// Western NY scenic belt, plus a connectivity check for OSRM route snapping.
// Output: scripts/data/scenic-raw.json (consumed by the agentic route workflow).
//
// Run: node scripts/gather-scenic.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./data/scenic-raw.json', import.meta.url));
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'Sinuosity/2.0 build pipeline (scenic ride finder; contact: github.com/sinuosity)',
};
// WNY scenic belt (widened to match scripts/discover-roads.mjs): west to Chautauqua Lake /
// NY-394, south to the PA line / Allegany, east to the Bristol Hills / Naples (NY-64), north
// to the Lake Ontario shore. The old box excluded Chautauqua and the Southern Tier — exactly
// where several of WNY's renowned riding roads live.
const BBOX = '41.99,-79.85,43.40,-77.25'; // south,west,north,east

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, label) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const ep = MIRRORS[attempt % MIRRORS.length];
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 90000);
    try {
      const res = await fetch(ep, { method: 'POST', headers: HEADERS, body: 'data=' + encodeURIComponent(query), signal: ctl.signal });
      clearTimeout(to);
      if (!res.ok) { lastErr = `HTTP ${res.status}`; await sleep(2000 * (attempt + 1)); continue; }
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) { lastErr = 'non-JSON'; await sleep(2000 * (attempt + 1)); continue; }
      const j = await res.json();
      if (j.remark && /timed out|runtime error|rate_limited/i.test(j.remark)) { lastErr = j.remark; await sleep(3000 * (attempt + 1)); continue; }
      console.log(`  [${label}] ok via ${ep.split('/')[2]} attempt ${attempt + 1}: ${(j.elements || []).length} elements`);
      return j.elements || [];
    } catch (e) {
      clearTimeout(to);
      lastErr = String(e.name || e);
      await sleep(2000 * (attempt + 1));
    }
  }
  console.warn(`  [${label}] FAILED after retries: ${lastErr}`);
  return [];
}

function coordsOf(el) {
  if (typeof el.lat === 'number') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

function norm(els, kind) {
  const out = [];
  for (const el of els) {
    const c = coordsOf(el);
    const t = el.tags || {};
    if (!c || !t.name) continue;
    out.push({
      kind,
      name: t.name,
      lat: +c[0].toFixed(5),
      lon: +c[1].toFixed(5),
      ele: t.ele ? Number(t.ele) : undefined,
      wikipedia: t.wikipedia || undefined,
      wikidata: t.wikidata || undefined,
      tourism: t.tourism, natural: t.natural, waterway: t.waterway, leisure: t.leisure,
    });
  }
  return out;
}

const Q = {
  viewpoint: `[out:json][timeout:60];node["tourism"="viewpoint"](${BBOX});out body 400;`,
  waterfall: `[out:json][timeout:60];(node["waterway"="waterfall"](${BBOX});way["waterway"="waterfall"](${BBOX}););out center 200;`,
  peak: `[out:json][timeout:60];node["natural"="peak"]["name"](${BBOX});out body 400;`,
  attraction: `[out:json][timeout:60];node["tourism"="attraction"]["name"](${BBOX});out body 400;`,
  reserve: `[out:json][timeout:60];(way["leisure"="nature_reserve"]["name"](${BBOX});relation["leisure"="nature_reserve"]["name"](${BBOX});relation["boundary"="protected_area"]["name"](${BBOX}););out center 200;`,
  water: `[out:json][timeout:60];(way["natural"="water"]["name"]["water"~"lake|reservoir"](${BBOX});relation["natural"="water"]["name"](${BBOX}););out center 150;`,
};

(async () => {
  console.log('Gathering WNY scenic POIs from OpenStreetMap…');
  const result = {};
  for (const [kind, query] of Object.entries(Q)) {
    result[kind] = norm(await overpass(query, kind), kind);
    await sleep(1500);
  }

  // OSRM connectivity check (Buffalo -> Springville driving route).
  let osrm = { ok: false };
  try {
    const r = await fetch('https://router.project-osrm.org/route/v1/driving/-78.7441,42.9808;-78.667,42.508?overview=full&geometries=geojson', { headers: { 'User-Agent': HEADERS['User-Agent'] } });
    const j = await r.json();
    osrm = { ok: j.code === 'Ok', code: j.code, points: j.routes?.[0]?.geometry?.coordinates?.length, km: j.routes?.[0]?.distance ? +(j.routes[0].distance / 1000).toFixed(1) : undefined };
  } catch (e) { osrm = { ok: false, err: String(e) }; }

  const counts = Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.length]));
  const payload = { generatedAt: 'build', bbox: BBOX, counts, osrm, pois: result };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log('\nCounts:', JSON.stringify(counts));
  console.log('OSRM:', JSON.stringify(osrm));
  console.log('Wrote', OUT);
})();
