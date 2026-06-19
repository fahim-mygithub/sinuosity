# Scenic Generation — Design (2026-06-19)

## Goal
Turn Sinuosity from a hand-curated ride list into a **scenic-route product**: an agentic
pipeline generates a slate of candidate WNY rides scored on a scenery rubric, attaches
photo-worthy stop-points with Google imagery, a judge ranks them, and the app presents
each ride as a reviewable preview (map + satellite + a stop list with Street View images).

## Key constraint → architecture
Deploy target is **static GitHub Pages** (no backend). A runtime LLM call would require
exposing keys or a server, so the "agentic workflow" runs at **build time** (orchestrated
now via the Workflow tool) and bakes a **versioned dataset** into the app. The app is a
pure static consumer of that dataset. Live-scan (Overpass) remains a hardened *optional*
feature; the scenic routes never depend on a runtime third-party call except Google
imagery, which degrades gracefully when no key is present.

```
build time (agentic, once)                     runtime (static, per user)
─────────────────────────────                  ─────────────────────────────
gather OSM scenic POIs  ┐                       load scenicRoutes.ts
OSRM snap road geometry ┼─► agents compose ───► render: map + scenic pins
score on rubric         │   5–8 candidates      ► path preview (satellite)
judge panel ranks       ┘   + stop-points       ► stop list w/ Street View imgs
   → src/data/scenicRoutes.ts (committed)       ► judge rationale + Maps handoff
```

## Data sources (validated)
- **OpenStreetMap / Overpass** — scenic POI signals: `tourism=viewpoint`,
  `waterway=waterfall`, `natural=peak`, `tourism=attraction`, `leisure=nature_reserve`,
  `boundary=protected_area`, named lakes. `wikipedia`/`wikidata` tags = a notability /
  "other people care about this" proxy. Gathered once via `scripts/gather-scenic.mjs`
  (multi-mirror retry, proper User-Agent — Node's default UA gets 406'd).
- **OSRM** (`router.project-osrm.org`, keyless) — snaps a chosen sequence of scenic
  waypoints to a real driving polyline so routes follow actual roads (and the Google
  handoff is faithful), replacing the old approximate sketches.
- **Google Maps Platform** (user's key, `VITE_GOOGLE_MAPS_KEY`) — Street View Static +
  Static satellite thumbnails, built **at runtime in the client** from coords+heading
  stored in the dataset. The key is never written into the committed dataset; it lives in
  the client bundle (referrer-restricted to the Pages domain). No key → graceful fallback
  to a placeholder + the keyless "Open in Street View" deep-link.

## Scenery rubric (0–10 per dimension → weighted composite, 0–100)
1. **Curvature** — measured sinuosity of the snapped geometry (the ride quality).
2. **Scenery density** — count/proximity of viewpoints, waterfalls, peaks, attractions near the corridor.
3. **Greenery / canopy** — forest/park/reserve coverage along the route.
4. **Water** — proximity to creeks, rivers, gorges, lake shore.
5. **Notability** — Wikipedia/Wikidata-tagged features near the route (proxy for community signal / reviews).
Each route stores the per-dimension breakdown so the UI can *show its work*.

## Agentic pipeline (Workflow, build time)
- **Seed**: ~8 named WNY scenic corridors (Zoar gorge, Letchworth/Genesee, Niagara rim,
  Lake Ontario shore, Colden/Boston hills, Cattaraugus, Allegany, Chautauqua country).
- **Compose** (parallel, one agent per corridor): from the gathered POIs, pick a twisty
  road corridor linking the best scenic anchors; define 3–6 **stop-points** (lat/lon,
  title, "what you'll see", suggested Street View heading); OSRM-snap the waypoints to a
  real polyline; self-score on the rubric with evidence.
- **Judge panel** (parallel per candidate): independent reviewers verify the route is real,
  genuinely scenic, ridable, and that stop coords sit on/near a road (Street View will
  exist); assign a final score + one-line "why ride this".
- **Synthesize**: rank, keep the top 6–8, emit `src/data/scenicRoutes.ts`.

## Dataset shape (`ScenicRoute`)
`id, name, theme, region, distanceKm, drivingTime, summary, whyRide (judge one-liner),
rubric {curvature, scenery, greenery, water, notability}, score, coords: LatLng[]
(snapped), stops: ScenicStop[]`. `ScenicStop = { lat, lon, title, blurb, kind, heading }`.

## UI additions
- New **"Scenic"** tab (becomes the default): ranked scenic-route cards with score chip + theme.
- **Route preview panel**: hero satellite static image of the route area, score-breakdown
  bars, judge "why ride this", and a **scenic stop list** — each stop a Street View
  thumbnail + title + blurb + "📷 Open in Street View" deep-link, plus a "caution/at-a-glance"
  line. Map draws the snapped polyline + numbered stop pins; tapping a stop flies the map to it.
- Existing Google/Apple Maps handoff reused (now with faithful snapped waypoints).
- Graceful no-key state: thumbnails become a labeled placeholder; deep-links still work.

## Out of scope (YAGNI)
Per-user runtime generation, accounts/auth, live review scraping, elevation API, offline
caching. The pipeline is re-runnable to refresh the dataset.
