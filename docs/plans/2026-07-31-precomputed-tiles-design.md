# Precomputed road/scenic tiles — design

**Date:** 2026-07-31
**Status:** approved, implementing

## Problem

The Scan tab queries Overpass live from the browser: two parallel `(around:)` queries per
scan (`overpass.ts` roads + `features.ts` scenic catalog), plus up to seven Open-Meteo
elevation batches. Users report constant rate limiting and queueing.

Measured 2026-07-31 against `overpass-api.de`, rural NY, with the app's real queries:

| query | radius | wall time | payload |
|---|---|---|---|
| roads (`out geom`) | 30 km | 24.4 s | 1.9 MB |
| scenic 12-clause union | 30 km | 17.0 s | 10.5 MB |
| roads | 80 km | 31.7 s | 18.7 MB |
| scenic union | 80 km | 34.9 s | 54.6 MB |

Latency is near-constant regardless of payload — 1.9 MB took 24 s, 55 MB took 35 s. Per the
OSM community, this is **load queueing on undersized public infrastructure**, not intrinsic
query cost. OSM-France measured same-or-worse (31.4 s on the identical 30 km roads query).

Hosted alternatives were ruled out on capability: Mapbox Tilequery returns closest-point not
geometry and caps at 50 features (a scan needs ~15,000 polylines); OSM API 0.6 `/map` caps at
0.25 deg²; ohsome's `/elements/geometry` 403s regardless of UA.

## Why tiles, given a 30 km cap

The radius slider maxes at 30 km (`App.tsx:786`). A bounded max radius means a scan touches a
fixed, small number of tiles — so no runtime spatial query engine is needed at all. This is
what makes precompute the right answer here and would not hold for an unbounded radius.

Rejected alternatives:

- **Self-hosted Overpass** — ~1-3 s with a one-line endpoint change, but an Overpass DB stores
  *everything*; running a large US database on an SSD VPS (~$20-40/mo, long import, ongoing
  minute diffs) to serve three highway classes is the wrong shape.
- **Supabase PostGIS** — a full rewrite of the data layer to reach sub-second, when CDN tiles
  reach sub-second reusing code that already exists. Revisit only if arbitrary-radius or
  server-side queries are ever needed.

## Coverage

Grid rectangle `40.5,-79.8 → 45.0,-71.8` at 0.5° is 170 cells, then **clipped to a coarse New York
outline — 82 tiles**. Outside coverage the existing Overpass path runs unchanged.

Two clipping decisions, both driven by measurement:

- **Out-of-state cells are skipped.** NY is irregular inside that box, so ~half the rectangle is
  Pennsylvania, New Jersey and New England — and those were the *most* expensive tiles: dense
  Philadelphia / northern-NJ cells measured 2.3–3.4 MB raw (573–980 KB gzipped) against 178 KB for
  a rural WNY tile, while holding nothing this app looks for.
- **The southern edge stops near 41.25**, not at the real state line. NYC, Staten Island and Long
  Island are genuinely New York but have no twisty backroads, and the Staten Island tile alone
  measured 10,247 ways / 7.7 MB raw / 2.1 MB gzipped. A few such tiles would dominate the corpus to
  serve scans that return nothing worth riding.

Neither is a capability loss: scans in those areas still work through the Overpass fallback.

### Coverage is published, not inferred

The builder writes `public/tiles/manifest.json` listing every tile that exists. The client requires
every tile overlapping the scanned **radius** to be present and otherwise falls back; margin tiles
are best-effort.

This is load-bearing. An earlier version tested the grid **rectangle** for coverage, so a scan
centred in Pennsylvania would load one stray NY tile and return a scan silently missing most of its
area — a plausible-looking result with whole sectors absent. Publishing the manifest also avoids
duplicating the state outline into the browser, where a drifted copy would reintroduce exactly that
bug.

## Grid and way assignment

Tiles are keyed `t_{latIdx}_{lonIdx}.json` under `public/tiles/`, where the indices are
`floor(lat/0.5)` and `floor(lon/0.5)`.

**Ways are never clipped at tile boundaries.** A split polyline would corrupt `sinuosityScore`
and `flowCurvature` — the same class of failure that makes standard vector tiles unusable here
(they simplify geometry per zoom, and full vertex detail exists only at z14+). Each way is
assigned whole to the tile containing its midpoint. A scan fetches every tile intersecting the
scan bbox **plus one tile of margin**, so a way whose midpoint sits just outside the scan bbox
is still present, then filters by radius client-side.

## Tile contents

```
{ v, bbox, roads[], tells, pois[] }
```

- `roads[]` — the full corpus (every secondary/tertiary/unclassified way) with geometry, plus
  baked `curveDensity`, `flowCurvature`, `rubric`, and `gradeDrama`.
- `tells` — the categorized `RubricTells`. **Required at runtime**, not merely an input to the
  baked rubric: `routeBuilder.ts:590` re-measures the rubric on the *stitched ride polyline*, a
  geometry that cannot exist at build time. Baking per-road rubric alone is insufficient.
- `pois[]` — for stop synthesis (`routeBuilder.ts:604`).

Baking the per-road rubric still pays: it removes the O(roads × samples × tells) pass over ~300
candidates per scan. The stitched re-measure runs only for the handful of final rides.

Coordinates are quantized to 1e-5° (~1.1 m, matching `elevation.ts:175`) and delta-encoded as
integer arrays — the main size lever. Tiles ship as minified `.json`; GitHub Pages gzips text
on the fly, so pre-compressing would only break `Content-Encoding`.

## Client

New `src/lib/areaSource.ts` owns the source decision: center inside coverage → fetch tiles;
outside coverage, or on any tile failure → the existing Overpass path. `overpass.ts` remains
the fallback implementation untouched, so a tile bug can never make the app worse than today.
`scanArea`'s return type is unchanged, so `App.tsx` and `routeBuilder.ts` do not move.

## Build

`scripts/build-tiles.mjs` crawls the grid using the existing mirror-failover pattern from
`discover-roads.mjs`, reuses `scripts/lib/scenery-tells.mjs` and `scenic-metrics.mjs`, bakes
elevation, and writes tiles. **Resumable**: existing tiles are skipped unless `--force`, so a
rate-limited crawl resumes rather than restarting.

`.github/workflows/build-tiles.yml` runs on `workflow_dispatch` + monthly cron and commits the
tiles. `deploy.yml` is untouched and stays ~2 min — a push to main never waits on a crawl.

## Testing

TDD throughout: codec roundtrip, tile index math, tile-selection-for-radius, cross-tile merge
and dedupe, fallback on 404/network error, and a shape-equivalence test asserting a
tile-sourced `AreaScan` is interchangeable with an Overpass-sourced one.

## Build performance

The rubric pass, not Overpass, was the bottleneck. Profiling one dense tile: roads query 4.4 s,
tells query 9.7 s, categorize ~0 s — and the rubric pass **171 ms per road × 1,316 roads = 225 s**,
which across the grid is 5–10 h, over the CI ceiling.

`corridorSignal` and `weightedSignal` need only the *nearest* (or strongest-weighted) tell per route
sample point — neither sums over all tells. So a spatial index is **exact**, not an approximation.
`scripts/lib/scenery-tells.mjs` now carries a uniform grid with expanding-ring search, cached per
tell array (built once per tile, not once per road), plus a bbox pre-filter on polygon containment.
That is 171 ms → **33 ms** per road.

Two traps found while building it, both caught by the exactness test rather than by inspection:

- Terminating the ring walk at a guessed radius made the search *inexact* — a route far from all
  data returned "nothing found" where brute force reports a real, tiny distance. Termination now
  uses the grid's occupied extent, which is both exact and guaranteed to finish.
- That fix then made a far-from-data query crawl outward one empty ring at a time (~96 s for a
  single test route). The search now jumps straight to the first ring that can intersect occupied
  space.

## Resolved risk

The original 3–8 MB estimate for NY was extrapolated from the 30 km payloads, not measured — it was
wrong by ~5×. The spike measured **178 KB gzipped** for a rural WNY tile (568 roads, 333 with a
baked rubric), after fixing an encoding bug the measurement itself exposed: weighted point sets were
being written one `encodePath([pt])` at a time, emitting an absolute coordinate pair per point and
defeating the delta scheme. 21.5 k water points cost 485 KB that way against 44 KB for 12.7 k
sequence-encoded green points; storing them as one delta sequence plus a parallel weight array took
the tile from 245 KB to 178 KB.

Corpus size is now bounded by the 82-tile clip rather than by a per-tile estimate. Tiles are
committed to the repo as raw `.json` (Pages gzips text on the fly); if repo weight becomes
annoying, the follow-up is to publish them as a GitHub Release asset that `deploy.yml` unpacks,
which keeps them out of git history entirely.
