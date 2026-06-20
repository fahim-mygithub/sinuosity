# Sinuosity — WNY Scenic Ride Finder

Finds twisty, **scenic** backroads across Western NY, previews the photo-worthy stops with
Google imagery, and hands the route off to Google/Apple Maps for navigation. Scout from any
address — the location is a first-class input (geocoded search + "use my location"), with an
optional saved default home. Three modes:

- **Scenic** (default) — a slate of rides from a *build-time pipeline*: candidate corridors
  are **discovered** by ranking WNY's paved through-roads on measured curvature (not a hand
  list), composed/justified against real OpenStreetMap POIs by an agentic judge panel,
  road-snapped with OSRM and cleaned of backtracking spurs. Each route's **twistiness is
  measured from the geometry** (radians/km → 0–10, the same scale as the Live-scan tab), and
  the slate is ranked by a transparent, motorcycle-weighted composite of the rubric
  (curvature-heavy) — not an opaque model score. Each ride previews a satellite hero with the
  route traced and stops numbered, a score breakdown, and a reviewable list of scenic stops
  with Street View thumbnails.
- **Curated** — the hand-picked editorial classics, built to the **same standard as Scenic**:
  OSRM-snapped geometry, measured curvature, a composite score, and a full review page with a
  satellite hero and Street-View-anchored stops. Generated from a human seed (see below).
- **Live scan** — real-time OSM curvature scan around **any searched address** (or your saved
  default), hardened: multi-mirror retry, client timeout, distinct error states.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests (geometry, maps URLs, overpass, geocode, settings, datasets)
npm run build    # production build into dist/  (base path /sinuosity/)
```

### Google Maps imagery (optional)

Street View + satellite thumbnails use a Google Maps Platform key. Copy `.env.example`
to `.env.local` and set `VITE_GOOGLE_MAPS_KEY` (enable *Maps Static API* + *Street View
Static API*; restrict the key to your Pages domain via HTTP referrers). **Without a key the
app still works** — scenic stops fall back to a placeholder plus keyless "Open in Street
View" deep-links.

## Regenerating the scenic dataset (the agentic pipeline)

The scenic routes in `src/data/scenicRoutes.ts` are generated, not hand-written:

```
scripts/discover-roads.mjs    # 0. rank WNY's twistiest paved roads by MEASURED curvature   (npm run scenic:discover)
scripts/gather-scenic.mjs     # 1. pull WNY scenic POIs from Overpass (+ OSRM check)         (npm run scenic:gather)
scripts/scenic-workflow.js    # 2. agentic compose (seeded by discovered corridors) -> judge -> repair
scripts/snap-streetview.mjs   # 3. verify every stop has a real Street View pano + re-aim   (npm run scenic:snap)
scripts/assemble-scenic.mjs   # 4. OSRM-snap, CLEAN spurs, MEASURE curvature, composite-score (npm run scenic:assemble)
scripts/verify-roads.mjs      # 5. QA: confirm the polylines sit on drivable roads           (npm run scenic:verify)
```

Step 2 runs via the multi-agent Workflow tool; the rest are plain Node (see the `scenic:*`
npm scripts). Curvature, geometry-cleaning and the composite score all live in
`scripts/lib/scenic-metrics.mjs` (mirrored by `src/lib/geometry.ts` + `src/lib/scenicScore.ts`,
and pinned by `src/lib/scenicMetrics.test.ts`). Step 0's discovery output
(`scripts/data/discovered-roads.json`) seeds the compose stage so the slate is found from the
data, not from a hand-typed list. To re-rate/clean an *existing* dataset deterministically
(no network), run `npm run scenic:recurate` — it re-measures curvature, removes spurs, and
re-scores `src/data/scenicRoutes.ts` in place.

## Regenerating the curated dataset

The Curated slate is the hand-picked half, built to the same quality bar as Scenic. The human
input is `scripts/data/curated-seed.mjs` (one entry per corridor: theme, region, summary,
whyRide, rubric estimates, sketch waypoints, and authored stops). `npm run curated:build`
(`scripts/curate-routes.mjs`) then OSRM-snaps each corridor to real road geometry, cleans
spurs, **measures** curvature, snaps every stop to its nearest Street View pano (re-aiming the
camera at the view), composite-scores the rubric, and writes `src/data/curatedRoutes.ts`
(sorted by score). It reuses the shared metrics in `scripts/lib/scenic-metrics.mjs`; the
shipped data is pinned by `src/lib/curatedRoutes.test.ts`. Edit the seed and re-run to refresh
— don't hand-edit the generated file. (Street View snapping reads `VITE_GOOGLE_MAPS_KEY` from
`.env.local`; without it the build still runs and stops keep their authored coordinates.)

## Architecture

```
src/
  lib/
    geometry.ts        haversine, cos-lat sinuosity, curvature10, cleanCoords/spur removal (tested)
    scenicScore.ts     motorcycle-weighted composite score from the rubric (tested)
    mapsUrl.ts         Google/Apple Maps URL builders, waypoint cap, NaN guards (tested)
    geocode.ts         keyless Nominatim forward/reverse geocoding for the location search (tested)
    settings.ts        saved default location, localStorage-backed with safe fallbacks (tested)
    overpass.ts        hardened Overpass client: out-geom query, remark detection,
                       multi-mirror retry, abort support, name dedup (tested)
    scenicImagery.ts   Google Street View / satellite URL builders (runtime key) + deep-links
    scenicMeta.ts      shared stop-kind icons + rubric labels
  data/
    types.ts           shared types (ScenicRoute, ScenicStop, ScenicRubric, ScannedRoad)
    scenicRoutes.ts    GENERATED scenic dataset (do not hand-edit)
    curatedRoutes.ts   GENERATED curated dataset (do not hand-edit — edit the seed)
  hooks/
    useLeafletMap.ts   map lifecycle, attribution, resize handling
    useBottomSheet.ts  pointer-driven sheet (mobile) / docked panel (desktop)
  components/
    LocationSearch.tsx     first-class address search + use-my-location + saved default
    RouteDetail.tsx        scan detail + maps handoff (origin = scan center)
    ScenicRouteReview.tsx  full-page review (scenic + curated): satellite hero, rubric, Street View stops
  App.tsx              wires it together (Scenic / Curated / Live scan tabs)
```

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` builds and deploys to Pages on push to `main`
(base path `/sinuosity/`). Set the optional `VITE_GOOGLE_MAPS_KEY` repo secret to enable
imagery on the live site. Enable Pages → Source: GitHub Actions in repo settings.

## What's real vs estimated

- **Curvature / sinuosity** — measured from real road geometry in *both* the scenic dataset
  (angular deviation per km on the cleaned, OSRM-snapped line) and the live scan, on one 0–10
  scale. Never hand-assigned by a model.
- **Score** — a transparent, reproducible weighted composite of the rubric (curvature 0.35,
  scenery 0.20, greenery 0.15, water 0.15, notability 0.15), so ranking is monotonic in the
  rubric and curvature-led for a motorcycle audience.
- **Scenery / greenery / water / notability** — derived from OSM POI density + Wikipedia/
  Wikidata tags near the route, then judge-reviewed. Higher fidelity than the old author
  estimates, but still a heuristic — verify pavement, season, and traffic before riding.
- **Stop imagery** — live Google Street View / satellite (with a key) at the stored coords.
