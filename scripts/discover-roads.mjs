// Road-geometry DISCOVERY for the scenic pipeline — the missing "scouting" stage.
//
// The old pipeline never looked at road geometry: it fanned out over 8 hand-typed
// corridors, so genuinely twisty roads outside those boxes could never surface. This
// script instead enumerates real paved through-roads across a wide WNY bounding box and
// ranks them by MEASURED curvature, the same way the app's Live-scan tab does — so the
// candidate corridors fed to the agentic compose stage are discovered from the data, not
// guessed by a human.
//
// Method (mirrors roadcurvature.com): pull highway ways via Overpass `out geom`, drop
// unpaved / private / non-through ways, aggregate ways by ref/name into roads, score each
// with the circumcircle "twistiness" metric, and rank. Also validates the result against a
// benchmark of WNY's genuinely renowned riding roads (NY-242, US-219, NY-240, etc.).
//
// Output: scripts/data/discovered-roads.json   Run: node scripts/discover-roads.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { twistiness, sinuosityScore, pathLengthKm, rankScore, DISCOVERY_DENSITY_CAP } from './lib/scenic-metrics.mjs';

const OUT = fileURLToPath(new URL('./data/discovered-roads.json', import.meta.url));
const OUT_FULL = fileURLToPath(new URL('./data/discovered-roads-full.json', import.meta.url));

// NY State boundary = OSM relation 61320 -> Overpass area id 3600000000 + 61320. ANDing the tile
// rectangle with this polygon keeps the scan US-side, so Ontario roads (which have moderate, gate-
// proof per-km curvature) can never pollute the ranking. NY-only for v1; near-border PA roads are
// acceptable collateral (a curator re-adds them).
const NY_AREA = 3600061320;
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'Sinuosity/2.0 road discovery (scenic ride finder; contact: github.com/sinuosity)',
};

// Widened WNY belt: west to Chautauqua (-79.85), east to the Bristol Hills / Naples
// (-77.25), south to the PA line / Allegany (41.99), north to Lake Ontario (43.40).
const BBOX = { s: 41.99, w: -79.85, n: 43.40, e: -77.25 };
const TILE = 0.5; // degrees; tiles keep each Overpass query small enough to finish

// Paved, public, through roads only. primary catches state routes (NY-242/240, US-219).
const HIGHWAY = '^(primary|secondary|tertiary|unclassified)$';
const UNPAVED = new Set(['unpaved', 'compacted', 'dirt', 'gravel', 'fine_gravel', 'sand', 'grass', 'ground', 'pebblestone', 'mud', 'clay', 'earth', 'soil']);

// Genuinely renowned WNY riding roads (from web research) — discovery should surface these.
const BENCHMARK = [
  { label: 'NY-242 Ellicottville–Mansfield', ref: /(^|;)NY 242($|;)/ },
  { label: 'US-219 spine', ref: /(^|;)US 219($|;)/ },
  { label: 'NY-240 Ashford "dips and waves"', ref: /(^|;)NY 240($|;)/ },
  { label: 'NY-39 Zoar/Java', ref: /(^|;)NY 39($|;)/ },
  { label: 'NY-353 Amish Trail', ref: /(^|;)NY 353($|;)/ },
  { label: 'NY-394 Chautauqua W', ref: /(^|;)NY 394($|;)/ },
  { label: 'NY-430 Chautauqua E', ref: /(^|;)NY 430($|;)/ },
  { label: 'NY-64 Bristol Hills', ref: /(^|;)NY 64($|;)/ },
  { label: 'NY-16 Holland', ref: /(^|;)NY 16($|;)/ },
  { label: 'Letchworth Park Road', name: /Park Road/i, near: { lat: 42.6, lon: -78.0 } },
];

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
      const j = await res.json();
      if (j.remark && /timed out|runtime error|rate_limited|too many|busy/i.test(j.remark)) { lastErr = j.remark; await sleep(3000 * (attempt + 1)); continue; }
      return j.elements || [];
    } catch (e) {
      clearTimeout(to);
      lastErr = String(e.name || e);
      await sleep(2000 * (attempt + 1));
    }
  }
  console.warn(`  [${label}] FAILED after retries: ${lastErr}`);
  return null;
}

function isPavedThrough(t) {
  if (!t) return false;
  if (t.surface && UNPAVED.has(t.surface)) return false;
  if (t.access === 'no' || t.access === 'private') return false;
  if (t.motor_vehicle === 'no' || t.vehicle === 'no') return false;
  if (t.area === 'yes') return false;
  return true;
}

(async () => {
  console.log('Discovering twisty WNY roads from OpenStreetMap…');
  console.log(`BBOX ${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}  tile ${TILE}°`);

  const ways = new Map(); // wayId -> {ref,name,pts,tags}
  let tiles = 0, okTiles = 0;
  for (let s = BBOX.s; s < BBOX.n; s += TILE) {
    for (let w = BBOX.w; w < BBOX.e; w += TILE) {
      const n = Math.min(s + TILE, BBOX.n), e = Math.min(w + TILE, BBOX.e);
      tiles++;
      const q = `[out:json][timeout:60];area(${NY_AREA})->.ny;way["highway"~"${HIGHWAY}"](area.ny)(${s.toFixed(3)},${w.toFixed(3)},${n.toFixed(3)},${e.toFixed(3)});out geom;`;
      const els = await overpass(q, `tile ${s.toFixed(2)},${w.toFixed(2)}`);
      if (els == null) { await sleep(1500); continue; }
      okTiles++;
      for (const el of els) {
        if (el.type !== 'way' || !el.geometry || ways.has(el.id)) continue;
        if (!isPavedThrough(el.tags)) continue;
        ways.set(el.id, {
          ref: el.tags.ref, name: el.tags.name,
          pts: el.geometry.map((g) => [g.lat, g.lon]),
          tags: el.tags,
        });
      }
      process.stdout.write(`\r  tiles ${okTiles}/${tiles}, ways ${ways.size}   `);
      await sleep(1200);
    }
  }
  console.log('');

  if (ways.size === 0) {
    console.error('No ways returned — Overpass unavailable. The discovery method is unchanged; re-run later.');
    process.exit(2);
  }
  // A4 — tile-success assertion: a silently-failing area clip (or dead mirrors) would drop whole
  // regions while the 10-road benchmark still "passes". Fail loudly if too few tiles answered.
  if (okTiles < tiles * 0.7) {
    console.error(`Only ${okTiles}/${tiles} tiles answered (<70%) — coverage too sparse to trust the ranking. Re-run when Overpass is healthier.`);
    process.exit(3);
  }

  // Aggregate ways into roads keyed by ref (preferred) or name; score each road's geometry.
  const roads = new Map();
  for (const way of ways.values()) {
    if (way.pts.length < 3) continue;
    const key = way.ref ? `ref:${way.ref}` : way.name ? `name:${way.name}` : null;
    if (!key) continue; // skip unnamed/unref'd (TIGER noise)
    const t = twistiness(way.pts);
    const r = roads.get(key) || { key, ref: way.ref, name: way.name, value: 0, lengthKm: 0, segments: 0, sample: way.pts[0] };
    r.value += t.value;
    r.lengthKm += t.lengthKm;
    r.segments++;
    roads.set(key, r);
  }

  // A2 — rank on a length-normalized, density-capped score (min(perKm,CAP)*sqrt(km)) instead of
  // the raw total value. The old total scaled with length, so long mild roads out-ranked short
  // intense climbs and mall-ring/roundabout geometry (perKm in the hundreds) topped the list.
  // Tiers key off the CAPPED per-km density so the field is informative again.
  const ranked = [...roads.values()]
    .map((r) => {
      const perKm = r.lengthKm > 0 ? +(r.value / r.lengthKm).toFixed(1) : 0;
      const cappedPerKm = Math.min(perKm, DISCOVERY_DENSITY_CAP);
      return {
        ...r,
        perKm,
        lengthKm: +r.lengthKm.toFixed(1),
        rankScore: +rankScore(perKm, r.lengthKm).toFixed(1),
        tier: cappedPerKm >= 90 ? 'excellent' : cappedPerKm >= 55 ? 'pleasant' : 'mild',
      };
    })
    .filter((r) => r.lengthKm >= 2) // ignore stubs
    .sort((a, b) => b.rankScore - a.rankScore);

  console.log(`\nTop 25 WNY roads (by length-normalized rankScore = min(perKm,${DISCOVERY_DENSITY_CAP})*sqrt(km)):`);
  console.log('rank  rankScore  perKm  km    tier        road');
  ranked.slice(0, 25).forEach((r, i) => {
    const nm = r.ref ? `${r.ref}${r.name ? ' (' + r.name + ')' : ''}` : r.name;
    console.log(`${String(i + 1).padStart(3)}  ${String(r.rankScore).padStart(9)}  ${String(r.perKm).padStart(5)}  ${String(r.lengthKm).padStart(5)}  ${r.tier.padEnd(10)}  ${nm}`);
  });

  // Benchmark: did discovery surface the known gems, and where do they rank?
  console.log(`\nBenchmark — WNY's renowned riding roads:`);
  const rankOf = (pred) => {
    const idx = ranked.findIndex(pred);
    return idx >= 0 ? { rank: idx + 1, r: ranked[idx] } : null;
  };
  const benchReport = [];
  for (const b of BENCHMARK) {
    const hit = rankOf((r) =>
      (b.ref && r.ref && b.ref.test(r.ref)) ||
      (b.name && r.name && b.name.test(r.name) && (!b.near || Math.abs(r.sample[0] - b.near.lat) < 0.4)),
    );
    if (hit) {
      console.log(`  ✓ #${String(hit.rank).padStart(3)}  ${b.label.padEnd(34)} value ${hit.r.value} (${hit.r.tier}, ${hit.r.lengthKm}km)`);
      benchReport.push({ label: b.label, found: true, rank: hit.rank, value: hit.r.value, tier: hit.r.tier });
    } else {
      console.log(`  ✗        ${b.label.padEnd(34)} not found in box`);
      benchReport.push({ label: b.label, found: false });
    }
  }

  const payload = {
    generatedAt: 'build',
    bbox: BBOX,
    method: 'circumcircle twistiness (roadcurvature.com radius bands 175/100/60/30 -> weights 0/1/1.3/1.6/2), paved through-roads only, aggregated by ref/name',
    tiles: { total: tiles, ok: okTiles },
    wayCount: ways.size,
    roadCount: ranked.length,
    benchmark: benchReport,
    rankKey: `min(perKm,${DISCOVERY_DENSITY_CAP})*sqrt(lengthKm)`,
    // Top corridors become the seeds for the agentic compose stage (replacing hand-typed boxes).
    corridors: ranked.slice(0, 30).map((r) => ({
      ref: r.ref || null, name: r.name || null, rankScore: r.rankScore, value: r.value, perKm: r.perKm, lengthKm: r.lengthKm, tier: r.tier, sample: r.sample,
    })),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2));

  // A3 — persist the FULL ranked corpus (not just the top-30) so every rank claim is falsifiable
  // and the scenery crawl has a corpus to target. Trim the geometry to a sample point per road.
  const fullList = ranked.map((r) => ({
    ref: r.ref || null, name: r.name || null, rankScore: r.rankScore, value: r.value,
    perKm: r.perKm, lengthKm: r.lengthKm, tier: r.tier, segments: r.segments, sample: r.sample,
  }));
  writeFileSync(OUT_FULL, JSON.stringify({ generatedAt: 'build', bbox: BBOX, roadCount: fullList.length, roads: fullList }, null, 2));
  console.log(`Wrote full ranked corpus (${fullList.length} roads) to ${OUT_FULL}`);
  const foundN = benchReport.filter((b) => b.found).length;
  console.log(`\nBenchmark coverage: ${foundN}/${BENCHMARK.length} renowned roads surfaced.`);
  console.log(`Wrote ${ranked.length} ranked roads (top 30 as corridors) to ${OUT}`);
})();
