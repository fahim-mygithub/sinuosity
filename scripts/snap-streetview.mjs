// Snap every scenic stop to its nearest real Google Street View panorama, so each stop
// is (a) on a drivable, Street-View-covered road (ridable + the view is visible FROM the
// road) and (b) guaranteed to render a real Street View image — not a blank "no imagery"
// tile. Uses the free Street View *metadata* endpoint (does NOT consume image quota).
//
// Reads the key from .env.local (VITE_GOOGLE_MAPS_KEY) or the environment.
// Rewrites scripts/data/scenic-judged.json stops in place; then re-run assemble-scenic.mjs.
//
// Run: node scripts/snap-streetview.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const JUDGED = fileURLToPath(new URL('./data/scenic-judged.json', import.meta.url));
const ENV_LOCAL = fileURLToPath(new URL('../.env.local', import.meta.url));

function loadKey() {
  if (process.env.VITE_GOOGLE_MAPS_KEY) return process.env.VITE_GOOGLE_MAPS_KEY.trim();
  if (existsSync(ENV_LOCAL)) {
    const m = readFileSync(ENV_LOCAL, 'utf8').match(/^\s*VITE_GOOGLE_MAPS_KEY\s*=\s*(.+)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}
const KEY = loadKey();
if (!KEY) {
  console.error('No VITE_GOOGLE_MAPS_KEY found (env or .env.local). Aborting — set it first.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d2r = Math.PI / 180;

function haversine(a, b) {
  const R = 6371000;
  const dLat = (b[0] - a[0]) * d2r, dLon = (b[1] - a[1]) * d2r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * d2r) * Math.cos(b[0] * d2r) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
// Initial compass bearing from a -> b, degrees 0..359.
function bearing(a, b) {
  const y = Math.sin((b[1] - a[1]) * d2r) * Math.cos(b[0] * d2r);
  const x = Math.cos(a[0] * d2r) * Math.sin(b[0] * d2r) - Math.sin(a[0] * d2r) * Math.cos(b[0] * d2r) * Math.cos((b[1] - a[1]) * d2r);
  return (Math.atan2(y, x) / d2r + 360) % 360;
}

// A referrer-restricted key requires a matching Referer header on server-side calls.
const REFERER = 'https://fahim-mygithub.github.io/sinuosity/';

let lastDenied = '';
async function nearestPano(lat, lon, radius) {
  const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lon}&radius=${radius}&source=outdoor&key=${KEY}`;
  // Generous retries: a just-enabled API propagates unevenly across Google edges, so
  // REQUEST_DENIED can be transient. We retry it with backoff rather than aborting.
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

(async () => {
  const data = JSON.parse(readFileSync(JUDGED, 'utf8'));
  const routes = data.routes || data;
  let total = 0, snapped = 0, kept = 0, unresolved = 0;

  for (const entry of routes) {
    const r = entry.route || entry;
    for (const s of r.stops) {
      total++;
      const orig = [s.lat, s.lon];
      // Search outward until a real outdoor pano is found near this scenic spot.
      let pano = null;
      for (const radius of [120, 300, 700, 1500]) {
        pano = await nearestPano(orig[0], orig[1], radius);
        await sleep(120);
        if (pano) break;
      }
      if (!pano) {
        unresolved++;
        s.streetView = false;
        console.log(`   [no pano] ${s.title} (${orig.join(',')})`);
        continue;
      }
      const dist = haversine(orig, [pano.lat, pano.lon]);
      // Camera sits at the pano (on the road). If it moved appreciably, re-aim the camera
      // at the original scenic spot so the view faces the scenery; otherwise keep the
      // author/judge heading (already aimed at the view from that spot).
      const heading = dist > 40 ? Math.round(bearing([pano.lat, pano.lon], orig)) : s.heading;
      s.lat = +pano.lat.toFixed(6);
      s.lon = +pano.lon.toFixed(6);
      s.heading = heading;
      s.streetView = true;
      if (dist > 5) snapped++; else kept++;
      console.log(`   [ok ${Math.round(dist)}m h${heading}${pano.date ? ' ' + pano.date : ''}] ${s.title}`);
    }
  }

  writeFileSync(JUDGED, JSON.stringify(data, null, 2));
  console.log(`\nStops: ${total} | snapped-to-pano: ${snapped} | already-on-pano: ${kept} | NO street view: ${unresolved}`);
  if (lastDenied) console.log(`WARN: some calls returned REQUEST_DENIED (last: "${lastDenied}") — likely API-enable propagation; re-run if unresolved is high.`);
  console.log(`Updated ${JUDGED}. Now run: node scripts/assemble-scenic.mjs`);
})();
