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

NY State: `40.5,-79.8 → 45.0,-71.8` at 0.5°, ~144 tiles. Outside coverage, the existing
Overpass path runs unchanged.

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

## Open risk

The ~3-8 MB NY estimate is extrapolated from the 30 km payloads, not measured. Step 1 of
implementation builds a single tile and measures real gzipped size as a go/no-go before
crawling 144 of them.
