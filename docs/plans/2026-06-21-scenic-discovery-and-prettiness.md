# Scenic Discovery & Roadside-Prettiness — Spec (2026-06-21)

**Trigger.** Two adversarially-validated multi-agent analyses: (1) the road **discovery**
step mis-ranks (cross-border pollution, length bias, mall-ring outliers, NY-242 buried at
#650); (2) **scenery** is the open problem — the `scenery/greenery/water/notability` rubric
fields are *guessed by an LLM* and make up **0.50 of every route's score**.

**Thesis (one line).** Measure prettiness the same way curvature is already measured —
deterministic, build-time, cheapest-first — and demote the LLM from *rubric author* to
*prose author*.

This spec is phased. **Phase A and the L0 scenery measure ship in this branch** (deterministic,
`$0`, no new runtime deps, all invariants preserved). Everything below the "Deferred" line is
designed but gated behind evidence, per the validators' 80/20 guidance.

---

## Architecture constraint (unchanged)

Static GitHub Pages, no backend. All work is **build-time `.mjs` scripts** that bake a
versioned dataset into `src/data/*.ts`; the app is a pure static consumer. CI = `npm test &&
npm run build` on push to `main` → Pages. So:

- Pure scoring logic lives in small, unit-tested modules (`scripts/lib/*.mjs` + `src/lib/*.ts`).
- Network-dependent regeneration runs in dedicated `scenic:*` npm scripts, **never** in
  `npm run build` — a flaky Overpass mirror must never break a deploy.
- The dataset-invariant tests (`scenicMetrics.test.ts`, `curatedRoutes.test.ts`) are the gate:
  `rubric.curvature === curvature10(coords)`, **`score === compositeScore(rubric)`**, no
  `heading:0`, no spur, `distanceKm ≈ pathLength`, slate **sorted by score desc**. Any data
  change must keep all of these green (re-measure curvature, recompute composite, re-sort).

---

## Part 1 — Discovery ranking fixes (`scripts/discover-roads.mjs`)

Diagnosis (confirmed against `scripts/data/discovered-roads.json`):

| # | Defect | Evidence |
|---|--------|----------|
| 1 | Raw bbox spills into Ontario | Haldimand Rd 20 (Canada) ranks **#1**; 8 ON roads in top-30 |
| 2 | String-only `ref`/`name` aggregation | phantom "Park Road" (value 5526) merges unrelated roads region-wide |
| 3 | Per-way scoring summed | NY-242 buried at **#650** (climb split across ways) |
| 4 | Ranks on raw TOTAL value (length-biased) | West Lake Rd (191 km, perKm 18.5) out-ranks Zoar Valley (perKm 265.9) |
| 5 | No "real road" identity | Eastview Mall Drive perKm **826.9** (a mall ring road) |

### Phase A — ships this branch (deterministic, no per-road regen required to be correct)

- **A1 — NY admin clip.** Prepend `area(3600061320)->.ny;` (NY State = OSM relation 61320)
  and AND `(area.ny)` onto each tiled way query. Removes every Ontario road — the only
  mechanism that can (their perKm is moderate, so no density gate catches them). NY-only for
  v1; PA-side roads near the south border are acceptable collateral (curator re-adds).
- **A2 — length-normalized, density-capped rank.** New field **`rankScore = min(perKm,
  DENSITY_CAP) * sqrt(lengthKm)`** with `DENSITY_CAP = 120`. Sort on it; recompute tiers on
  capped perKm (`≥90 excellent, ≥55 pleasant, else mild`). **Named `rankScore`, NOT `score`**
  (`score` is test-pinned to `compositeScore` elsewhere). Fixes length bias + mall outliers.
- **A3 — persist the full ranked corpus.** Today only the top-30 corridors are written and the
  other ~1772 roads are discarded; nothing downstream can ever target them. Write the full
  ranked list to `scripts/data/discovered-roads-full.json` so every rank claim is falsifiable
  and the scenery crawl (Part 2) has a corpus to target.
- **A4 — tile-success assertion.** Fail loudly if `okTiles` collapses (a silently-failing area
  clip would drop whole regions without the 10-road benchmark noticing).

Pure helpers added to `scripts/lib/scenic-metrics.mjs` and unit-tested: `rankScore()`,
`destinationPoint()` (geodesic offset, needed by Part 2 perpendicular sampling).

### Deferred (designed, evidence-gated)

- **Spatial stitch-then-score** (connected-component way joining → score once per chain →
  majority-vote labels). Recovers NY-242, dissolves phantom merges. Gated on measuring whether
  A2 alone already lifts NY-242 enough (the rerank, not the stitch, does most of the work).
- Lot/roundabout tag gates; `trunk` inclusion for US-219 (probably unwanted in a twisty list).

---

## Part 2 — Measured roadside prettiness (the scenery rubric)

`ScenicRubric.{scenery,greenery,water,notability}` (each 0–10) are currently LLM guesses.
Measure them in layered build passes, cheapest-first.

### L0 — OSM map-tell measure — **ships this branch**

`scripts/enrich-scenery.mjs` + pure module `scripts/lib/scenery-tells.mjs` (unit-tested).

For each **already-baked** route (Scenic + Curated slates — geometry already exists, so **no
LLM compose is needed**, we only re-measure the rubric):

1. Query OSM via Overpass for "tells" within the route's padded bbox, using `out center` so
   areas (forest/park/water polygons) collapse to a representative point — cheap and robust.
2. Categorize tells and compute, for each, the min distance to the route polyline
   (`distPointToPolylineM`) and a decaying proximity weight `exp(-d/τ)`.
3. Fold into measured 0–10 fields with **saturating** functions (never unbounded sums):
   - **water** ← coastline/lake/river/stream proximity, size-weighted (`coastline 1.0 > lake
     0.8 > river 0.6 > stream 0.3`).
   - **greenery** ← forest/wood/park/reserve adjacency **minus** ugly-landuse
     (industrial/retail/quarry/landfill) — the negative tell is what flags "twisty but ugly".
   - **scenery** ← viewpoint + peak/cliff proximity, blended with naturalness, **conditionally
     fused** (not summed): a lone signal can't max the field.
   - **notability** ← `max(scenic=yes/byway, viewpoint<150 m, national_park, wikidata-tagged
     feature nearby)`.
4. Keep `curvature` (re-measured from coords, unchanged), **recompute `compositeScore`**, and
   **re-sort** the slate. All dataset invariants stay green.

The LLM rubric numbers are replaced by measured, provenance-bearing values. The route-review
UI already "shows its work" (per-dimension rubric), so the change is visible and auditable on
Pages. `compositeScore` weights are unchanged for v1 (`compositeScore(rubric, weights)` takes
an override, so a later rebalance is a one-liner).

**Conditional-fusion rule (the key correctness point from validation).** Beauty is not any
single cheap signal: a lush tree-tunnel maxes greenery with zero views; a flat field maxes
openness. Signals are fused **conditionally (AND-ish), not additively**, so the measure tracks
what a rider finds beautiful. L0 implements the map-tell half of this; the openness/sightline
half needs L2 (DEM) and is deferred.

### Deferred (designed, evidence-gated)

- **L1 land-cover raster** (ESA WorldCover 10 m, keyless) — perpendicular-offset corridor
  sampling for measured %forest/%water/%developed. Needs a `geotiff.js` dep + S3 range reads.
- **L2 DEM viewshed** (AWS Terrarium, keyless) — Sky-View-Factor openness, overlook detection,
  water-**visibility** sightlines. Folds into the planned grade pass. Supplies the openness
  half of conditional fusion.
- **L2b Wikidata** notability by sitelink weight (cap radius tightly; weakest beauty signal).
- **L3 targeted Street View / Mapillary + CLIP scenicness** — the eye-level layer. **Gated:
  Google Street View Static is licensing-barred as a CV/bake input (TOS prohibits
  pre-fetch/derive/store); only Mapillary (CC-BY-SA) is clean, and its rural WNY coverage is
  thin (~2.65%).** Demoted to an optional tie-breaker behind a coverage probe. Capture geometry
  when it ships: **perpendicular headings** (`bearing ± 90°`), not down-road at the tarmac.

---

## Crawl-targeting strategy (answers "how to find views, not wander Street View")

The L0–L2 prior ranks roads by likely-prettiness **before any image is fetched**, turning a
blind Street View wander into a confirmation step: image only the top tranche, skip
high-building-density / industrial corridors via the **negative-tell penalty**, and — when L3
ships — capture at perpendicular headings gated by the **free** Street View metadata
pre-screen (`nearestPano`, already in `snap-streetview.mjs`).

---

## Ship sequence

1. **This branch:** Part 1 Phase A (A1–A4 + helpers/tests) + Part 2 L0 (enrich + tests +
   regenerated Scenic/Curated data). Deterministic, `$0`, invariants green → deploy to Pages.
2. Measure: does the re-ranked, re-scored slate look more like real WNY beauty? If yes, proceed.
3. L1 land-cover, then L2 DEM (shared with grade), then fusion of openness into scenery.
4. L3 only after a Mapillary coverage probe clears.

## Validation

- `npm test` (invariants + new pure-function unit tests) must stay green — it's the deploy gate.
- After enrichment, eyeball before/after rubric + ranking for sanity (no field pinned at 0/10
  across all routes; ordering a WNY rider would recognize).
- Future: a small human-rated WNY beauty set to calibrate the 0–10 mappings (the real work is
  calibration, not reweighting).

## Honest limitations

- L0 proximity is a *prior*, not eye-level truth — "near water" is not "water visible" (needs
  L2/L3); greenery proximity over-credits tree tunnels until openness (L2) gates it.
- Notability skews toward fame, the weakest beauty correlate; plan to down-weight once measured.
- Google Street View Static stays a runtime *display* source only — never a baked CV input.
