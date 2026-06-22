// Re-curate the SHIPPED curated dataset deterministically — NO network, NO LLM.
// Reads src/data/curatedRoutes.ts, then for every route re-measures rubric.curvature as RIDEABLE
// FLOW (junction corners + digitization jitter excluded — the same metric the Live-scan tab uses),
// recomputes the transparent motorcycle-weighted composite score, and re-sorts the slate. The
// OSRM-snapped geometry and the OSM-measured scenery/greenery/water/notability are left untouched
// (re-run curated:build + enrich-scenery to refresh those over the network).
//
// Run: node scripts/recurate-curated.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { flowCurvature, curvature10, compositeScore } from './lib/scenic-metrics.mjs';

const FILE = fileURLToPath(new URL('../src/data/curatedRoutes.ts', import.meta.url));

const txt = readFileSync(FILE, 'utf8');
const header = txt.slice(0, txt.indexOf('export const'));
const routes = JSON.parse(txt.slice(txt.indexOf('= [') + 2, txt.lastIndexOf(';')));

const before = routes.map((r) => ({ id: r.id, score: r.score, curv: r.rubric.curvature }));

for (const r of routes) {
  const coords = r.coords.map((c) => [c[0], c[1]]);
  r.rubric = { ...r.rubric, curvature: flowCurvature(coords) };
  r.score = compositeScore(r.rubric);
}

routes.sort((a, b) => b.score - a.score);

writeFileSync(FILE, header + `export const CURATED_ROUTES: ScenicRoute[] = ${JSON.stringify(routes)};\n`);

console.log('Re-curated', routes.length, 'curated routes (flow-aware curvature).\n');
console.log('id'.padEnd(44), 'curv(was→now)  score(was→now)  (old rad/km→0-10)');
for (const r of routes) {
  const b = before.find((x) => x.id === r.id);
  console.log(
    r.id.padEnd(44),
    `${String(b.curv).padStart(4)}→${String(r.rubric.curvature).padStart(4)}`,
    `   ${String(b.score).padStart(3)}→${String(r.score).padStart(3)}`,
    `   (was ${curvature10(r.coords)})`,
  );
}
console.log('\nNew ranking:', routes.map((r) => r.id).join('  >  '));
console.log('Wrote', FILE);
