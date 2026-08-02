# Reel category — finding roads that film well

Design doc, **revision 2**. Status: `sun.ts` built and tested; the rest proposed.

Revision 1 was written from first principles plus one rider's notes, then put through five
adversarial validators and a live-API measurement pass. Most of its architecture survived. Most
of its *numbers* did not, and four of its scored dimensions had nothing under them. Everything
below is either measured or explicitly labelled as invented.

Measurements and provenance: `2026-08-01-reel-validation-evidence.md`. Where this doc states a
number, that doc says how it was obtained.

---

## 1. The question this answers

Scan asks *"is this road good?"*. Reel asks *"is this road good **at 20:15 on the 15th**,
ridden **west-to-east**?"* — for a 360 camera that reframes one spherical capture into several
virtual angles, feeding a 45–60 s vertical edit.

A rider cannot change a road's bearing. They can change **which direction they ride it** and
**when they start**. Those two are the deliverable.

This is not an integration with `D:\MotoProject`. Nothing here imports from it, writes into it,
or is scheduled by it.

## 2. What the ground truth actually is — read this before trusting anything downstream

The only human verdicts available are 32 good/bad calls on rendered shots from one 28-minute
suburban ride, one evening, one rider, one camera mount, one town.

- 32 verdicts (20 good / 12 bad) across 63 rendered shots — **49% of shots were never judged**.
- 24 distinct marks judged; **12 of 36 marks carry zero evidence**.
- Seven marks were judged more than once. Pairwise agreement 7/9 against 0.53 expected by
  chance ⇒ **κ = 0.53**. The same mark scored *good* as `rear` in one reel and *bad* as `rear`
  in another.

**That κ is the ceiling for any per-mark predictor.** Revision 1 promised to tell a rider
"before they ride" what a route will produce. Even a perfect predictor cannot clear ~78%
agreement with a human who does not agree with themselves beyond that. Every claim in this
document is bounded by it, and the UI must not imply otherwise.

## 3. What was cut, and why

| Cut | Reason |
|---|---|
| `motion` as a scored dimension | `min-motion 21` is a tautology — 21.0 *is* the minimum of the good class. Thresholds of 15/18/20/21 give an identical confusion matrix. AUC 0.719 → 0.625 → **0.545 (p=0.40)** once three shots with a *documented aiming bug* and one 9.5 s traffic stop are removed. 7 of 12 bad shots measured ≥21. Worse: the two lowest-motion marks are "parked at the lake" and slowing to look at it — **rider behaviour, not road geometry** — so a motion term would be anti-correlated with the `lead` term by construction. |
| `lead` (cold-open moment) | Derived from the only near-significantly **bad** shots: the lakeside `override` preset went 0 good / 3 bad, **p = 0.053**. "The composition carries it" rests on a re-aimed frame that has never been reviewed. |
| `variety` as a scored dimension | The sign is inverted: canopy-tagged shots scored **better** (11/15 = 0.73 vs 9/17 = 0.53). The 53% figure is an artifact of the motion floor — without it, 16/35 = **45.7%** and the rule never fires. No literature supports a variety-cost effect in either direction. |
| The ">50% cannot discriminate" rule | Inverts information theory: binary entropy is *maximised* at p = 0.5. The real quantity is selection leverage — choosing k of n, a tag only fails to matter when m ≥ k, so at k/n = 70% the threshold would be **70%, not 50%**. Independently, the threshold measures the **segmenter**, not the road: change the non-max-suppression radius and any tag crosses 50%. |
| The `[-4°, +6°]` light **gate** | Refuted by its own evidence. The reference footage was shot at **+20.9° to +15.5°**; its five `golden-hour` marks sit at **18.4°–20.4°**. The band opens 54 minutes *after* the footage ends. A gate scores 100% of available ground truth at zero. |
| Tag prediction for `scenery`, `open-road`, `traffic`, `hazard`, `golden-hour` | See §7. |

**What survives from revision 1:** the additive-category architecture, the structural argument
that a mean cannot see sameness, non-max suppression, the shared tag vocabulary as a
*reporting* convention, and the decision not to write a marks file.

## 4. The four dimensions

Parallel to `ScenicRubric`, never added to it — the baked datasets and the tile corpus stay
byte-identical.

```ts
export interface ReelMetrics {
  backdrop: number    // per-side: is there an open view, and to which side?
  cleanliness: number // inverse of suburbia — the headline complaint about the reference ride
  light: number       // sun elevation quality x directional alignment
  drama: number       // corners and crests, measured at window scale (NOT flowCurvature)
}
```

Ride level: `density` (marks/km) and the **tag distribution**, both reported as diagnostics
rather than scored. Reporting them costs nothing and is honest; weighting them is not supported.

### 4.1 backdrop — edges, not enclosure

Revision 1 treated enclosure (good for canopy angles) and openness (good for a side-profile
backdrop) as a trade-off. The literature says both extremes lose: Seresinhe et al. 2017 find
*"'No Horizon' and 'Open Area' are both negatively associated with scenicness"*. The winner is a
**framed view** — structure in frame *and* something to look out over.

So the target is the **edge**: tree cover on one side, ground falling away on the other. That is
also the one geometry serving both virtual cameras at once, which dissolves the conflict rather
than balancing it.

Two independent mechanisms, both required, because neither covers the other:

- **Terrain fall**, per side, from the DEM. Measured on real geometry: Letchworth Park Rd
  **130.3 m mean lateral fall, 0% left / 100% right** — it finds the rim *and* which side. Flat
  farmland (three longest ways in two boxes, no cherry-picking) averages **7.9 m**.
- **Water**, per side, from OSM polygons. **The DEM cannot see water at all** — a lake surface
  is flat, and the Lake Erie shore returned 0 m of fall.

**Honest ceiling.** Letchworth separates by 16×; Zoar Valley (23.3 m) and the lakeshore
(17.7 m) separate by only 2.2–2.9×. The detector reliably finds *major* relief; modest relief is
a hint, not a finding. This is partly a known DEM bias — Copernicus GLO-90 smooths narrow
valleys, measured as a 3.6× horizon-angle underestimate at Zoar — and it is **one-signed in the
optimistic direction**, so it systematically under-rates exactly the enclosed gorge roads we
want. Modest-relief roads lean on the water polygons and on Street View confirmation (§6).

Rules that came out of measurement:

- Rank on **magnitude plus side-consistency**, never a thresholded count. A count over 15 m
  produced two false positives in flat country (50% and 20% of segments) whose *mean* fall
  stayed at 11.6 and 10.3 m.
- Take **max fall over all probe distances**, and record the distance where it peaks — that is
  the scale of the landform, free. No single distance works: Zoar's signal lives at 200–800 m
  and **vanishes to 0 at 1500 m**; Letchworth's grows all the way out (34 → 129 → 142 → 149 m).
- Probes must be **≥140 m off-axis** to land in a different DEM cell (measured grid: **~69 m** at
  42°N). The 30–50 m near-field probe from revision 1 is meaningless — same cell, always zero.
  Near-field screening comes from OSM polygons, and only from them.
- Use a **hard sight-distance threshold, not `exp(-d/τ)`**. Water is the only sharp signal in the
  existing rubric (1.0 km plateau, against scenery's 1.6 km and peak-proximity's 2.6 km)
  precisely because `alongFrac` uses the 120 m `WATER_SIGHT_M` cutoff rather than a decay. Decay
  terms cannot localise a moment: adjacent 400 m windows differ by 3.5%.

### 4.2 cleanliness — measured signal, not the one revision 1 proposed

Revision 1 rested this on `landuse=residential`. Within 15 km of Ellicottville there are **four
such polygons**, and **zero at every rural site sampled** — it cannot rank rural roads against
each other, which is the entire job.

The signal is **`highway=residential|service` way density**: 20.6× separation and monotone
across the whole range — 1888 / 1609 / 559 / 198 / 130 / 54 / 13 from suburban Amherst to rural
Zoar. Roads are the best-mapped class in OSM. Power lines are kept as confirmation only (68×
separation but zero at four of seven sites). Buildings are **rejected** — Ellicottville village
returned more buildings than suburban Amherst, so the signal inverts where we need it.

### 4.3 light — report, never gate

`src/lib/sun.ts`, built and validated. NOAA/Meeus; verified by execution at **0.013° elevation /
0.026° azimuth against NREL SPA** (n = 26,280 over a year at Buffalo), sunrise/sunset/transit
exact against USNO. 37 tests, written against first principles rather than another calculator.

- `lightQuality10(elevation)` — continuous, calibrated so the reference footage at 15–21° scores
  **5.5–7.3** ("good, not peak") instead of zero. True golden hour still peaks at 10.
- `directionalLight10(offAxis)` — `|cos|`, so **backlit and frontlit score identically by
  construction**. The plate already clips ~2.7% of pixels white; preferring backlit would steer
  the rider into the one condition the camera cannot survive. The classification is reported;
  the choice is the rider's.
- `segmentLight` returns `kind: 'none'` below the horizon. Roughly a third of the conventional
  golden band is after sunset, where the direct beam is zero and "backlit" is not a weaker claim
  but a meaningless one.

Corrections to revision 1, all measured: the window is **~60 min** at 42.9°N, not 35–40; it is
**shortest at the equinoxes** (54.4 min) and **longest at the solstices** (65.7 in December,
64.2 in June); it **grows toward the poles** (126.8 min at 63°N). Revision 1 had the seasonality
and the latitude relationship backwards, and mis-converted 40 min at 45 mph as 30 km (it is
48 km). Ride-length budget is therefore **~45 km of light**, not ~30.

**Known gap:** the horizon is flat-earth. Measured terrain horizons — Zoar 2.02° (loses 42% of
the direct-sun window), Letchworth 3.13° (59%), Southern Tier median 1.32° with 70% above 0.5°,
against **0% on the Genesee plain**. In a gorge the sun goes behind the wall well before
elevation 0, so low-sun results in steep country are optimistic. A terrain horizon belongs here;
it is not in scope for v1 and is documented in the module.

### 4.4 drama — needs a new measure

`flowCurvature` is unusable at window scale, four independent ways: a `dist < 0.3` floor makes a
**200 m window always return 0**; `FLOW_MIN_TURN` 4° discards the per-vertex turning of a 45° arc
sampled finely (so the §5 resampling fix *destroys* the signal); `FLOW_MAX_TURN` 75° reads an 80°
kink — the most filmable corner there is — as 0.0; and dividing by distance saturates so the
usable range at 400 m is essentially {0, 10}.

Replace with **total unsigned heading change over a fixed-length window** (no division by
distance, no floor, no ceiling), or minimum radius of curvature. `gradeDrama` has no sub-road
resolution — one elevation sample per 400 m window, and ~70–100 m is the real DEM floor — so
crests are **not resolvable** and are out of scope for v1.

## 5. Machinery — smaller than revision 1 described

**Do not call `measureRubric()`.** Under this scope it is the wrong tool for three of four
dimensions, and nearly all of its cost is the water path we no longer score. Measured per 400 m
window: full rubric **41.6 ms** (→ 36.3 s per scan) against composed primitives at **1.09 s
total**, plus a per-side scan at 0.20–0.71 s. **Sub-second on the main thread; no Worker.**

Revision 1's affordability argument was false. It credited the spatial grid from `0f03928`, but
the three dominant costs are exactly the paths that grid does not cover.

Three pieces to build:

1. **An interpolating resampler.** Non-negotiable. **50% of real 400 m windows contain fewer
   than 3 sample points and 11% contain zero** (where `measureRubric` silently returns
   all-zeros); the same window at 3 vs 17 samples moves scores by up to **4.4 points out of 10**.
   `sampleAlong` cannot do this — it snaps to vertices, so 17 samples from a 3-vertex window
   returns 17 entries drawn from 3 distinct points and averages duplicates as independent.
   Target ≥16 samples/window (~25 m). ~15 lines.
2. **`sideScan(route, tells, maxM) → {leftFrac, rightFrac}`.** `measureRubric` has **zero
   directional awareness** — every signal is radial and none returns *which* feature or where —
   and its grid internals are module-private, so this cannot be derived from `greenContain`.
   Needs the grid exported (or a `withinM` alongside `anyWithinM`). ~40 lines, sub-second.
   `offsetPath` already has the tangent/normal sign convention to reuse.
3. **A window-scale curvature measure** (§4.4).

Then compose: cleanliness = `corridorSignal(uglyPts)` + `fractionInside(uglyAreas)` + corpus road
density; backdrop = `sideScan` + DEM probes; light = `sun.ts`.

**Give `ReelMetrics` its own calibration.** The same feature reads ~6× stronger in a 400 m window
than in a 22 km route, so every threshold tuned on whole routes is void here
(`TRUE_SHORE_FRAC`, `CREEK_FRAC`, `WOODED_CONTAIN`, `COMPOSITE_WEIGHTS`). **Never compare a
window score to a ride score.**

**Do not spatially pre-filter tells per window.** The intuitive optimisation builds a fresh array
per window and would defeat `bboxCache`, `gridCache` and `waterSplitCache` at once — dramatically
slower. Always pass the full stable arrays.

## 6. Street View confirms what map data ranks

`scenicImagery.ts:28` `streetViewStaticUrl(lat, lon, heading, …)` already exists and already
takes a **heading**, so the shoot card can render the actual view perpendicular to travel at any
mark, today, with the key already wired.

- **map data + DEM → RANKING.** Cheap, covers every candidate, no quota.
- **Street View → CONFIRMATION.** One request per frame, so only for marks the rider opens.

This is the single best de-risker in the design. Given κ = 0.53 and a terrain detector that only
separates 2.2× on modest relief, showing the rider the real roadside beats any inference we can
make about it.

## 7. Costs, budgets and open problems

- **DEM probes are over budget.** 8 rides × 22 km at 200 m × 2 sides × 4 distances = 7,040 points
  ≈ **71 Open-Meteo requests**, against a current `ELEV_POINT_BUDGET` of **700 points**. This is
  the one genuinely unbudgeted cost. Options: probe only the shortlist, coarsen to 500 m spacing,
  or raise the budget deliberately. Measured limit: HTTP 429 at ~10–15 requests in 2 minutes, so
  rays must share 100-point requests and cache.
- **The supplementary Overpass query is not cheap in the way that matters.** Wall time is
  near-constant dispatch overhead (24.4 s at 1.9 MB, 34.9 s at 55 MB), so bolting it onto a
  tile-sourced scan takes it from ~1 s to ~20–25 s — negating the corpus it rides on. And
  `residential|service` is the *dense* class (1,888 ways in 12.6 km² suburban). Unresolved;
  folding these classes into a tile rebuild may be the better answer after all.
- **Never route new classes through `categorizeFeatures`.** `features.ts:199` is a catch-all
  (`else if (t.landuse || …)`) so any unmatched landuse becomes *ugly*, feeding `uglyFactor` into
  `greenery` (−5×) and pinning `naturalness` at 0.3. Adding residential to `buildTellsQuery`
  would silently rescore every Scenic, Curated and Scan result. Revision 1 §3 called this "one
  line of Overpass QL"; that framing was wrong. Use a **separate query with a separate
  categoriser**.
- **Junction density is genuinely free** — `AreaScan.corpus` already carries the ways and
  `routeBuilder` already builds a rounded-endpoint index. Note `residential|service` is *not* in
  the corpus, so only junction density is free; suburbia still needs the query.

### Prerequisites — two live bugs, worth fixing regardless of Reel

- **`measureRubric` defeats its own grid cache.** `openTells`/`minorTells` (`sceneryTells.ts:370-371`)
  are `.filter()` results — fresh arrays every call — so `gridFor` rebuilds a grid over 66,067
  points each time. Measured **2.10 ms stable vs 20.29 ms as written**; `scanArea` calls it for up
  to 300 roads, so ~**4–5 s of redundant work per Overpass scan**. `routeBuilder` already solved
  this with `waterSplitCache`; the fix never made it inside `measureRubric`.
- **The tile corpus has no version guard.** `WireTile.v` and `Manifest.v` are never read. A cached
  old tile → `decodePath(undefined)` → TypeError → caught by `fetchAreaScan` → **silent permanent
  fallback to Overpass**, i.e. every scan becomes a 25 s scan with only a `console.warn`. Fix
  before the corpus gains any field.

## 8. Tag prediction — honest, and wishful

Predictions use `D:\MotoProject`'s closed enum verbatim, as a **reporting** convention. Adopting
a shared word with a different referent is worse than no shared word, so where their corpus
defines a tag differently, that is noted rather than silently redefined.

**Honest:** `corner` (curvature), `urban` (built-up + junctions), `gravel` (`paved === false`),
`canopy` (containment — though the project's own frame measurement says the label is over-applied,
and that canopy is a property of the *(mark, angle)* pair, not the road).

**Half-honest:** `water` — presence yes, **visibility no**. `WATER_SIGHT_M` is a plain radius with
no occlusion model, and their corpus contains a documented case where a six-way yaw sweep at the
mark's peak found *no water at any bearing* — trees, a fence and a car-park shelter. Revision 1
declined to model dappling as not honestly derivable from OSM; occlusion deserves the same
treatment and did not get it.

**Dropped as wishful:** `scenery` — falsified on its own data (7 of 12 scenery marks are one
municipal park with mown lawns; **zero involve a viewpoint or peak**, which is exactly what
`sceneryTells` computes). `open-road` — does not mean low enclosure; 4 of 9 are *also* tagged
canopy, including "tunnel feel". `traffic` — half duplicates `urban`, half is a stranger's car.
`hazard` — their one instance is "pedestrians on the shoulder", not steep grade. `golden-hour` —
see §3.

**Related existing bug:** `features.ts` pools `leisure=park` with `landuse=forest` into one
`greenAreas` bucket, so mown lawn scores like closed forest. The literature is explicit that flat
green is *un*scenic. Reel must separate tree cover from grass. Whether to also fix Scenic/Scan is
a separate call — it moves baked scores.

**Named conflict, unresolved:** the rider's most-tagged scenic location is a municipal park with
lawns, which the literature says is unscenic. n = 1 rider preference is weak; so is a
UK-crowdsourced photo-rating model applied to a 9:16 motorcycle reframe. Recorded rather than
resolved in the literature's favour.

## 9. Build order

1. ~~`src/lib/sun.ts`~~ — **done**, 37 tests.
2. The two prerequisite bug fixes (§7). Small, independent, and they make everything after
   measurable.
3. Interpolating resampler + window-scale curvature. Pure, testable, no network.
4. `sideScan` primitive + grid export.
5. `reelTells.ts` — separate query, separate categoriser.
6. `reelScore.ts` — compose the four dimensions; own calibration.
7. Reel tab + shoot card + Street View confirmation.

Steps 2–6 are pure and verifiable before anything is visible.

## 10. Not building

- A marks-file writer — no clip, no timestamps.
- Dappling, and sightline **occlusion** — neither is honestly derivable from OSM polygons.
- Traffic-volume prediction — only weak proxies exist; folded into `cleanliness` as a proxy and
  labelled as one.
- A terrain horizon for the sun model (§4.3) — real, measured, out of scope for v1.
- Crest detection (§4.4) — not resolvable at 69 m DEM.
- Any change to `COMPOSITE_WEIGHTS` or the shared rubric.
