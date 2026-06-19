// Independent assurance that every scenic route polyline sits on real DRIVABLE roads.
// Samples points along each route and snaps them to the nearest car-routable road via
// OSRM's /nearest service. A small snap distance == the point is on a drivable road.
//
// Run: node scripts/verify-roads.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../src/data/scenicRoutes.ts', import.meta.url));
const UA = { 'User-Agent': 'Sinuosity/2.0 road verification' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadRoutes() {
  const txt = readFileSync(FILE, 'utf8');
  return JSON.parse(txt.slice(txt.indexOf('= [') + 2, txt.lastIndexOf(';')));
}
function sample(coords, n) {
  if (coords.length <= n) return coords;
  const step = (coords.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => coords[Math.round(i * step)]);
}
async function nearestRoadDist(lat, lon) {
  const url = `https://router.project-osrm.org/nearest/v1/driving/${lon},${lat}?number=1`;
  for (let a = 0; a < 3; a++) {
    try {
      const j = await (await fetch(url, { headers: UA })).json();
      if (j.code === 'Ok' && j.waypoints?.[0]) return j.waypoints[0].distance; // meters to road
    } catch { /* retry */ }
    await sleep(700 * (a + 1));
  }
  return null;
}

(async () => {
  const routes = loadRoutes();
  let worst = 0;
  for (const r of routes) {
    const pts = sample(r.coords, 14);
    const dists = [];
    for (const [lat, lon] of pts) {
      const d = await nearestRoadDist(lat, lon);
      if (d != null) dists.push(d);
      await sleep(180);
    }
    const max = Math.max(...dists), avg = dists.reduce((s, x) => s + x, 0) / dists.length;
    worst = Math.max(worst, max);
    const verdict = max <= 25 ? 'ON ROADS' : max <= 60 ? 'mostly (check)' : 'OFF-ROAD ⚠';
    console.log(`${r.id.padEnd(46)} samples ${dists.length}  avg ${avg.toFixed(1)}m  max ${max.toFixed(1)}m  -> ${verdict}`);
  }
  console.log(`\nWorst snap-to-road across all routes: ${worst.toFixed(1)}m (<=25m = confidently on drivable roads).`);
})();
