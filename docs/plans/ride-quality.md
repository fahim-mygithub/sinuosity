# Plan: ride-quality fixes (U-turns, backtrack spikes, speed/surface) — HARDENED

Three confirmed defects in the Live-scan ride builder. All fixes are **runtime scan-path only**
(`overpass.ts` → `routeBuilder.ts` → `geometry.ts` → `types.ts`). Baked Scenic/Curated datasets and
the `scripts/` pipelines are NOT touched.

This version has the adversarial hardening (8 blockers / 18 majors) folded in as **locked
decisions**. Build to this spec exactly.

## Invariants that MUST stay true (do not break)
- `compositeScore` and `ScenicRubric` are UNCHANGED. `compositeScore(...)` call at
  `routeBuilder.ts:202` stays byte-for-byte.
- **`ride.score === compositeScore(ride.rubric, bias)` for every scan ride** (M0). The 0–100 Score
  badge stays pure composite, consistent with the rubric meters beside it (App.tsx:502/592,
  ScenicRouteReview.tsx:105/133/182). Rideability/shape NEVER enter `.score`.
- No edits to `scenicRoutes.ts`, `curatedRoutes.ts`, `scenicScore.ts`, or anything in `scripts/`.
- Overpass query strings stay **byte-identical** (`out geom;` already returns way tags, so
  `parseRoads` can read them with no query change — preserves `scanCache`/`areaCache` keys and the
  cache test). (N8)
- TS is strict (`noUnusedLocals`, `noUnusedParameters`). New fields on `ScannedRoad` are optional/additive.

## Build order: **3 → 1 → 2** (reordered per M3 — loops must exist before the seam guard)

---

## Phase A — foundation (`types.ts`, `geometry.ts`, `overpass.ts`)

### A1. `types.ts` — additive optional fields on `ScannedRoad`
```ts
highway?: string;
surface?: string;
maxspeedMph?: number | null;
paved?: boolean;
oneway?: string;        // for loop-closure wrong-way guard (M10)
```

### A2. `geometry.ts` — pure, unit-tested helpers
- `parseMaxspeedMph(raw?: string): number | null` (M6). Grammar:
  - lowercase+trim; if empty/undefined → `null`.
  - `none` → `70` (sentinel high, never penalized); `walk` → `3`.
  - `signals`, `variable`, country codes `/^[a-z]{2}:/` (e.g. `ru:rural`, `de:urban`) → `null`.
  - reject `knots`/`kn` → `null`.
  - split on `;`, take the **min** documented numeric value (safer penalty signal).
  - regex `/([0-9]+(?:\.[0-9]+)?)\s*(mph|km\/h|kmh|kph)?/`: with `mph` → that number; with a
    km/h unit → convert (`*0.621`, round); **bare number → km/h per OSM, return as-is converted to
    mph BUT treat as informational** (penalize only an explicit low *mph*; see A5/B-rideability).
  - To keep it simple and safe: return mph (converting km/h units), `null` when unknown. The
    *neutrality* of unknown is enforced in `rideabilityFactor`, not here.
- `UNPAVED = new Set(['unpaved','gravel','fine_gravel','compacted','dirt','ground','earth','grass','sand','pebblestone','mud','woodchips'])`
  and `isPaved(surface?: string): boolean` — **unknown ⇒ true** (most WNY tertiary/unclassified is
  paved+untagged) (M6/M7).
- `cumulativeKm(coords): number[]` — prefix-sum of path length so any sub-arc `i→j` length is O(1).
  Used by `dropBacktracks` to avoid O(n³) (N2).
- `dropBacktracks(coords, opts?)` — see **Phase C** (built last, after loops exist; M3). Stub-free:
  do NOT add it in Phase A.

### A3. `overpass.ts` `parseRoads` — populate the new tags
Read `el.tags?.highway`, `el.tags?.surface`, `el.tags?.maxspeed` → `maxspeedMph`,
`isPaved(surface)` → `paved`, `el.tags?.oneway`. No query change.

### A4. `overpass.ts` `scanArea` candidate set — **do NOT hard-drop unpaved** (M7)
Keep unpaved roads in the corpus/stitch graph (they're often the shared junction that lets two
paved sweepers chain; deleting them fragments the graph and *creates* out-and-backs). Rideability
demotes them instead. (No `pavedOnly` UI this pass — keep scope tight; note it as a future toggle.)

### A5. Tests (Phase A): `parseMaxspeedMph` table incl. `'none'`,`'walk'`,`'ru:rural'`,
`'30 mph;50'`,`'50'`,`'50 mph'`,`'signals'`,`undefined`; `isPaved` incl. unknown⇒true;
`cumulativeKm` matches `pathLength`.

---

## Phase B — loops & honest shape (`routeBuilder.ts`)

### B1. Track `chainRoads: ScoredRoad[]` alongside `chain` (M5)
Push `roads[next]` / unshift `roads[prev]` in the growth loops; thread into `toScenicRoute` so
per-leg `highway/surface/maxspeedMph/paved` are available to `rideabilityFactor` and `drivingTime`.

### B2. **Used-set rollback** (M4)
Buffer claimed road indices in a local `claimed: number[]`; add to the shared `used` set ONLY after
the `km >= minKm && coords.length >= 4` gate passes. A discarded chain frees its roads for later seeds.

### B3. Loop-gravity growth — **tail-only**, anchored at `start = seed.coords[0]` (M8/M9)
- Drop head growth; grow only the tail so `start` stays the true anchor.
- `farEndpoint(i)` = the candidate road's endpoint NOT equal to current `tailKey`.
- Neighbour pick: composite stays dominant; once `chainKm > targetKm*0.5`, apply a *nudge*
  `score = comp[i] - RETURN_BIAS * progress * distToStartKm(farEndpoint(i))`, `progress` ramps 0→1
  over the second half. **Accept a biased pick only if it strictly reduces distance-to-start**
  (`distToStart(newTail) < distToStart(curTail) - EPS`); else fall back to best-composite.
- `RETURN_BIAS` capped so homeward pull can never starve a ride below `minKm`. If biased growth
  dead-ends early, fall back to the **un-biased** walk for that seed (never return less than today).
- Raise tail cap to ~18 roads (was 14) to compensate for dropped head growth.

### B4. Honest **shape classification** (M10) — `shape: 'loop' | 'out-and-back'`
- `loop` ONLY when the walk closes **through the graph** (tail endpoint key matches a junction node
  already on the chain / the start node — a real cycle) AND `haversine(start,end) ≤ LOOP_CLOSE_KM`.
  Euclidean proximity is necessary, NOT sufficient.
- Refuse to count a closure that requires traversing a `oneway` road backwards.
- `LOOP_CLOSE_KM = clamp(targetKm*0.08, 0.3, 2.0)` for classification (tighter than growth).
- Everything else → `out-and-back`.

### B5. `rideabilityFactor(chainRoads): number` ∈ [0.6, 1.1] (M6/M7)
- `null`/unknown maxspeed ⇒ **exactly 1.0** (neutral). Untagged WNY backroad ranks on geometry as today.
- Penalize only KNOWN ≤30 mph; reward only KNOWN ≥45 mph; small bonus tertiary/secondary over
  unclassified; small penalty per unpaved leg. Cap the speed term so untagged regions ≈ unchanged.

### B6. Ranking — keep `.score` pure; sort by an internal key (M0/M11)
- `ride.score = compositeScore(rubric, bias)` (unchanged, pure).
- Sort `buildRides` output by internal `rank = ride.score * rideabilityFactor(chainRoads)` (shape is
  a tie-breaker only — **NO score multiplier for out-and-back**; flat ×0.9 is removed).
- Update `routeBuilder.test.ts` ordering assertion: replace "descending by `.score`" with the
  scan-path purity invariant `ride.score === compositeScore(ride.rubric, bias)` (test #9) and assert
  descending by the documented rank (export a small `rideRank` helper, or assert non-strict).

### B7. Shape into copy + name — **leave theme cascade & descriptors byte-for-byte** (M11)
- `theme` cascade (routeBuilder.ts:356-363) and `Carver/Run/Creek Run/Shoreline Run/Woodland Run/
  Landmark Loop` descriptors UNCHANGED so the exact-substring honesty tests (routeBuilder.test.ts:
  111/113/124/125/136/139) keep passing — EXCEPT: make `'Landmark Loop'` shape-aware so an
  out-and-back notable ride is NOT titled "...Loop" (M11). Use `'Landmark Loop'` only when
  `shape==='loop'`, else `'Landmark Run'`. (Check the honesty tests don't assert "Landmark Loop"; if
  one does, it's a loop case — verify.)
- Append shape clause to `summary`/`whyRide` only: loop → "Loops back near where it starts.";
  out-and-back → "Out-and-back — you'll retrace your path to return." (N4: when gap non-trivial,
  "Ends about {d} km from the start.").

### B8. Scan `drivingTime` from posted speed (M12)
Scan-path only: derive from chain-weighted average known posted speed (clamp ~25–60 mph), fall back
to 55 when no leg has a known speed. Baked datasets' `drivingTime` untouched.

---

## Phase C — backtrack/spike removal (`geometry.ts` + wire into `routeBuilder.ts`)

### C1. `dropBacktracks(coords, { rejoinM=70, minArcKm, bandM=rejoinM, start? })` (M1/M2/N1/N2/N3)
- Run on the **cleaned, pre-downsample** line (true rejoin vertices present), using `cumulativeKm`
  for O(1) sub-arc length.
- For each `j`, find earliest `i` with arc-length gap ≥ `minArcKm` where `metersBetween(coords[i],
  coords[j]) ≤ rejoinM` AND arc(i→j) ≥ `excursionRatio(=1.8) ×` straight(i→j) **AND the interior
  actually RETRACES**: sample midpoints of the outbound half and require each within `bandM` of the
  return half (Fréchet-style band, same idea as `cleanCoords`'s 30 m retrace at geometry.ts:124).
  → collapse `coords[i+1..j-1]`, keep a single pass-through. A 40–60 m-spaced hairpin does NOT
  retrace (limbs offset) → preserved. A figure-eight crossing does not retrace → both lobes kept.
- **Cap a single collapse to ≤40%** of points (no mid-route self-approach can amputate a lobe).
- **Loop-seam guard (geometric, M2):** when `start` is provided AND the ride is `shape==='loop'`,
  skip the pair where BOTH `haversine(coords[i],start)` and `haversine(coords[j],start)` are small
  vs `LOOP_CLOSE_KM` (that rejoin IS the intended closure). For `out-and-back`, do NOT exempt an end
  spur — that's the Eddy's-Overlook bug we're fixing.
- **Guarantee ≥4 output points** (N3) so the `coords.length < 4` gate can't be tripped.

### C2. Wire into `buildRides` (after shape is known, so the seam guard can gate on it)
Order: `cleanCoords(chain.flat())` → `dropBacktracks(..., {start, shape})` → `downsample(150)`.
Recompute `km`/`distanceKm` from the post-collapse coords.

---

## New edge-case tests (all 12 from hardening)
1. `dropBacktracks` preserves a 40–60 m-spaced hairpin. 2. preserves both figure-eight lobes.
3. collapses an end-of-ride dead-end spur on an out-and-back (Eddy's regression). 4. never <4 pts;
`distanceKm == pathLength(post-collapse)`. 5. minKm-failing chain frees its roads (used rollback).
6. two equal-composite spurs near start → no sub-minKm loop, budget not exhausted. 7. two disjoint
parallel legs <2 km apart sharing no junction → `out-and-back`, not `loop`. 8. tiny-radius scan →
no regression to `[]`. 9. `ride.score === compositeScore(ride.rubric,bias)` for every ride.
10. `parseMaxspeedMph` table + `rideabilityFactor(null,unknown)===1.0`. 11. all-tags-absent ⇒
factor constant 1.0 ⇒ ordering purely composite. 12. maxed-rubric scan ride keeps `score ≤ 100`.

## Final gate
`npm test && npm run build` clean. Then commit (msg ends `Co-Authored-By: Claude Opus 4.8 (1M
context) <noreply@anthropic.com>`), push to `main`, verify the Pages deploy goes green.
