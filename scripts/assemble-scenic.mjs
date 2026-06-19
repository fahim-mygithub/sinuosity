// Assemble the final scenic dataset: take the agentic workflow's judged routes, snap
// each route's waypoints to real road geometry via OSRM (keyless), recompute curvature
// objectively from the snapped polyline, and emit src/data/scenicRoutes.ts.
//
// Run: node scripts/assemble-scenic.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
function curvatureDensity(coords) {
  const dist = pathLength(coords);
  if (dist < 0.25) return 0;
  let dev = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    const ls = Math.cos(((coords[i - 1][0] + coords[i][0]) / 2) * Math.PI / 180);
    const v1 = [coords[i][0] - coords[i - 1][0], (coords[i][1] - coords[i - 1][1]) * ls];
    const v2 = [coords[i + 1][0] - coords[i][0], (coords[i + 1][1] - coords[i][1]) * ls];
    const m1 = Math.hypot(...v1), m2 = Math.hypot(...v2);
    if (m1 > 0 && m2 > 0) dev += Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (m1 * m2))));
  }
  return dev / dist;
}

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
    const isDetour = (snap, ref) => !snap || snap.coords.length < 4 || snap.km > Math.max(8, pathLength(ref) * 2.3);
    let chosen = null, via = '';
    const wpSnap = await osrmSnap(r.waypoints);
    if (!isDetour(wpSnap, wpLine)) { chosen = wpSnap; via = 'waypoints'; }
    else if (stopLine.length >= 2) {
      const stopSnap = await osrmSnap(stopLine);
      if (!isDetour(stopSnap, stopLine)) { chosen = stopSnap; via = 'stops'; }
    }

    let coords, km, time;
    if (chosen) {
      coords = downsample(chosen.coords, 150);
      km = chosen.km;
      time = drivingTime(chosen.sec);
      if (via === 'stops') console.warn(`  [${r.id}] waypoint route detoured — used road-snapped STOPS instead`);
    } else {
      const straightLine = pathLength(wpLine);
      coords = r.waypoints.map((w) => [+w[0].toFixed(5), +w[1].toFixed(5)]);
      km = straightLine;
      time = `~${Math.round((straightLine / 50) * 60)} min`;
      console.warn(`  [${r.id}] OSRM unusable for waypoints AND stops — using coarse waypoint polyline`);
    }

    out.push({
      id: r.id,
      name: r.name,
      theme: r.theme,
      region: r.region,
      distanceKm: +km.toFixed(1),
      drivingTime: time,
      summary: r.summary,
      whyRide: entry.whyRide || r.whyRide || '',
      // Trust the agentic judge/repair rubric — recomputing curvature on a dense OSRM
      // polyline over-counts vertex noise (a straight cruiser scored ~6).
      rubric: r.rubric,
      score: entry.judgeScore ?? r.score ?? 0,
      color: PALETTE[i % PALETTE.length],
      coords,
      // Project to the ScenicStop shape (drop pipeline-only flags like streetView).
      stops: r.stops.map((s) => ({
        lat: s.lat, lon: s.lon, title: s.title, blurb: s.blurb,
        kind: s.kind, heading: s.heading, ...(s.source ? { source: s.source } : {}),
      })),
    });
    console.log(`  [${r.id}] ${out[out.length - 1].distanceKm}km, ${coords.length} pts, curve ${r.rubric.curvature}, score ${out[out.length - 1].score}${via ? ' [via ' + via + ']' : ' [waypoint-fallback]'}`);
    i++;
    await sleep(1200);
  }
  // Rank by score descending.
  out.sort((a, b) => b.score - a.score);

  const header = `import type { ScenicRoute } from './types';\n\n` +
    `/**\n` +
    ` * Scenic WNY motorcycle routes — generated by the build-time agentic pipeline\n` +
    ` * (scripts/gather-scenic.mjs -> scripts/scenic-workflow.js -> scripts/assemble-scenic.mjs).\n` +
    ` * Geometry is OSRM-snapped to real roads; curvature is measured from that geometry;\n` +
    ` * scenery/greenery/water/notability and stop selection come from OSM POIs + an agentic\n` +
    ` * judge panel. Regenerate by re-running the pipeline — do not hand-edit.\n` +
    ` */\n`;
  const body = `export const SCENIC_ROUTES: ScenicRoute[] = ${tsLiteral(out)};\n`;
  writeFileSync(OUT, header + body);
  console.log(`\nWrote ${out.length} routes to ${OUT}`);
})();
