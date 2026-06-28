# Road-finding rework: loops, single-road surfacing, and an elevation signal

**Date:** 2026-06-28
**Why:** A multi-agent investigation (see memory `road-finding-gaps`) proved that a famous
real road — **Zoar Valley Rd / Gowanda-Zoar Rd** (CR 74 → CR 457A) — is missed by the Scan
tab even though it clears every one of our metrics (curvature10 **9.2**, 194 m relief, 19.3 %
max grade, fully inside the 15 km ring, all whitelisted highway classes). It is invisible
because the *builder* discards it, and because the pipeline can't see the road's headline
trait (elevation) at all. The rider chose the **full rework + elevation** scope.

## Root causes being fixed (ranked)

1. **(critical) Loops-only suppression** — `routeBuilder.ts:225` returns ONLY loop-shaped
   rides whenever any loop exists, so two junk loops buried the Zoar out-and-back. A linear
   through-road can *never* be a loop (`:264`), so it's permanently filter-eligible.
2. **(high) No single-standout-road path** — every result must be a stitched chain that
   survives the shape filter; nothing surfaces one exceptional road on its own.
3. **(high) Elevation-blind** — rubric is only {curvature, scenery, greenery, water,
   notability}; geometry is 2D. A road famous for its gorge grade gets zero credit for it.
4. **(medium) Corridor fragmentation** — addressed in-spirit by #2 (the marquee path walks the
   full same-name/ref corridor) without destructively merging the stitch graph.

## Design

### 1. Loop mode = rank boost, not a hard filter (`routeBuilder.ts`)
Replace the `loops-only` return with a ranked merge: every built ride competes by
`rank`, but in loop mode a genuine loop gets a `LOOP_RANK_BONUS` (×1.25). A markedly
better through-road (Zoar) still wins; comparable loops still rank above comparable
out-and-backs. The exploration loop (`enoughBuilt`) is unchanged — it already builds the
out-and-backs, they were just thrown away at the end.

### 2. Marquee single-road surfacing (`routeBuilder.ts`)  [also satisfies #4]
After normal building, take the highest-composite candidate road. If it clears a high bar
(`MARQUEE_SCORE`, `MARQUEE_CURVE`) and isn't already the seed of an output ride, build a
standalone ride from its **full corridor** — walking contiguous ways that share an endpoint
AND the same normalized name or `ref` — regardless of loop/out-and-back shape, with a reduced
`minKm`. Guarantees a marquee road always appears, by its full name, as one entity.

### 3. Elevation / grade signal (NEW `src/lib/elevation.ts`)
- **Pure, tested:** `gradeMetrics(points, elevations) → {reliefM, totalAscentM, maxGradePct}`
  and `gradeDrama10(metrics, lengthKm) → 0–10` (0.4·maxGrade + 0.35·relief + 0.25·climbRate,
  each clamped; Zoar ≈ 8.7, a flat road ≈ 0–1). Plus `sampleAlong` (even ~spacing by distance).
- **Impure, graceful:** `fetchElevations(points, signal)` hits the free **Open-Meteo elevation
  API** (no key, CORS-friendly, ≤100 coords/request, batched + parallel). Returns `null` on any
  failure → elevation is strictly additive; the scan still works without it.
- **Wiring:** `scanArea` enriches the top-K candidate roads (by curvature) with a `gradeDrama`
  rubric field after the rubric pass. Bounded point budget; whole `AreaScan` is cached so a
  bias-slider change never re-fetches.

### 4. Scoring + rubric plumbing (additive, baked scores unchanged)
- `types.ts`: `ScenicRubric.gradeDrama?: number` (optional → baked data still typechecks).
- `composite.ts`: add `gradeDrama` to `BiasWeights`/`KEYS`; `COMPOSITE_WEIGHTS.gradeDrama = 0`
  (keeps the baked-equivalent numerically identical); each `BIAS_PRESETS` entry gains a
  `gradeDrama` weight (normalizeWeights rescales, so the existing 5 dims keep their ratios).
  Balanced/Twisty weight elevation most.
- `scenicScore.ts` (baked mirror) is **untouched** — baked scenic/curated scores stay identical.

### 5. UI
- `scenicMeta.ts`: add `{ key:'gradeDrama', label:'Elevation' }` to `RUBRIC_LABELS`.
- `ScenicRouteReview.tsx` `RubricMeters`: skip any row whose value isn't finite, so baked
  routes (no gradeDrama) don't render an empty/NaN Elevation bar.
- Scan result list (`App.tsx`): show ⛰️ grade when present.

## Testing
- New `elevation.test.ts`: gradeMetrics math, gradeDrama10 scale (Zoar-like high, flat low),
  sampleAlong spacing.
- `routeBuilder.test.ts`: loop mode surfaces a high-rank out-and-back alongside loops (the
  regression that hid Zoar); marquee path emits a standout single road.
- `composite.test.ts`: updated for the 6th weight + decoupled balanced; gradeDrama affects score.
- Full `npm test` + `npm run build` green; then an end-to-end check against live Zoar
  OSM+elevation data confirming gradeDrama and that the road now surfaces.

## Out of scope (deliberate)
- Destructive name/ref geometry merge of the global stitch graph (would drop interior
  junctions and *reduce* general stitching connectivity) — the marquee corridor walk gets the
  user-visible benefit without that regression.
- Re-baking the scenic/curated datasets with elevation (build pipeline change) — the scan is
  where road discovery happens; baked slates keep their pinned scores.
- Admitting straight-but-steep roads as candidates (needs elevation *before* the curve gate,
  i.e. elevation for the whole corpus) — noted as a future pass.
