# Loop rides → real circuits with a dashed return leg

**Date:** 2026-06-28
**Status:** implemented

## Problem

"Loop rides" today just surfaces the best ride and, for a linear standout road (Zoar Valley
Rd), labels it an out-and-back — it "marks the road" but never *looks* like a loop. The rider
asked for the intended effect: a loop should go **in a circle**. The part of the trip that is
**not** the highlighted ride (the way back to the start) should be drawn with **dashed** marks so
it reads as "this is just how you get home." And if no real circle exists, looping back along the
same road is acceptable — a good road is good both ways — and should also be shown dashed.

## Approach

A ride keeps a single highlighted (solid) line — the **fun road**, which is still what we score,
name and place stops on. We add an optional **return leg** drawn dashed:

- `ScenicRoute.returnCoords?: LatLng[]` — the way back to the start.
- `ScenicRoute.returnKind?: 'circuit' | 'retrace'` — how we get back.

In **loop mode**, for any ride that doesn't already close on itself (`shape === 'out-and-back'`):

1. **Circuit (preferred).** Route the shortest path from the ride's far end back to its start over
   a connector graph built from the **full** scanned road corpus (every secondary/tertiary/
   unclassified way in the radius), **excluding the ride's own ways** so the way home is genuinely
   different. If one is found within a length budget, that's the dashed return and the ride becomes
   a real `loop`.
2. **Retrace (fallback).** Otherwise the return is the fun road reversed (`retrace`). It's drawn
   dashed and slightly offset beside the outbound line so the round trip is visible. Shape stays an
   honest `out-and-back`.

Already-closed loops (a circuit stitched from distinct curvy roads) need no return leg — the solid
line is already a circle.

### Why a connector graph

`scanArea` already parses the entire road corpus but only returns the *curvy candidates* (a linear
road can't be circled using only curvy roads — you need the plain connector roads to close it). So
`AreaScan` now also carries `corpus` (the full way set), and `buildRides` takes it as
`opts.connectors`. The graph is memoized per corpus array (a `WeakMap`), so dragging a bias slider
doesn't rebuild it.

`src/lib/returnPath.ts`:
- `getReturnGraph(roads)` — memoized undirected endpoint graph (rounded-coord node → edges).
- `findReturnPath(graph, fromPt, toPt, { excludeWayIds, maxKm })` — bounded Dijkstra; returns the
  stitched polyline oriented `from → to`, or `null` (→ retrace).

Return-length budget: `max(featuredKm * 2.5, featuredKm + 8)`, hard-capped at 50 km, so the fun
road is always a meaningful fraction of the loop; otherwise we retrace.

### Rendering & navigation

- `offsetPath(coords, meters)` (geometry.ts) — approximate perpendicular offset, used **only** to
  draw the retrace return beside the outbound line (never for navigation geometry).
- `drawRides` (and the scenic/curated detail draw) render `returnCoords` as a dashed line in the
  ride colour (offset for `retrace`, on the real connector roads for `circuit`), with a wide
  invisible hit line so it's tappable. Map `fitBounds` includes the return.
- `googleMapsUrl` gains an optional `returnCoords`: for a **circuit** the navigable path is
  `coords ++ returnCoords`, so the destination lands back at the start — a true round trip. Retrace
  and Apple Maps keep today's out-and-back handoff (the rider obviously turns around).

## Invariants kept

- `.score` / rubric / stops are still measured on the **fun road only** (`coords`) — the boring
  return never dilutes the score.
- Everything is **additive and optional**: with no `connectors` and loops off, output is unchanged.
  Loops-off behaviour is unchanged. Baked scenic/curated routes (no `returnCoords`) render exactly
  as before.
- Retrace keeps the honest `out-and-back` label and copy; only a real connector circuit is called a
  `loop`.
```
