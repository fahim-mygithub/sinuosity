// Build the Curated dataset at full Scenic quality. Takes the hand-picked corridors in
// scripts/data/curated-seed.mjs and, for each one:
//   1. OSRM-snaps the sketch waypoints to real road geometry (keyless), then cleans the
//      polyline (dedup + out-and-back spur removal) and downsamples it.
//   2. MEASURES curvature from that cleaned geometry (never hand-assigned).
//   3. Snaps every scenic stop to its nearest Google Street View pano (free metadata endpoint)
//      so the stop sits on a drivable, photographable road and the image actually renders;
//      re-aims the camera heading at the scenic feature if the pano moved appreciably.
//   4. Computes a transparent motorcycle-weighted composite score from the rubric.
// Emits src/data/curatedRoutes.ts (CURATED_ROUTES: ScenicRoute[]), sorted by score.
//
// Reads the Street View key from .env.local (VITE_GOOGLE_MAPS_KEY) or the environment. Without
// a key, stops keep their authored coordinates/headings (images degrade to the kind-icon
// fallback) and everything else still builds.
//
// Run: node scripts/curate-routes.mjs   (or: npm run curated:build)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cleanCoords, flowCurvature, compositeScore, pathLengthKm,
  COMPOSITE_WEIGHTS, formatDriveTime, bearing, haversineM,
} from './lib/scenic-metrics.mjs';
import { CURATED_SEED } from './data/curated-seed.mjs';

const OUT = fileURLToPath(new URL('../src/data/curatedRoutes.ts', import.meta.url));
const ENV_LOCAL = fileURLToPath(new URL('../.env.local', import.meta.url));
const UA = { 'User-Agent': 'Sinuosity/2.0 build pipeline (curated ride finder)' };
const REFERER = 'https://fahim-mygithub.github.io/sinuosity/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadKey() {
  if (process.env.VITE_GOOGLE_MAPS_KEY) return process.env.VITE_GOOGLE_MAPS_KEY.trim();
  if (existsSync(ENV_LOCAL)) {
    const m = readFileSync(ENV_LOCAL, 'utf8').match(/^\s*VITE_GOOGLE_MAPS_KEY\s*=\s*(.+)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}
const KEY = loadKey();
if (!KEY) console.warn('No VITE_GOOGLE_MAPS_KEY — stops keep authored coords (no Street View snap).');

// --- OSRM road snap (lon,lat order; our points are [lat,lon]) -----------------------------
async function osrmSnap(waypoints) {
  const coordStr = waypoints.map((w) => `${w[1]},${w[0]}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson&continue_straight=false`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) { await sleep(1500 * (attempt + 1)); continue; }
      const j = await r.json();
      if (j.code === 'Ok' && j.routes?.[0]) {
        const route = j.routes[0];
        const coords = route.geometry.coordinates.map(([lon, lat]) => [+lat.toFixed(5), +lon.toFixed(5)]);
        return { coords, km: route.distance / 1000, sec: route.duration };
      }
    } catch { /* retry */ }
    await sleep(1500 * (attempt + 1));
  }
  return null;
}

// --- Street View nearest-pano (free metadata endpoint, no image quota) --------------------
let lastDenied = '';
async function nearestPano(lat, lon, radius) {
  if (!KEY) return null;
  const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lon}&radius=${radius}&source=outdoor&key=${KEY}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, { headers: { Referer: REFERER } });
      const j = await r.json();
      if (j.status === 'OK' && j.location) return { lat: j.location.lat, lon: j.location.lng, date: j.date };
      if (j.status === 'ZERO_RESULTS') return null;
      if (j.status === 'REQUEST_DENIED' || j.status === 'INVALID_REQUEST') lastDenied = j.error_message || j.status;
      await sleep(1200 * (attempt + 1));
    } catch { await sleep(1000 * (attempt + 1)); }
  }
  return null;
}

async function snapStop(s) {
  const orig = [s.lat, s.lon];
  let pano = null;
  for (const radius of [120, 300, 700, 1500]) {
    pano = await nearestPano(orig[0], orig[1], radius);
    await sleep(120);
    if (pano) break;
  }
  if (!pano) {
    console.log(`     [no pano] ${s.title}`);
    return { ...s, source: s.source ?? s.title };
  }
  const dist = haversineM(orig, [pano.lat, pano.lon]);
  // Camera sits at the pano (on the road). If it moved >40m, re-aim it at the scenic spot.
  const heading = dist > 40 ? bearing([pano.lat, pano.lon], orig) : s.heading;
  console.log(`     [ok ${Math.round(dist)}m h${heading}${pano.date ? ' ' + pano.date : ''}] ${s.title}`);
  return {
    lat: +pano.lat.toFixed(6), lon: +pano.lon.toFixed(6),
    title: s.title, blurb: s.blurb, kind: s.kind, heading, source: s.source ?? s.title,
  };
}

// Evenly downsample a dense polyline (OSRM returns a vertex every few metres).
function downsample(coords, max) {
  if (coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(coords[Math.round(i * step)]);
  return out;
}

// A snap is trustworthy only if OSRM didn't balloon the distance into a cross-network detour.
const isDetour = (snap, ref) => !snap || snap.coords.length < 4 || snap.km > Math.max(8, pathLengthKm(ref) * 1.5);
const tsLiteral = (v) => JSON.stringify(v);

(async () => {
  console.log(`Curating ${CURATED_SEED.length} hand-picked routes to scenic quality…`);
  const out = [];
  for (const seed of CURATED_SEED) {
    console.log(`\n[${seed.id}] ${seed.name}`);
    const wpLine = seed.waypoints.map((w) => [w[0], w[1]]);
    const stopLine = seed.stops.map((s) => [s.lat, s.lon]);

    // Snap geometry: try the waypoints; if OSRM detours, route through the stops; else fall back.
    let chosen = null, via = '';
    const wpSnap = await osrmSnap(seed.waypoints);
    if (!isDetour(wpSnap, wpLine)) { chosen = wpSnap; via = 'waypoints'; }
    else if (stopLine.length >= 2) {
      const stopSnap = await osrmSnap(stopLine);
      if (!isDetour(stopSnap, stopLine)) { chosen = stopSnap; via = 'stops'; }
    }

    let coords, km, time;
    if (chosen) {
      const cleaned = cleanCoords(chosen.coords);
      coords = downsample(cleaned, 150);
      km = pathLengthKm(cleaned);
      const scale = chosen.km > 0 ? km / chosen.km : 1;
      time = formatDriveTime((chosen.sec * scale) / 60);
      if (via === 'stops') console.warn('   waypoint route detoured — used road-snapped STOPS instead');
    } else {
      coords = seed.waypoints.map((w) => [+w[0].toFixed(5), +w[1].toFixed(5)]);
      km = pathLengthKm(wpLine);
      time = `~${Math.round((km / 50) * 60)} min`;
      console.warn('   OSRM unusable — using coarse waypoint polyline');
    }

    // Snap every stop to a real Street View pano so the imagery renders.
    const stops = [];
    for (const s of seed.stops) stops.push(await snapStop(s));

    // Curvature is MEASURED from the cleaned polyline; score is the transparent composite.
    const rubric = { ...seed.rubric, curvature: flowCurvature(coords) };
    const score = compositeScore(rubric);

    out.push({
      id: seed.id, name: seed.name, theme: seed.theme, region: seed.region,
      distanceKm: +km.toFixed(1), drivingTime: time,
      summary: seed.summary, whyRide: seed.whyRide,
      rubric, score, color: seed.color, coords, stops,
    });
    console.log(`   => ${km.toFixed(1)}km, ${coords.length} pts, curve ${rubric.curvature} (measured), score ${score} [via ${via || 'waypoint-fallback'}]`);
    await sleep(1000);
  }

  out.sort((a, b) => b.score - a.score);

  const header = `import type { ScenicRoute } from './types';\n\n` +
    `/**\n` +
    ` * Curated WNY motorcycle routes — the hand-picked editorial classics, built to the same\n` +
    ` * standard as the Scenic slate by scripts/curate-routes.mjs (seed: scripts/data/curated-seed.mjs).\n` +
    ` * Geometry is OSRM-snapped to real roads and cleaned of duplicate points / out-and-back spurs;\n` +
    ` * rubric.curvature is MEASURED from that geometry (radians/km -> 0-10, same scale as the\n` +
    ` * Live-scan tab); scenery/greenery/water/notability are editorial estimates; every stop is\n` +
    ` * snapped to its nearest Street View pano so the imagery renders; score is a transparent\n` +
    ` * motorcycle-weighted composite (curvature ${COMPOSITE_WEIGHTS.curvature}, scenery ${COMPOSITE_WEIGHTS.scenery}, greenery ${COMPOSITE_WEIGHTS.greenery}, water ${COMPOSITE_WEIGHTS.water}, notability ${COMPOSITE_WEIGHTS.notability}).\n` +
    ` * Regenerate by editing the seed and re-running the script — do not hand-edit.\n` +
    ` */\n`;
  const body = `export const CURATED_ROUTES: ScenicRoute[] = ${tsLiteral(out)};\n`;
  writeFileSync(OUT, header + body);
  if (lastDenied) console.log(`\nWARN: some Street View calls returned REQUEST_DENIED (last: "${lastDenied}") — re-run if many stops have no pano.`);
  console.log(`\nWrote ${out.length} curated routes to ${OUT}`);
})();
