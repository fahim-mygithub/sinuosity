// Assemble the final scenic dataset: take the agentic workflow's judged routes, snap
// each route's waypoints to real road geometry via OSRM (keyless), CLEAN the polyline
// (dedup + out-and-back spur removal), MEASURE curvature objectively from that cleaned
// geometry, compute a transparent motorcycle-weighted composite score, and emit
// src/data/scenicRoutes.ts (sorted by score). All curvature/score math lives in
// scripts/lib/scenic-metrics.mjs (mirrored by src/lib/geometry.ts).
//
// Run: node scripts/assemble-scenic.mjs   (run snap-streetview.mjs first to verify stops)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanCoords, curvature10, compositeScore, pathLengthKm, COMPOSITE_WEIGHTS } from './lib/scenic-metrics.mjs';

const IN = fileURLToPath(new URL('./data/scenic-judged.json', import.meta.url));
const OUT = fileURLToPath(new URL('../src/data/scenicRoutes.ts', import.meta.url));
const UA = { 'User-Agent': 'Sinuosity/2.0 build pipeline (scenic ride finder)' };
const PALETTE = ['#10b981', '#f97316', '#e11d48', '#06b6d4', '#a855f7', '#eab308', '#ef4444', '#14b8a6'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haversine(a, b) {
  const R = 6371, d2r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * d2r, dLon = (b[1] - a[1]) * d2r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * d2r) * Math.cos(b[0] * d2r) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function pathLength(c) { let d = 0; for (let i = 0; i < c.length - 1; i++) d += haversine(c[i], c[i + 1]); return d; }
// Curvature is measured by the shared metrics module (curvature10) on the cleaned,
// snapped polyline — never hand-assigned. (The old in-file curvatureDensity that the
// pipeline defined-but-discarded has been removed; see scripts/lib/scenic-metrics.mjs.)

async function osrmSnap(waypoints) {
  // OSRM wants lon,lat; our waypoints are [lat,lon].
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

function drivingTime(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Evenly downsample a dense polyline so the committed dataset stays small and the map
// stays smooth (OSRM returns a vertex every few meters — far more than we need).
function downsample(coords, max) {
  if (coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(coords[Math.round(i * step)]);
  return out;
}

const tsLiteral = (v) => JSON.stringify(v);

(async () => {
  const judged = JSON.parse(readFileSync(IN, 'utf8'));
  const items = judged.routes || judged; // accept either {routes:[...]} or [...]
  const out = [];
  let i = 0;
  for (const entry of items) {
    const r = entry.route || entry;
    const wpLine = r.waypoints.map((w) => [w[0], w[1]]);
    const stopLine = r.stops.map((s) => [s.lat, s.lon]);

    // A snap is trustworthy only if OSRM didn't balloon the distance (a broken routable
    // network can force an absurd cross-border detour). Try the waypoints first; if that
    // detours, route through the road-snapped STOPS (guaranteed on drivable roads), which
    // also makes the drawn line pass through every numbered pin.
    const isDetour = (snap, ref) => !snap || snap.coords.length < 4 || snap.km > Math.max(8, pathLength(ref) * 1.5);
    let chosen = null, via = '';
    const wpSnap = await osrmSnap(r.waypoints);
    if (!isDetour(wpSnap, wpLine)) { chosen = wpSnap; via = 'waypoints'; }
    else if (stopLine.length >= 2) {
      const stopSnap = await osrmSnap(stopLine);
      if (!isDetour(stopSnap, stopLine)) { chosen = stopSnap; via = 'stops'; }
    }

    let coords, km, time;
    if (chosen) {
      // Clean the OSRM geometry (dedup + out-and-back spur removal) BEFORE measuring/
      // downsampling, so distance, curvature and the drawn line all reflect the real road.
      const cleaned = cleanCoords(chosen.coords);
      coords = downsample(cleaned, 150);
      km = pathLengthKm(cleaned);
      const scale = chosen.km > 0 ? km / chosen.km : 1; // discount any spur miles from the time too
      time = drivingTime(chosen.sec * scale);
      if (via === 'stops') console.warn(`  [${r.id}] waypoint route detoured — used road-snapped STOPS instead`);
    } else {
      const straightLine = pathLength(wpLine);
      coords = r.waypoints.map((w) => [+w[0].toFixed(5), +w[1].toFixed(5)]);
      km = straightLine;
      time = `~${Math.round((straightLine / 50) * 60)} min`;
      console.warn(`  [${r.id}] OSRM unusable for waypoints AND stops — using coarse waypoint polyline`);
    }

    // Curvature is MEASURED from the cleaned polyline; score is a transparent,
    // motorcycle-weighted composite of the rubric (NOT the opaque LLM judge number).
    const rubric = { ...r.rubric, curvature: curvature10(coords) };
    const score = compositeScore(rubric);

    out.push({
      id: r.id,
      name: r.name,
      theme: r.theme,
      region: r.region,
      distanceKm: +km.toFixed(1),
      drivingTime: time,
      summary: r.summary,
      whyRide: entry.whyRide || r.whyRide || '',
      rubric,
      score,
      color: PALETTE[i % PALETTE.length],
      coords,
      // Project to the ScenicStop shape (drop pipeline-only flags like streetView).
      stops: r.stops.map((s) => ({
        lat: s.lat, lon: s.lon, title: s.title, blurb: s.blurb,
        kind: s.kind, heading: s.heading, ...(s.source ? { source: s.source } : {}),
      })),
    });
    console.log(`  [${r.id}] ${out[out.length - 1].distanceKm}km, ${coords.length} pts, curve ${rubric.curvature} (measured), score ${score}${via ? ' [via ' + via + ']' : ' [waypoint-fallback]'}`);
    i++;
    await sleep(1200);
  }
  // Rank by score descending.
  out.sort((a, b) => b.score - a.score);

  const header = `import type { ScenicRoute } from './types';\n\n` +
    `/**\n` +
    ` * Scenic WNY motorcycle routes — generated by the build-time pipeline\n` +
    ` * (gather-scenic -> scenic-workflow compose/judge/repair -> snap-streetview -> assemble-scenic).\n` +
    ` * Geometry is OSRM-snapped to real roads and cleaned of duplicate points and out-and-back\n` +
    ` * spurs; rubric.curvature is MEASURED from that geometry (radians/km -> 0-10, the same scale\n` +
    ` * as the Live-scan tab); scenery/greenery/water/notability and stop selection come from OSM\n` +
    ` * POIs + the judge panel; score is a transparent motorcycle-weighted composite of the rubric\n` +
    ` * (curvature ${COMPOSITE_WEIGHTS.curvature}, scenery ${COMPOSITE_WEIGHTS.scenery}, greenery ${COMPOSITE_WEIGHTS.greenery}, water ${COMPOSITE_WEIGHTS.water}, notability ${COMPOSITE_WEIGHTS.notability}).\n` +
    ` * Regenerate by re-running the pipeline — do not hand-edit.\n` +
    ` */\n`;
  const body = `export const SCENIC_ROUTES: ScenicRoute[] = ${tsLiteral(out)};\n`;
  writeFileSync(OUT, header + body);
  console.log(`\nWrote ${out.length} routes to ${OUT}`);
})();
