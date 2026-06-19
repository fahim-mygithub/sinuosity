export const meta = {
  name: 'sinuosity-scenic-routes',
  description: 'Agentic generation of 5-8 WNY scenic motorcycle routes, scored on a scenery rubric, with photo stops, then judged & ranked',
  phases: [
    { title: 'Compose', detail: 'one agent per scenic corridor, grounded in real OSM POIs' },
    { title: 'Judge', detail: 'independent reviewers verify & score each candidate' },
    { title: 'Synthesize', detail: 'rank, dedupe, emit final slate' },
  ],
}

const HOME = '42.9808,-78.7441'
const DATA = 'scripts/data/scenic-raw.json'

// Seed corridors spanning the WNY scenic belt. Agents ground these in the gathered POIs.
const REPAIR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'name', 'theme', 'region', 'summary', 'rubric', 'waypoints', 'stops', 'viable', 'score', 'whyRide'],
  properties: {
    id: { type: 'string' }, name: { type: 'string' }, theme: { type: 'string' }, region: { type: 'string' },
    summary: { type: 'string' },
    rubric: {
      type: 'object', additionalProperties: false,
      required: ['curvature', 'scenery', 'greenery', 'water', 'notability'],
      properties: {
        curvature: { type: 'number' }, scenery: { type: 'number' }, greenery: { type: 'number' },
        water: { type: 'number' }, notability: { type: 'number' },
      },
    },
    waypoints: {
      type: 'array', minItems: 2, maxItems: 8,
      items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
    },
    stops: {
      type: 'array', minItems: 3, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false,
        required: ['lat', 'lon', 'title', 'blurb', 'kind', 'heading'],
        properties: {
          lat: { type: 'number' }, lon: { type: 'number' }, title: { type: 'string' }, blurb: { type: 'string' },
          kind: { type: 'string', enum: ['viewpoint', 'waterfall', 'gorge', 'water', 'overlook', 'village', 'forest', 'bridge', 'caution'] },
          heading: { type: 'number' }, source: { type: 'string' },
        },
      },
    },
    viable: { type: 'boolean' },
    score: { type: 'number' },
    whyRide: { type: 'string' },
    repairNotes: { type: 'string', description: 'what you fixed and why' },
  },
}

const CORRIDORS = [
  { key: 'zoar', name: 'Zoar Valley Gorge', bbox: '42.38,-79.05,42.55,-78.80', hint: 'Cattaraugus Creek shale gorge, deep hollows, tight & shaded (NY-240/Forty Rd/Valentine Flats area)' },
  { key: 'colden', name: 'Colden / Cazenovia Creek', bbox: '42.55,-78.80,42.78,-78.58', hint: 'NY-240 south through Colden, creek-hugging tree tunnel, Boston/Glenwood hills' },
  { key: 'niagara', name: 'Niagara Gorge Rim', bbox: '43.05,-79.20,43.30,-78.95', hint: 'Robert Moses / Niagara Scenic Pkwy along the gorge toward Lewiston; sunset over the river' },
  { key: 'ontario', name: 'Lake Ontario Shore', bbox: '43.28,-79.05,43.40,-78.40', hint: 'NY-18 Seaway Trail, open lake horizon, Olcott Beach, Thirty Mile Point lighthouse' },
  { key: 'springville', name: 'Cattaraugus & Springville Hills', bbox: '42.40,-78.80,42.62,-78.45', hint: 'Rolling Southtowns farmland ridges, Scoby Dam, Zoar approach, US-219 backroads' },
  { key: 'letchworth', name: 'Letchworth / Genesee Valley', bbox: '42.50,-78.20,42.75,-77.80', hint: 'Genesee River gorge, Letchworth waterfalls, Portageville, NY-19A/436 ridge roads' },
  { key: 'allegany', name: 'Allegany Foothills', bbox: '42.10,-78.70,42.40,-78.30', hint: 'Ischua valley, Rock City, forested ridgelines, US-219 south, NY-16 hollows' },
  { key: 'aurora', name: 'East Aurora & Holland Hills', bbox: '42.55,-78.70,42.78,-78.45', hint: 'US-20A Varysburg drop, NY-16 Holland, Chaffee, big valley sweepers + farm vistas' },
]

const ROUTE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'name', 'theme', 'region', 'summary', 'rubric', 'waypoints', 'stops'],
  properties: {
    id: { type: 'string', description: 'kebab-case unique id' },
    name: { type: 'string' },
    theme: { type: 'string', description: 'short ride archetype e.g. "Shaded gorge carver"' },
    region: { type: 'string' },
    summary: { type: 'string', description: '1-2 sentences on the ride' },
    rubric: {
      type: 'object', additionalProperties: false,
      required: ['curvature', 'scenery', 'greenery', 'water', 'notability'],
      properties: {
        curvature: { type: 'number' }, scenery: { type: 'number' }, greenery: { type: 'number' },
        water: { type: 'number' }, notability: { type: 'number' },
      },
    },
    rubricEvidence: { type: 'string', description: 'why those scores, citing specific POIs/roads' },
    waypoints: {
      type: 'array', minItems: 2, maxItems: 8,
      description: 'ordered [lat,lon] pairs tracing the scenic road corridor, for OSRM snapping',
      items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
    },
    stops: {
      type: 'array', minItems: 3, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false,
        required: ['lat', 'lon', 'title', 'blurb', 'kind', 'heading'],
        properties: {
          lat: { type: 'number' }, lon: { type: 'number' },
          title: { type: 'string' }, blurb: { type: 'string', description: 'what you will see / why stop' },
          kind: { type: 'string', enum: ['viewpoint', 'waterfall', 'gorge', 'water', 'overlook', 'village', 'forest', 'bridge', 'caution'] },
          heading: { type: 'number', description: 'Street View camera heading toward the view, 0-359' },
          source: { type: 'string', description: 'OSM/Wikipedia name the stop is anchored to, if any' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['scenicReal', 'score', 'whyRide', 'issues'],
  properties: {
    scenicReal: { type: 'boolean', description: 'is this a real, genuinely scenic, ridable route with stops that sit on/near roads (Street View will exist)?' },
    score: { type: 'number', description: 'final composite 0-100' },
    whyRide: { type: 'string', description: 'one punchy line a rider would act on' },
    issues: { type: 'string', description: 'any problems: off-road stops, fabricated POIs, not actually scenic, geometry concerns' },
    stopFixes: { type: 'string', description: 'optional corrected coords/headings for bad stops, or "none"' },
  },
}

phase('Compose')
const composedRaw = await parallel(
  CORRIDORS.map((c) => () =>
    agent(
      `You are composing a SCENIC MOTORCYCLE ROUTE for the "${c.name}" corridor in Western NY. ` +
      `The rider's home base is ${HOME} (36 Char Del Way, Williamsville). ` +
      `FIRST: read the file ${DATA} and filter its POIs (viewpoint/waterfall/peak/attraction/reserve/water) to roughly within bbox [${c.bbox}] (south,west,north,east). ` +
      `Corridor character: ${c.hint}. ` +
      `Using the REAL POIs you found plus your knowledge of WNY roads, design one great ride:\n` +
      `- Pick a genuinely twisty and/or scenic road corridor. Give ordered [lat,lon] waypoints (2-8) tracing it — these get OSRM-snapped to real roads, so put them ON real roads.\n` +
      `- Define 3-6 photo STOPS anchored to real scenic features (use the POI coords you read; set "source" to the POI name). Each stop: a heading (degrees, 0=N) pointing the Street View camera AT the view, and a vivid blurb of what you'll see. Stops MUST be at points a car/bike can reach (on or beside a road) so Street View imagery exists.\n` +
      `- Score the rubric 0-10 each: curvature (twistiness), scenery (viewpoints/falls/peaks density), greenery (forest/parks), water (creek/lake/gorge proximity), notability (Wikipedia/wikidata-tagged or famous features). Justify in rubricEvidence citing specific POIs.\n` +
      `Do NOT invent POIs that aren't in the data or that you aren't confident are real. Prefer accuracy over drama.`,
      { label: `compose:${c.key}`, phase: 'Compose', schema: ROUTE_SCHEMA }
    ).then((route) => (route ? { route, corridor: c.key } : null))
  )
)
const composed = composedRaw.filter(Boolean)
log(`Composed ${composed.length}/${CORRIDORS.length} candidate routes.`)

phase('Judge')
const JUDGES = 3
const judgeTasks = composed.flatMap((x, i) =>
  Array.from({ length: JUDGES }, (_, j) => ({ x, i, j }))
)
const judgedFlat = await parallel(
  judgeTasks.map((t) => () =>
    agent(
      `Adversarially review this proposed WNY scenic motorcycle route as judge #${t.j + 1}. Be skeptical and concrete.\n` +
      `Verify: (a) the waypoints lie on real drivable roads in the "${t.x.corridor}" area; (b) the stops are at real, reachable scenic spots where Google Street View would exist (NOT mid-forest/mid-lake); (c) it is genuinely scenic and worth a rider's time; (d) the rubric scores are honest, not inflated. ` +
      `You may sanity-check coordinates against your knowledge of WNY geography. Give a final 0-100 score, a punchy "why ride this" line, list issues, and propose stopFixes if any stop looks off-road or fabricated.\n\nROUTE:\n${JSON.stringify(t.x.route, null, 2)}`,
      { label: `judge:${t.x.corridor}:${t.j + 1}`, phase: 'Judge', schema: VERDICT_SCHEMA }
    ).then((v) => (v ? { i: t.i, v } : null))
  )
)

const verdictsByRoute = composed.map((_, i) =>
  judgedFlat.filter(Boolean).filter((r) => r.i === i).map((r) => r.v)
)
const candidates = composed
  .map((x, i) => ({ ...x, verdicts: verdictsByRoute[i] }))
  .filter((x) => x.verdicts && x.verdicts.length)

// REPAIR: feed each route + its judge feedback to a repair agent that fixes the concrete
// defects (non-drivable/trail waypoints, off-road or mislabeled stops, inflated rubric)
// and decides if the result is a genuinely viable scenic ride.
phase('Repair')
const repaired = await parallel(
  candidates.map((x) => () =>
    agent(
      `You are REPAIRING a proposed WNY scenic motorcycle route using 3 judges' feedback. Produce a corrected, honest, ship-ready route.\n` +
      `Corridor: "${x.corridor}". Apply every valid judge fix:\n` +
      `- Move any waypoint that lands on a NON-DRIVABLE path (trail, removed/decommissioned parkway, pedestrian-only) onto a confirmed drivable public road. Waypoints get OSRM-snapped, so they must sit on real roads.\n` +
      `- Relocate or DELETE any stop the judges flagged as off-road, mislabeled, or fabricated; use the judges' corrected coordinates when given. Every stop must be a real, reachable spot where Google Street View exists.\n` +
      `- Set HONEST rubric scores (0-10) reflecting the judges' deflation notes. Keep 3-6 good stops.\n` +
      `Set viable=false ONLY if the corridor cannot be salvaged into a real, genuinely scenic, ridable route. Otherwise viable=true. ` +
      `Give a final 0-100 score and a punchy whyRide line. Keep the same id/name/theme/region unless a fix requires renaming.\n\n` +
      `ORIGINAL ROUTE:\n${JSON.stringify(x.route, null, 2)}\n\nJUDGE VERDICTS:\n${JSON.stringify(x.verdicts, null, 2)}`,
      { label: `repair:${x.corridor}`, phase: 'Repair', schema: REPAIR_SCHEMA }
    ).then((rep) => (rep ? { ...rep, corridor: x.corridor } : null))
  )
)

phase('Synthesize')
const viable = repaired
  .filter(Boolean)
  .filter((r) => r.viable && Array.isArray(r.waypoints) && r.waypoints.length >= 2 && Array.isArray(r.stops) && r.stops.length >= 3)
  .sort((a, b) => (b.score || 0) - (a.score || 0))
  .slice(0, 8)

log(`Composed ${candidates.length}; repaired & kept ${viable.length} viable scenic routes.`)

return {
  keptCount: viable.length,
  routes: viable.map((r) => ({
    route: {
      id: r.id, name: r.name, theme: r.theme, region: r.region,
      summary: r.summary, rubric: r.rubric, waypoints: r.waypoints, stops: r.stops,
    },
    judgeScore: r.score,
    whyRide: r.whyRide,
    repairNotes: r.repairNotes,
  })),
}
