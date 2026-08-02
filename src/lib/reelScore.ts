// Composition: the four Reel dimensions, ranked into direction-aware marks. Everything else in the
// category was built so this file could be short.
//
// TWO STAGES, and the split is the point. {@link buildMarks} is synchronous and touches no network:
// it cuts windows, scores drama from geometry, backdrop from the water tells already sitting in
// `scan.catalog`, cleanliness from the two free junction proxies over `scan.corpus`, and light from
// reelPlan — then selects and returns. {@link enrichMarks} refines that shortlist afterwards with
// the DEM lateral fall and the built-up query, and re-ranks. The reason is measured rather than
// stylistic: the built-up Overpass query costs ~20-25 s of near-constant DISPATCH overhead (24.4 s
// at 1.9 MB against 34.9 s at 55 MB — it is dispatch, not payload), which would otherwise wipe out
// the tile corpus that resolves a scan in about a second. Neither enrichment may block or break the
// first result; if both fail the marks from `buildMarks` stand, still honest, only less precise, and
// `CleanReading.provisional` is how the UI knows which of the two states it is looking at.
//
// BACKDROP SELECTS; THE OTHER THREE RANK. That is the composite's real shape, it emerged rather than
// being designed, and it is easy to mistake for a defect: backdrop carries the heaviest weight and is
// the LEAST discriminating dimension on the list the rider actually sees. Read the Backdrop section
// below before "fixing" that. It is saturated on the shortlist because it chose the shortlist.
//
// CALIBRATION — read before copying any threshold in or out of this file. `ReelMetrics` has its OWN
// calibration. The same feature reads about 6x stronger in a 400 m window than in a 22 km route, so
// every threshold tuned on whole routes is VOID here: `TRUE_SHORE_FRAC`, `CREEK_FRAC`,
// `WOODED_CONTAIN` and `COMPOSITE_WEIGHTS` are not imported and must not be. Never compare a window
// score to a ride score — they are different quantities that happen to share a 0-10 axis. Nothing
// here writes to `ScenicRubric` or `COMPOSITE_WEIGHTS` either; the baked scenic and curated datasets
// and the tile corpus have to stay byte-identical.
//
// `measureRubric` is deliberately NOT called. Under this scope it is the wrong tool for three of the
// four dimensions, and nearly all of its cost is the water path Reel no longer scores: 41.6 ms per
// 400 m window (36.3 s per scan) against 1.09 s total for the composed primitives below.
//
// AND NEITHER IS ANY OTHER MEASUREMENT THAT DOES NOT RANK. This module runs on the main thread on
// every debounced rebuild, so the budget is spent on signals the composite reads. Measured on the
// real 11-tile Buffalo scan (300 roads, 1,404 windows): `fractionInside(greenAreas)` is 379-409 ms
// against 110-131 ms for `fractionInside(uglyAreas)` and 104 ms for the four banded water passes,
// because there are 8,124 green polygons against 2,396 ugly ones and `fractionInside` has bbox
// rejection but no spatial index. It bought exactly one tag, which is why that tag is gone (see
// `ReelTag` in reelTypes.ts) and why `uglyPts` is not read (see {@link scoreClean}). Dropping it
// took `buildMarks` from 614 ms to 262-314 ms even after the banded water passes were added.
//
// And the ceiling on all of it: kappa = 0.53 (see reelTypes.ts). Several numbers in this file are
// invented rather than measured, because there is no ground truth that could calibrate them. Each
// one says so.

import { haversine, type LatLng } from './geometry';
import type { ScannedRoad } from '../data/types';
import type { AreaScan } from './overpass';
import { cutWindows, drama10, suppressNearby } from './reelGeometry';
import { bestDirection, lightAt } from './reelPlan';
import { builtDensityNear, fetchBuiltIndex, type BuiltIndex } from './reelTells';
import { fetchLateralFall, terrain10, MAX_PROBE_WINDOWS } from './reelTerrain';
import {
  BACKDROP_MIN,
  BACKDROP_WATER_M,
  FULL_BUILT_DENSITY,
  FULL_JUNCTION_DENSITY,
  FULL_JUNCTION_PER_KM,
  REEL_WEIGHTS,
  flipSides,
  type BackdropReading,
  type CameraAim,
  type CleanReading,
  type LateralFall,
  type LightReading,
  type PerSide,
  type ReelMark,
  type ReelMetrics,
  type ReelTag,
  type RoadWindow,
  type Side,
} from './reelTypes';
import { fractionInside, waterSplit } from './sceneryTells';
import { sideScanWeighted } from './sideScan';

const D2R = Math.PI / 180;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** One degree of latitude on the sphere `haversine` uses (R = 6371 km). Cell geometry below is
 *  derived from it while the in/out test is `haversine`, so a different radius here would make the
 *  swept cell window fractionally smaller than the disc it is supposed to contain. */
const M_PER_DEG_LAT = (6371000 * Math.PI) / 180;

// ------------------------------------------------------------------------------------------------
// Window-scale calibration
// ------------------------------------------------------------------------------------------------

/**
 * Number of nested distance bands the water magnitude is read over, inside `BACKDROP_WATER_M`.
 *
 * WHY THERE IS A MAGNITUDE AT ALL, and — read this second half before re-tuning anything — exactly
 * what it bought and what it could never buy. The first version of this scored "was there a hit on
 * this side", which made the dimension a near-binary flag: measured over all 1,404 windows of a real
 * 30 km scan, water-only backdrop was exactly 0 for 60.4% of windows and exactly 10 for another
 * 34.0%, leaving 5.6% to do the ranking and 11 distinct values in total. That is the mirror image of
 * the defect `terrain10` was written to avoid on the terrain side: "rank on magnitude, never a
 * thresholded count".
 *
 * Banding fixed that WHERE IT WAS BROKEN, which is the window-scale distribution — the quantity that
 * decides which windows get selected at all. Re-measured on the 83-tile corpus after the banding
 * landed: across all 1,417 windows backdrop now takes 45 distinct values with sd 4.26 (57.9% exactly
 * 0, down from 62.3; 21.2% exactly 10, down from 32.4), against 11 distinct values before.
 *
 * It did NOT de-saturate the top-40 shortlist, where backdrop still reads min 9.1, 92.5% exactly 10,
 * 3 distinct values, sd 0.204 — and THAT IS THE DESIGN RATHER THAN A DEFECT STILL TO BE FIXED. This
 * paragraph used to claim the opposite, and the claim invites exactly the wrong repair. Banding a
 * term cannot de-saturate it ABOVE the selection threshold; only a selection not dominated by that
 * term could, and backdrop's 0.40 weight is precisely what makes it dominate the selection. See the
 * Backdrop section below for the full statement and the numbers. Flattening this term to spread the
 * shortlist would flatten the one dimension doing the selecting.
 *
 * So what the banding is load-bearing for is the SELECTION: it is what stops a 390 m smudge at one
 * end of a window from clearing `BACKDROP_MIN` and entering the shortlist at all (see
 * {@link FULL_WATER_FRAC}), and what lets a near lake outrank a far one among the windows competing
 * to get in.
 *
 * WHY BANDS RATHER THAN A DECAY. `BACKDROP_WATER_M` must stay a HARD cutoff — a decay term cannot
 * localise a moment (adjacent 400 m windows under one differ by 3.5%), which is the whole reason
 * windows exist. So the shape is a hard cutoff with a graded magnitude INSIDE it. Reading
 * `sideScanWeighted` at nested radii r_k = k * BACKDROP_WATER_M / WATER_BANDS gives exactly that
 * and needs no new primitive: the side scan gives each sample to its SINGLE nearest tell, so
 * shrinking the radius can only remove samples, never move one to the other side, and the mean of
 * the K coverages is therefore a per-sample staircase in distance — full strength inside the
 * nearest band, 1/K at the cutoff, zero beyond it. Composing the existing primitive also keeps ONE
 * authority for which side a feature is on; a private per-hit loop here would be a second one, and
 * two disagreeing side classifications is the failure sideScan.ts warns about at length.
 *
 * 4 bands is 100 m steps at BACKDROP_WATER_M = 400: 1.00 / 0.75 / 0.50 / 0.25. Measured, the hits
 * inside the cutoff are spread right across it (p25 = 84 m, p50 = 154 m, p75 = 252 m, p90 = 337 m),
 * so 100 m is fine enough to separate "fills the frame" from "smudge" and coarse enough not to
 * pretend the underlying polygons are surveyed to the metre. Cost is measured: 104 ms for four
 * passes over 1,404 windows against 54 ms for one.
 *
 * SIZE IS NOT A SECOND MAGNITUDE, and that is a measurement rather than an omission. `WeightedTell.w`
 * does encode size (coastline 1.0 > canal 0.85 > lake 0.8 > river 0.5 > stream 0.3) and the big
 * distinctions in it are ALREADY APPLIED, as a hard gate, by `OPEN_WATER_W` = 0.7 — river and stream
 * are excluded outright, which is the Heim Rd audit's finding (0.25 ha ponds behind houses and a
 * creek in a wooded gully drove a 7.6 water score with no visible water). Inside the surviving open
 * set there is almost nothing left to grade: across all 83 tiles it is 96.9% lake / 2.1% canal /
 * 1.1% coastline, and of the 8,167 hits an actual scan makes, 94.7% are lake and 5.3% canal — a
 * 0.80-to-0.85 spread over one hit in twenty, which moves a 0-10 score rounded to one decimal by
 * less than its own reporting quantum. Grading it would also cost a second filtered array and a
 * second spatial grid per band. Recorded here so it is not proposed again as free.
 */
export const WATER_BANDS = 4;

/**
 * Water magnitude (coverage x proximity, both 0-1) at which a side reads as a full-strength water
 * backdrop.
 *
 * SET BY THE CASE IT MUST EXCLUDE, not by the case it must saturate — the same discipline
 * `CROSS_ROAD_COLLINEAR_DEG` uses in reelGeometry.ts. The case is the one that made the old
 * coverage-only reading dishonest: THREE of a window's seventeen samples seeing water, i.e. ~70 m of
 * a 400 m window and about three seconds at the 45 mph this category is dimensioned around, used to
 * score 3.5 and clear `BACKDROP_MIN` outright. At 0.6 that case reads 2.9 even when all three of
 * those samples sit inside the NEAREST band, and less at any greater distance, so a glimpse can no
 * longer call itself a backdrop at any range. At 0.5 it lands on exactly 3.5, i.e. on the bar.
 *
 * What it costs, stated rather than hidden: 0.5 was the value at which a causeway saturated both
 * sides exactly. `sideScanPoints` gives each sample to the side of its SINGLE nearest feature, so
 * water on both sides reads ~0.5/0.5 rather than 1.0/1.0, and at 0.5 that physically-best case
 * scored 10 on both. At 0.6 it scores 8.3 on both — still the top band, no longer the maximum. That
 * under-read is a documented property of the primitive ("callers reading a near-even split should
 * treat it as both sides"), and `scoreBackdrop` returns both sides so a caller can see it. Trading a
 * causeway's 10 down to 8.3 to stop a three-second glimpse clearing the backdrop bar is the right
 * way round.
 *
 * Measured effect over all 1,404 windows of a real 30 km scan, water-only: exactly 10 falls from
 * 34.0% to 20.7%, the range between the ends grows from 5.6% to 18.9%, and the number of distinct
 * scores goes from 11 to 45.
 */
export const FULL_WATER_FRAC = 0.6;

/**
 * Radius (m) over which built-up way density is read for one window.
 *
 * INVENTED. It has to be wider than `WINDOW_M` so the disc describes the window's SURROUNDINGS
 * rather than the strip of road itself, and narrow enough that a village a kilometre off does not
 * condemn a rural window — localising a moment is the reason windows exist at all. 800 m sweeps
 * 2.0 km², about five times the window's own footprint, which satisfies both.
 *
 * The radius does NOT have to match the r = 2 km disc `FULL_BUILT_DENSITY` was calibrated over,
 * because `builtDensityNear` divides by the actual disc area and a density is a density. Reading it
 * over a tighter disc is the point: it localises the suburbia to the window instead of averaging it
 * over the whole neighbourhood, which is the same reason windows exist at all.
 */
export const BUILT_RADIUS_M = 800;

/**
 * How close a way's endpoint has to sit to a window sample to count as a junction ON that window (m).
 *
 * Half of `RESAMPLE_M` — 12.5 m — is the worst case for a node lying exactly on the resampled
 * polyline, since samples are that spacing apart. The rest is slack, and it is INVENTED: chord sag
 * across a 25 m step on a real bend, and the fact that a side road's terminal node is not always
 * precisely the shared junction node. Too tight and genuine junctions are missed; too loose and a
 * parallel service road's ends start counting, so this stays much smaller than the ~11 m quantum of
 * the endpoint key itself times a small factor.
 */
export const JUNCTION_NEAR_M = 30;

/** Grid cell edge (m) for the junction index. Any value comfortably above {@link JUNCTION_NEAR_M}
 *  works, since the query sweeps a 3x3 cell neighbourhood; 250 m keeps buckets small on a suburban
 *  corpus without making that neighbourhood large. Invented, and the answer does not depend on it —
 *  every candidate still gets an exact `haversine` test. */
const JUNCTION_CELL_M = 250;

/**
 * Drama at which a window earns the `corner` tag.
 *
 * 4.0 is 60 degrees of total heading change inside 400 m, using the two reference points
 * `FULL_HEADING_CHANGE_DEG` already carries: one sweeping 90 degree bend lands at 6, and a
 * switchback pair at 10. 60 degrees is one real bend rather than a road drifting off true. The
 * placement between those two anchors is invented; the anchors are not.
 */
export const TAG_CORNER_DRAMA = 4.0;

/**
 * Cleanliness at or below which a window earns the `urban` tag. Set to mirror `BACKDROP_MIN` so the
 * two "is this real, or merely slightly so" bars in the category agree with each other; the value
 * itself is invented. At 3.5 the window is at ~65% of the saturating junction or built-up density,
 * which is a place a rider would call built-up rather than a place with a couple of driveways.
 */
export const TAG_URBAN_CLEAN = 3.5;

/**
 * Marks returned when the caller names no limit.
 *
 * Deliberately equal to `MAX_PROBE_WINDOWS`, so that every mark `buildMarks` returns is a mark
 * `enrichMarks` can afford to probe for terrain. A larger default would hand the rider a tail of
 * marks that can never receive the strongest of the two backdrop mechanisms, and nothing in the
 * result would say so.
 */
export const DEFAULT_MARK_LIMIT = MAX_PROBE_WINDOWS;

/**
 * Composite gap (points out of 100) below which the two directions of a window are a TIE.
 *
 * Half of the composite's own reporting quantum, since `reelComposite` rounds to whole points — so
 * today this is exactly float equality, and it is written as an epsilon to state the intent rather
 * than to widen it. The intent matters because the tie is not a corner case here: verified on all
 * 1,404 windows of a real 30 km scan, the two directions' light scores are IDENTICAL on every one
 * of them (both aim functions are symmetric about 90 degrees and the elevation term is the same
 * instant), and every other metric is flip-invariant, so the composites tie always. If the composite
 * ever gains a decimal place, or an asymmetric aim function lands, this keeps meaning what it says.
 */
const COMPOSITE_TIE_TOL = 0.5;

/** What the rider is asking for: an instant, a virtual camera, optional weights, optional depth. */
export interface ReelOptions {
  /** The shoot instant. Absolute — reelPlan is timezone-free and this inherits that. */
  at: Date;
  aim: CameraAim;
  /** Rider's own weights; defaults to `REEL_WEIGHTS`, which are round numbers rather than measured
   *  ones and are exposed as sliders for exactly that reason. */
  weights?: ReelMetrics;
  limit?: number;
}

// ------------------------------------------------------------------------------------------------
// Cleanliness, part 1: the free junction proxy
// ------------------------------------------------------------------------------------------------

/** One junction: a rounded endpoint coordinate and every corpus road that terminates there. */
interface JunctionNode {
  key: string;
  pt: LatLng;
  roadIds: string[];
}

interface JunctionIndex {
  cells: Map<string, JunctionNode[]>;
  dLat: number;
  dLon: number;
}

/**
 * `AreaScan.corpus` is a stable array for the life of a scan, so the index is built at most once per
 * scan rather than once per window — the same memoise-on-array-identity discipline `nearestWithinM`
 * and `waterSplit` already depend on, and for the same reason: a Reel scan asks this question at
 * every 400 m window of every candidate road.
 */
const junctionCache = new WeakMap<ScannedRoad[], JunctionIndex>();

/**
 * The endpoint convention is routeBuilder's, verbatim: a coordinate rounded to four decimals
 * (~11 m at this latitude), because OSM ways split at a junction SHARE the junction node exactly, so
 * equal keys mean the roads genuinely connect. Reusing it rather than inventing a second convention
 * matters — two rounding rules for "the same node" in one codebase is a bug waiting for the day
 * someone compares a key from here against a key from there.
 */
const endpointKey = (p: LatLng): string => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

function junctionIndex(corpus: ScannedRoad[]): JunctionIndex {
  const cached = junctionCache.get(corpus);
  if (cached) return cached;

  const nodes = new Map<string, JunctionNode>();
  const add = (pt: LatLng, roadId: string): void => {
    const key = endpointKey(pt);
    let node = nodes.get(key);
    if (!node) nodes.set(key, (node = { key, pt, roadIds: [] }));
    // Duplicate ids happen when a way's two ends round to the same key (a tiny stub, or a closed
    // loop); counting the road twice at one node would misreport who meets there.
    if (!node.roadIds.includes(roadId)) node.roadIds.push(roadId);
  };
  for (const r of corpus) {
    if (!r.coords || r.coords.length < 2) continue;
    add(r.coords[0], r.id);
    add(r.coords[r.coords.length - 1], r.id);
  }

  let latSum = 0;
  for (const n of nodes.values()) latSum += n.pt[0];
  const lat0 = nodes.size ? latSum / nodes.size : 0;
  const dLat = JUNCTION_CELL_M / M_PER_DEG_LAT;
  // Cells only need to be roughly square, so the mean latitude sets the longitudinal width; the
  // floor keeps the width finite near the poles, where no road corpus this app scans will ever be.
  const dLon = JUNCTION_CELL_M / (M_PER_DEG_LAT * Math.max(0.05, Math.cos(lat0 * D2R)));

  const cells = new Map<string, JunctionNode[]>();
  for (const n of nodes.values()) {
    const ck = `${Math.floor(n.pt[0] / dLat)},${Math.floor(n.pt[1] / dLon)}`;
    let bucket = cells.get(ck);
    if (!bucket) cells.set(ck, (bucket = []));
    bucket.push(n);
  }

  const index: JunctionIndex = { cells, dLat, dLon };
  junctionCache.set(corpus, index);
  return index;
}

/**
 * Distinct junctions per km along one window: endpoints of OTHER corpus ways falling within
 * {@link JUNCTION_NEAR_M} of any of the window's samples, counted once each, over the window's
 * length in km.
 *
 * THIS IS A PROXY, and the honest reading of it is "how often does something tee into this road",
 * not "how built up is this". It stands in for `highway=residential|service` density, which is the
 * measured suburbia signal (20.6x separation, monotone across 1888 / 1609 / 559 / 198 / 130 / 54 /
 * 13 from suburban Amherst out to rural Zoar Valley) and is strictly better — but which needs an
 * Overpass query that costs ~20-25 s of dispatch overhead. This costs nothing: `AreaScan.corpus`
 * already holds every secondary/tertiary/unclassified way in the radius, so the ways are in hand
 * before the question is asked. A suburban grid tees into its through-roads constantly, so the two
 * quantities really do move together; the proxy is weaker, not wrong.
 *
 * Three limits worth knowing, all of which push the number UP rather than down, so a clean reading
 * is more trustworthy than a dirty one:
 *  - `corpus` does not contain `residential` or `service` ways at all, so a cul-de-sac estate hanging
 *    off a rural road is invisible here and visible to the measured signal. This is the gap the
 *    refinement closes.
 *  - OSM splits ways at tag changes, not only at junctions, so a bridge or a surface change in the
 *    middle of a through-road contributes two endpoints that no rider would call a junction. No
 *    same-name filter is applied to suppress those: it would be a heuristic invented here, and it
 *    would misfire wherever a corpus road is unnamed.
 *  - Endpoints are compared against the window's SAMPLES, not against the road's true centreline, so
 *    the tolerance carries half a resample interval of slack by construction.
 *
 * Nodes touched only by the window's own road are skipped, so a road's own two ends are not counted
 * as junctions with itself.
 */
export function junctionsPerKm(w: RoadWindow, corpus: ScannedRoad[]): number {
  const km = w.lengthM / 1000;
  if (!(km > 0) || !corpus.length || !w.pts.length) return 0;

  const index = junctionIndex(corpus);
  const seen = new Set<string>();
  for (const p of w.pts) {
    const i0 = Math.floor(p[0] / index.dLat);
    const j0 = Math.floor(p[1] / index.dLon);
    // A 3x3 neighbourhood spans at least one whole cell edge in every direction, and the cell edge
    // is far larger than JUNCTION_NEAR_M, so nothing in range can sit outside the swept window.
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        const bucket = index.cells.get(`${i},${j}`);
        if (!bucket) continue;
        for (const node of bucket) {
          if (seen.has(node.key)) continue;
          if (node.roadIds.length === 1 && node.roadIds[0] === w.roadId) continue;
          if (haversine(p, node.pt) * 1000 <= JUNCTION_NEAR_M) seen.add(node.key);
        }
      }
    }
  }
  return round1(seen.size / km);
}

/**
 * Distinct corpus way-endpoint nodes per km² within `radiusM` of a point — the same index
 * {@link junctionsPerKm} counts along a window, read over a DISC around it instead.
 *
 * The two are the same measurement asked at two scales and neither can see what the other sees, so
 * both are kept. Along the window answers "how often does something tee into THIS road", which is
 * what a rider feels; but on a single 400 m window that count is quantised to 2.5/km per junction,
 * which leaves four reachable scores and left the dimension at 0 for both the 25th and the 50th
 * percentile of a real scan. Over a disc it is continuous — 72 distinct values against 4 on the same
 * 1,404 windows — and it sees the fabric a road passes THROUGH even where nothing tees into the
 * particular 400 m being scored. See {@link FULL_JUNCTION_DENSITY} for the measured ladder and for
 * the limit both share: `AreaScan.corpus` has no `residential` or `service` ways in it.
 *
 * Nodes touched only by the window's OWN road are skipped, the same rule and for the same reason as
 * {@link junctionsPerKm}: a road's own two ends are not a junction with itself, and OSM splits ways
 * at tag changes, so counting them would make a lone rural road read as built-up purely because a
 * surface change happens to fall inside the disc. Every other endpoint counts, including the ones
 * OSM leaves at tag changes on OTHER roads — over a disc the quantity is way-endpoint density, a
 * measure of how finely the road fabric around here is cut up, and that is what the ladder in
 * {@link FULL_JUNCTION_DENSITY} was measured as.
 */
export function junctionDensityNear(w: RoadWindow, corpus: ScannedRoad[], radiusM: number): number {
  if (!corpus.length || !(radiusM > 0)) return 0;
  const index = junctionIndex(corpus);
  const at = w.mid;
  // A cell is JUNCTION_CELL_M across, so sweeping this many cells either side of the point's own
  // cell reaches at least radiusM beyond every edge of that cell, whichever corner the point sits
  // in. Every candidate still gets an exact `haversine` test, so the sweep only has to be generous.
  const span = Math.ceil(radiusM / JUNCTION_CELL_M);
  const i0 = Math.floor(at[0] / index.dLat);
  const j0 = Math.floor(at[1] / index.dLon);

  let n = 0;
  for (let i = i0 - span; i <= i0 + span; i++) {
    for (let j = j0 - span; j <= j0 + span; j++) {
      const bucket = index.cells.get(`${i},${j}`);
      if (!bucket) continue;
      for (const node of bucket) {
        if (node.roadIds.length === 1 && node.roadIds[0] === w.roadId) continue;
        if (haversine(at, node.pt) * 1000 <= radiusM) n++;
      }
    }
  }
  return round1(n / (Math.PI * (radiusM / 1000) ** 2));
}

// ------------------------------------------------------------------------------------------------
// Cleanliness, part 2: the reading
// ------------------------------------------------------------------------------------------------

/**
 * Cleanliness for one window. High = clean; the dimension is the inverse of suburbia, which is the
 * headline complaint about the reference ride.
 *
 * THE FREE PROXY IS TWO READINGS, and the penalty is the WORSE of them, never their mean. Junctions
 * along the window and way-endpoint density around it are the same question asked at two scales and
 * neither can see what the other sees — a lone strip of driveways tees into the road constantly
 * while the disc around it stays empty, and a road threading a grid can have nothing tee into its
 * own 400 m. So a window is clean only if BOTH say so. Same shape and same reason as
 * {@link scoreBackdrop}'s max-of-two-mechanisms, with the sign flipped because these are penalties.
 * Averaging them would need a mixing coefficient, and nothing exists that could calibrate one.
 *
 * The measured built-up density then REPLACES the pair when `built` is available, rather than being
 * blended with them. Same argument, one level up: blending would invent a coefficient between a
 * measured 20.6x-separating signal and a free stand-in for it. Both proxy readings stay in the
 * result either way, so a UI can show them, and `provisional` says which one is driving.
 *
 * `uglyAreas` containment then scales the result down. Multiplicative rather than a flat subtraction
 * of `10 * uglyFrac` — a judgement call the contract does not settle. The fraction of the window
 * inside a quarry or a retail park is the fraction of the window that is not clean road, which is a
 * scaling; subtracting a fixed ten points per unit fraction would let a modest industrial clip drive
 * an already-mediocre rural window to exactly zero and make it indistinguishable from a strip mall.
 *
 * WHY `corridorSignal(uglyPts)` IS NOT HERE, since the design doc's §5 sketch lists it
 * (cleanliness = corridorSignal(uglyPts) + fractionInside(uglyAreas) + road density) and its absence
 * would otherwise be an undocumented divergence. features.ts fills `uglyAreas` and `uglyPts` from
 * ONE `else if` branch — the ring goes to the first, the ring's downsampled vertices (or the
 * feature's single point, where there is no ring) go to the second — so `uglyPts` is not an
 * independent class of feature. It is the same features, measured by proximity to an edge instead of
 * by containment. Two consequences decide it. First, that branch is a CATCH-ALL (`else if (t.landuse
 * || t.man_made === 'works')`), so `landuse=farmland` lands in it: 26,198 ugly vertices in an
 * 11-tile Buffalo scan, and a proximity term over them would penalise every road that passes a
 * field. Containment is far more forgiving of that miscategorisation than proximity is, because a
 * road beside a farm field is not INSIDE it. Second, it is another per-sample nearest-feature search
 * over a 26k point set, and C8's lesson on this module is that an expensive term has to earn its
 * place in the RANKING. It does not, so it is not paid for. If the catch-all in features.ts is ever
 * split, this is the first thing to reconsider.
 */
export function scoreClean(w: RoadWindow, scan: AreaScan, built: BuiltIndex | null): CleanReading {
  const jpk = junctionsPerKm(w, scan.corpus);
  const nodeDensity = junctionDensityNear(w, scan.corpus, BUILT_RADIUS_M);
  const density = built ? builtDensityNear(built, w.mid, BUILT_RADIUS_M) : null;
  const uglyFrac = fractionInside(w.pts, scan.catalog.tells.uglyAreas);

  const penalty =
    density === null
      ? Math.max(
          clamp01(jpk / FULL_JUNCTION_PER_KM),
          clamp01(nodeDensity / FULL_JUNCTION_DENSITY),
        )
      : clamp01(density / FULL_BUILT_DENSITY);

  return {
    score10: round1(10 * (1 - penalty) * (1 - uglyFrac)),
    builtDensity: density === null ? null : round1(density),
    junctionsPerKm: jpk,
    junctionDensity: nodeDensity,
    uglyFrac,
    provisional: density === null,
  };
}

// ------------------------------------------------------------------------------------------------
// Backdrop — THE SELECTOR, not a ranker
//
// Backdrop does not order the list the rider reads. It CHOOSES that list, and cleanliness, light and
// drama order it from inside the choice. Measured on the 83-tile corpus, 1,417 windows, over the ten
// (instant x aim) combinations:
//
//   all 1,417 windows   57.9% exactly 0, 21.2% exactly 10, 45 distinct values, sd 4.26. Only 479 of
//                       the 1,417 carry a backdrop at all, i.e. clear `BACKDROP_MIN` on either side;
//                       the shortlist is drawn from those 479.
//   top-40 shortlist    min 9.1, 92.5% exactly 10, 3 distinct values, sd 0.204.
//   what moves it       contribution to the shortlist composite's sd — backdrop 0.82, cleanliness
//                       3.88, light 2.65, drama 3.58, against a composite sd of 3.31.
//
// So the heaviest-weighted dimension is the least discriminating one on the shortlist. Read cold that
// looks like a calibration failure, and it was diagnosed as one once. It is not. FILTER-THEN-RANK IS
// THE CORRECT SHAPE HERE: a rider wants every candidate to HAVE a real backdrop, and then wants those
// candidates ordered by the light, the corners and how clean the surroundings are. The 0.40 weight is
// what makes backdrop select, and selecting on backdrop is what the category is for. The shape
// emerged from the weights rather than being designed, which is the only reason it reads as a defect.
//
// The corollary, so nobody spends a wave on it: no re-calibration of THIS term can de-saturate it on
// the shortlist. Above the selection threshold there is nothing left for it to separate — only a
// selection not dominated by backdrop could produce shortlist variance in backdrop, and that would be
// a different product. The banding in `WATER_BANDS` changed the window-scale distribution,
// which is what decides who is selected, and correctly left the shortlist saturated.
//
// THE LIMIT THIS IMPLIES, stated because a rider can be misled by it: on the shortlist backdrop
// cannot tell a good backdrop from a spectacular one (3 distinct values, sd 0.204). The ordering is
// therefore NOT "best view first" — it is "has a view; best light, corners and surroundings first".
// Any UI that presents the order as a view ranking is over-claiming. See `GROUND_TRUTH_KAPPA` in
// reelTypes.ts for the wider version of the same caution.
// ------------------------------------------------------------------------------------------------

/**
 * Backdrop per side, in the window's STORED direction of travel. Flip with `flipSides` for the
 * reverse direction — the geometry is identical and only the labels move.
 *
 * The two mechanisms are combined by taking the STRONGER of the two, never the mean. They measure
 * different things and neither can see what the other sees: THE DEM CANNOT SEE WATER AT ALL (a lake
 * surface is flat, and the Lake Erie shore returned 0 m of lateral fall), and OSM water polygons
 * cannot see a gorge rim. A road with a 130 m drop to the right and no lake is not half a backdrop,
 * and averaging would say it was.
 *
 * `fall` is optional because it arrives from the DEM asynchronously. Absent, this is a water-only
 * reading and it is still honest — it is simply blind to relief, which the module's caller signals
 * to the rider through the enrichment state rather than through a silent zero.
 */
export function scoreBackdrop(
  w: RoadWindow,
  scan: AreaScan,
  fall: PerSide<LateralFall> | null,
): PerSide<BackdropReading> {
  // The SHARED open-water split, never a per-window slice and never a second filter of our own.
  // `sideScanWeighted` memoises its spatial grid on array IDENTITY, and a tile-sourced Buffalo scan
  // carries ~304,000 water vertices of which ~18,500 are open, so the array this is handed decides
  // how many spatial indexes exist over them. `waterSplit` is exported from sceneryTells precisely
  // so that this call site reuses the array `measureRubric` already indexed rather than filtering an
  // identical-but-distinct one; asking `sideScanWeighted` to apply OPEN_WATER_W here instead would
  // build a second copy and a second grid over the same points. The threshold is therefore 0 — not
  // "no threshold", but "the threshold is already applied", which is the documented pass-through.
  //
  // ONE ARRAY, K RADII: every band shares that same grid, because the array identity never changes.
  const open = waterSplit(scan.catalog.tells.waterPts).open;

  // Mean coverage over nested radii = a per-sample staircase in distance. See WATER_BANDS: the side
  // scan gives each sample to its single nearest tell, so a smaller radius can only DROP samples,
  // never move one across the road, and a sample at distance d is therefore counted in exactly the
  // bands whose radius reaches it. The outermost pass is the full cutoff, so its `nearestM` is the
  // one to report.
  const band = (k: number) => sideScanWeighted(w, open, (k * BACKDROP_WATER_M) / WATER_BANDS, 0);
  let outer = band(1);
  const mag: PerSide<number> = { left: outer.left.frac, right: outer.right.frac };
  for (let k = 2; k <= WATER_BANDS; k++) {
    outer = band(k);
    mag.left += outer.left.frac;
    mag.right += outer.right.frac;
  }

  // THE MERGE POINT, AND THE GAP IT STILL CARRIES. `max(terrain10, water10)` puts one side label on
  // two readings that are classified against DIFFERENT AXES, and that residual is written down here
  // rather than left implicit, because a silent gap reads to the next reader as a solved problem.
  //
  // Terrain is ONE probe pair, taken at `w.mid` perpendicular to the local tangent THERE
  // (`probeAxisDeg` in reelTerrain.ts). Water is classified PER SAMPLE, each against the local
  // tangent at that sample. Aiming the probes off the mid tangent instead of off the window chord
  // closed most of the disagreement and was a real fix: measured, the probe axis against sideScan's
  // bearing at the mid sample went from max 152.14 deg (502 windows over 5 deg) down to max 3.81 deg
  // (5 windows over 1 deg).
  //
  // What is LEFT is the rest of the window. Across all 24,057 window samples of the corpus, the
  // per-sample classification bearing differs from the probe axis by p50 2.04 deg, p90 28.12 deg,
  // p99 86.38 deg, max 180 deg, and 1,120 samples (4.7%) are classified more than 45 deg away from
  // it. On those samples the water credited to a side was assigned against an axis the terrain probe
  // never used, and this max() then merges the two as if they agreed.
  //
  // The real fix is per-sample terrain probing, and it is 17x the DEM budget — which reelTerrain.ts
  // documents as the one genuinely unbudgeted cost in this category (Open-Meteo returns 429 at
  // roughly 10-15 requests per 2 minutes). Out of scope rather than overlooked. And it would not
  // fully close the question either: on a strongly curving window WHICH SIDE genuinely varies along
  // the window, so a single side label per window is an approximation at any budget.
  const read = (side: Side): BackdropReading => {
    const f = fall ? fall[side] : null;
    const t10 = f ? terrain10(f) : 0;
    const w10 = round1(clamp01(mag[side] / WATER_BANDS / FULL_WATER_FRAC) * 10);
    return {
      terrain10: t10,
      water10: w10,
      // Stronger of the two, never the mean — see this function's doc for why, and the note above
      // for the axis disagreement this merge is papering over.
      score10: Math.max(t10, w10),
      fall: f,
      waterM: outer[side].nearestM === null ? null : round1(outer[side].nearestM),
    };
  };

  return { left: read('left'), right: read('right') };
}

/**
 * Which side the backdrop is on, or null when neither side clears `BACKDROP_MIN` and the honest
 * answer is "there isn't one".
 *
 * A tie goes to the right, which is a judgement call the contract does not settle: with the boom out
 * to the right, `right` is the side that films without the rider having to do anything, so when the
 * two sides are indistinguishable the useful answer is the one that costs nothing to act on.
 *
 * This `>=` is one of the three pieces the boom-side invariant rests on — the others are
 * {@link pickDirection} step 2 and `flipSides` — and it is the piece that covers the symmetric case:
 * with an equal backdrop on both verges BOTH directions report `right`, so step 2 cannot separate
 * them and the sun tiebreak decides the direction without ever moving the side label off the boom.
 */
function pickSide(b: PerSide<BackdropReading>): Side | null {
  const side: Side = b.right.score10 >= b.left.score10 ? 'right' : 'left';
  return b[side].score10 >= BACKDROP_MIN ? side : null;
}

// ------------------------------------------------------------------------------------------------
// The composite
// ------------------------------------------------------------------------------------------------

const REEL_KEYS: (keyof ReelMetrics)[] = ['backdrop', 'cleanliness', 'light', 'drama'];

/**
 * 0-100 from the four 0-10 metrics. Weights are normalised internally, so any positive set works and
 * all-10 is 100 under every one of them.
 *
 * The same shape as `compositeScore` in composite.ts — normalise, weighted mean, x10, round —
 * because a rider reading a 74 on a ride card and a 74 on a shoot card should at least be reading
 * the same ARITHMETIC. They are still not the same quantity, and nothing may compare them: a window
 * score and a ride score are calibrated on different scales (see the module header).
 *
 * All-zero or all-negative weights fall back to `REEL_WEIGHTS` rather than returning zero for
 * everything, which is composite.ts's convention: a rider who has dragged every slider to the floor
 * wants a ranking they can then re-weight, not a flat list of zeros.
 */
export function reelComposite(m: ReelMetrics, weights: ReelMetrics = REEL_WEIGHTS): number {
  let wSum = 0;
  for (const k of REEL_KEYS) wSum += Math.max(0, weights[k] ?? 0);
  const w = wSum > 0 ? weights : REEL_WEIGHTS;
  const total = wSum > 0 ? wSum : REEL_KEYS.reduce((a, k) => a + REEL_WEIGHTS[k], 0);

  let acc = 0;
  for (const k of REEL_KEYS) acc += Math.max(0, w[k] ?? 0) * (m[k] ?? 0);
  return Math.round((acc / total) * 10);
}

// ------------------------------------------------------------------------------------------------
// Marks
// ------------------------------------------------------------------------------------------------

/** One direction of travel through a window, before the two are compared. */
interface Candidate {
  direction: 'forward' | 'reverse';
  travelBearingDeg: number;
  light: LightReading;
}

/**
 * Tags, and only the honest ones. The six dropped from `ReelTag` are dropped rather than
 * approximated — adopting a shared word with a different referent is worse than having no shared
 * word at all. Read the `ReelTag` comment in reelTypes.ts before adding one; `canopy` is the newest
 * of the six and the reason it went is recorded there.
 *
 * Every tag left is a threshold on something this module ALREADY computes for the ranking, which is
 * now a rule rather than a coincidence: `canopy` was the one that was not, and it cost 409 ms of a
 * ~600 ms `buildMarks` to emit a boolean nothing ranked on. A tag that needs its own measurement has
 * to justify that measurement as a ranking signal first.
 *
 * `water` is emitted on PRESENCE, deliberately, and it is the half-honest one: there is no occlusion
 * model anywhere behind it, and the reference corpus contains a documented case where a six-way yaw
 * sweep at a water mark's peak found no water at any bearing — trees, a fence and a car-park
 * shelter. Presence yes; visibility no.
 */
function tagsFor(
  drama: number,
  clean: CleanReading,
  backdrop: PerSide<BackdropReading>,
  paved: boolean | undefined,
): ReelTag[] {
  const tags: ReelTag[] = [];
  if (drama >= TAG_CORNER_DRAMA) tags.push('corner');
  if (backdrop.left.waterM !== null || backdrop.right.waterM !== null) tags.push('water');
  if (clean.score10 <= TAG_URBAN_CLEAN) tags.push('urban');
  // Unknown surface is treated as paved everywhere else in this codebase, so only an explicit
  // `false` earns the tag; `undefined` is "not mapped", not "gravel".
  if (paved === false) tags.push('gravel');
  return tags;
}

/**
 * Score one window in BOTH directions of travel. `[0]` is the direction `bestDirection` prefers on
 * light alone; `[1]` is the other one. {@link pickDirection} chooses between them.
 *
 * ON DIRECTION, which is the single most damaging place in this module to be wrong. `backdrop` and
 * `light` both depend on which way the road is ridden; `drama` and `cleanliness` do not. So the
 * per-side backdrop is computed ONCE in the road's stored order and flipped for the reverse
 * candidate, the light is computed for each candidate's own travel bearing, and `direction`,
 * `travelBearingDeg` and `backdropSide` are all derived from the SAME candidate. A mark whose
 * `backdropSide` disagreed with its `direction` would still carry entirely reasonable-looking
 * numbers, which is what makes it worth this much care.
 *
 * The scalar `backdrop` metric is the BETTER side rather than the boom side, which is a judgement
 * call and is NOT the question {@link pickDirection} answers — the two were confused once and the
 * distinction is worth stating. A road with a 130 m drop on the LEFT is a genuinely good road and
 * must score like one: the rig is a 360 camera reframed into virtual angles, both sides are
 * captured, and a rider who wants the drop on the boom side can simply turn around. Scoring the
 * right side alone would score that road ZERO on the dimension that SELECTS the shortlist (see the
 * Backdrop section), so half the good roads in a scan would never reach the list to be turned around
 * on. That is an argument about SCORING. Which direction to RECOMMEND when both directions score
 * identically is a different question with a different answer, and it is answered below.
 *
 * That argument used to be stated on a weaker consequence — "scoring the right side alone would make
 * every mark with any view report `backdropSide: 'right'`, and a field that always says the same
 * thing tells the rider nothing" — and that sentence is now actively misleading, so it is corrected
 * here rather than deleted. Since `pickDirection` step 2 landed, every emitted mark that has a
 * backdrop DOES report `right`: measured on all 1,417 windows of the corpus across ten (instant x
 * aim) combinations, with zero windows where some direction yields a right-side backdrop and the
 * emitted one does not, and pinned by test. `backdropSide` is a constant for the rider by design;
 * what is useful about it is that it is `right`, not that it varies.
 */
function candidatesFor(
  w: RoadWindow,
  scan: AreaScan,
  opts: ReelOptions,
  fall: PerSide<LateralFall> | null,
  built: BuiltIndex | null,
  paved: boolean | undefined,
): [ReelMark, ReelMark] {
  const weights = opts.weights ?? REEL_WEIGHTS;
  const drama = drama10(w.pts);
  const clean = scoreClean(w, scan, built);
  const forwardBackdrop = scoreBackdrop(w, scan, fall);

  const preferred = bestDirection(opts.at, w.mid, w.bearingDeg, opts.aim);
  const otherBearing = (preferred.travelBearingDeg + 180) % 360;
  const other: Candidate = {
    direction: preferred.direction === 'forward' ? 'reverse' : 'forward',
    travelBearingDeg: otherBearing,
    light: lightAt(opts.at, w.mid, otherBearing, opts.aim),
  };

  const build = (c: Candidate): ReelMark => {
    const backdrop = c.direction === 'forward' ? forwardBackdrop : flipSides(forwardBackdrop);
    const metrics: ReelMetrics = {
      backdrop: Math.max(backdrop.left.score10, backdrop.right.score10),
      cleanliness: clean.score10,
      light: c.light.score10,
      drama,
    };
    return {
      // The WINDOW's id, not a per-direction one: a mark is one window, and `enrichMarks` may change
      // its direction, so folding direction into the identity would make a refined mark look to the
      // UI like a different mark. It is also what pairs the two candidates back up in `selectMarks`.
      id: w.id,
      roadId: w.roadId,
      roadName: w.roadName,
      window: w,
      direction: c.direction,
      travelBearingDeg: c.travelBearingDeg,
      metrics,
      score: reelComposite(metrics, weights),
      backdropSide: pickSide(backdrop),
      backdrop,
      clean,
      light: c.light,
      tags: tagsFor(drama, clean, backdrop, paved),
    };
  };

  return [build(preferred), build(other)];
}

/**
 * Choose which way to ride a window. THE HEADLINE DELIVERABLE, and the order of this chain is the
 * contract — read it before reordering.
 *
 *  1. THE COMPOSITE, when there is a real gap. It is what the function claims to rank on, and it is
 *     the branch that starts firing the day an asymmetric aim function lands.
 *  2. PUT THE BACKDROP ON THE RIGHT. With the boom out to the right, `right` is the side the rig
 *     actually films; `left` is a reframe out of the 360 capture, and the shoot card says so to the
 *     rider. Only one of the two directions can put a given view on the right, and choosing it costs
 *     NOTHING — the composite is identical either way, because the scalar backdrop is the better of
 *     the two sides and is invariant under the flip. This step used not to exist, and it is not a
 *     tidy-up: measured on a real 30 km Buffalo scan, 17 of the top 40 marks aimed the backdrop at
 *     the wrong verge, every one of them at an identical light score and an identical composite to
 *     the direction that would have aimed it correctly.
 *  3. PUT THE SUN BEHIND YOU — reelPlan's tiebreak, already applied, so this step is just "keep
 *     `bestDirection`'s answer". It decides the marks where neither direction puts a backdrop on the
 *     right, which is every mark with no backdrop at all and every mark whose two sides are equally
 *     good. It is INVENTED (see `bestDirection`); step 2 is not, which is why step 2 goes first.
 *  4. Failing all three, `bestDirection`'s own final tiebreak: the road's stored vertex order.
 *     Arbitrary and deliberately arbitrary — a fixed function of the input, so the answer cannot
 *     flicker between "ride it east" and "ride it west" on a re-render.
 *
 * Steps 3 and 4 are both just "return `preferred`", so they are one line; they are written as two
 * because they are two different reasons and a later reader needs to know both are covered.
 */
function pickDirection(preferred: ReelMark, other: ReelMark): ReelMark {
  // STANDING HAZARD, AND IT LIVES ON THIS LINE. Step 1 never fires today: both aim functions are
  // symmetric about 90 deg (`directionalLight10` is |cos|, `sideLight10` is |sin|, and riding the
  // other way turns an off-axis angle of x into 180 - x), every other metric is flip-invariant, and
  // the composite rounds to whole points — so the two directions of a window tie EXACTLY, on all
  // 1,417 windows of the corpus, and step 2 decides every mark. The boom-side invariant below is
  // therefore total: `backdropSide` is `right` on every emitted mark that has one.
  //
  // The day an ASYMMETRIC aim function lands, this line starts firing and SILENTLY OVERRIDES that
  // rule — a mark whose backdrop is on the left, at a composite one point higher, with nothing in
  // the output saying the boom is now pointed at the empty verge. That is a deliberate order (the
  // composite is what the function claims to rank on), not an oversight, but it is a trade to make
  // knowingly. `reelScore.test.ts` pins the symmetry as a tripwire so the failure arrives as a red
  // test naming the cost, rather than as marks quietly changing verge.
  if (other.score - preferred.score > COMPOSITE_TIE_TOL) return other;
  if (preferred.score - other.score > COMPOSITE_TIE_TOL) return preferred;

  const preferredFilms = preferred.backdropSide === 'right';
  const otherFilms = other.backdropSide === 'right';
  if (otherFilms && !preferredFilms) return other;
  return preferred;
}

/** One window, scored and resolved to a single direction. */
function markFor(
  w: RoadWindow,
  scan: AreaScan,
  opts: ReelOptions,
  fall: PerSide<LateralFall> | null,
  built: BuiltIndex | null,
  paved: boolean | undefined,
): ReelMark {
  const [preferred, other] = candidatesFor(w, scan, opts, fall, built, paved);
  return pickDirection(preferred, other);
}

/**
 * Every window of the scan, scored in BOTH directions and NOT yet selected. The pool
 * {@link selectMarks} chooses from.
 *
 * Exported because SELECTION IS WEIGHT-DEPENDENT and pretending otherwise was a live defect. Both
 * non-max suppression and the limit consume `mark.score`, so the weights in force decide which of
 * two overlapping windows survives and which `limit` of ~1,400 windows are kept — not merely what
 * order they come back in. Re-scoring an already-selected shortlist under new weights therefore
 * returns "the marks the OLD weights chose, re-sorted", which is a different and smaller list than
 * the marks the new weights would have chosen. Dragging `drama` to 1 and everything else to 0 used
 * to return the 40 backdrop-selected marks sorted by drama rather than the 40 most dramatic marks in
 * the scan, and nothing in the output said so.
 *
 * Holding the pool is what makes re-weighting both correct and instant. Everything expensive — the
 * window cutting, the side scans, the junction counts, the solar model — is already done and is
 * weight-independent, so `selectMarks` on a held pool is arithmetic. Measured on a real 30 km
 * Buffalo scan (300 roads, 1,404 windows, 2,808 pool entries): building the pool costs 300 ms and
 * re-selecting from it 12-14 ms. A caller that does not hold the pool can call {@link buildMarks}
 * again instead — also correct, network-free, and 262-314 ms — but it must not re-score a shortlist
 * and call that a re-rank. Measured on that scan, dragging `drama` to 1 and everything else to 0
 * makes 37 of the 40 genuinely-best marks unreachable by re-scoring the old shortlist.
 */
export function scoreWindows(scan: AreaScan, opts: ReelOptions): ReelMark[] {
  const pool: ReelMark[] = [];
  for (const road of scan.roads) {
    for (const w of cutWindows(road)) {
      pool.push(...candidatesFor(w, scan, opts, null, null, road.paved));
    }
  }
  return pool;
}

/**
 * Select the marks to show from a pool of scored candidates, under `opts.weights`: re-score, resolve
 * each window to one direction, suppress overlaps, rank, cap.
 *
 * `selectMarks(scoreWindows(scan, a), b)` equals `buildMarks(scan, b)` for any weights `a` and `b`.
 * That is the contract, and it is why the two directions of a window are BOTH carried in the pool
 * rather than resolved when the pool is built: {@link pickDirection}'s first step is the composite,
 * which is weight-dependent, so resolving early would bake `a`'s answer into the pool.
 *
 * The pool is expected in `scoreWindows` order — the two candidates of a window adjacent, the
 * light-preferred one first — because that ordering is how {@link pickDirection}'s later steps know
 * which candidate `bestDirection` favoured. `Map` insertion order then preserves the along-road
 * order of the windows themselves, which is what makes `suppressNearby` and `rank` (both stable)
 * deterministic.
 */
export function selectMarks(pool: ReelMark[], opts: ReelOptions): ReelMark[] {
  const weights = opts.weights ?? REEL_WEIGHTS;
  const limit = Math.max(0, opts.limit ?? DEFAULT_MARK_LIMIT);

  const byWindow = new Map<string, ReelMark>();
  for (const m of pool) {
    const scored: ReelMark = { ...m, score: reelComposite(m.metrics, weights) };
    const preferred = byWindow.get(m.id);
    byWindow.set(m.id, preferred ? pickDirection(preferred, scored) : scored);
  }
  return rank(suppressNearby([...byWindow.values()])).slice(0, limit);
}

/**
 * Rank the filmable moments in a scan. SYNCHRONOUS, and does no network at all.
 *
 * Everything it needs is already in hand: the roads and the corpus from the scan, the water and
 * ugly tells from `scan.catalog`, and the sun from a closed-form model. The rider sees a ranked list
 * immediately, and {@link enrichMarks} sharpens it afterwards.
 *
 * Non-max suppression runs before the limit is applied, so a limit of 10 returns ten distinct
 * moments rather than ten overlapping views of the best one.
 *
 * A CALLER CHANGING ONLY THE WEIGHTS should hold the pool from {@link scoreWindows} and re-run
 * {@link selectMarks}, or failing that call this again. It must not re-score the returned shortlist:
 * see `scoreWindows` for what that silently gets wrong.
 */
export function buildMarks(scan: AreaScan, opts: ReelOptions): ReelMark[] {
  return selectMarks(scoreWindows(scan, opts), opts);
}

/**
 * Refine an already-ranked shortlist with the two measurements that cost network time: DEM lateral
 * fall for `backdrop`, and the built-up query for `cleanliness`. Re-scores and re-ranks.
 *
 * GRACEFUL DEGRADATION IS THE CONTRACT HERE, not a nicety. Both enrichments return null on failure
 * by design, both are wrapped so a future throw cannot escape either, and both are awaited together
 * so one slow mirror does not serialise behind the other. If both fail, the marks handed in stand
 * exactly as they were — still ranked, still honest, `provisional` still true — and the rider is no
 * worse off than before the call. If only one lands, the other dimension keeps its instant answer.
 *
 * Marks past `MAX_PROBE_WINDOWS` receive no terrain reading (reelTerrain caps itself against a
 * measured Open-Meteo 429 threshold and warns when it truncates); they keep their water-only
 * backdrop. That is why `DEFAULT_MARK_LIMIT` is the same number.
 *
 * Suppression is not re-run. The marks handed in are already pairwise beyond `NMS_RADIUS_M` on any
 * one road, and that is a property of their geometry, which re-scoring cannot change.
 *
 * SELECTION IS NOT RE-RUN EITHER, and here that is a real limit rather than a no-op: this refines
 * the shortlist it is handed, so a window the DEM would have promoted from 41st place cannot arrive.
 * It could only be otherwise by probing every window, and reelTerrain caps itself at
 * `MAX_PROBE_WINDOWS` against a measured Open-Meteo 429 threshold — which is exactly why
 * `DEFAULT_MARK_LIMIT` is that same number, so the shortlist and the probe budget are the same set.
 */
export async function enrichMarks(
  marks: ReelMark[],
  scan: AreaScan,
  opts: ReelOptions,
  signal?: AbortSignal,
): Promise<ReelMark[]> {
  if (!marks.length) return marks;

  const [falls, built] = await Promise.all([
    fetchLateralFall(
      marks.map((m) => m.window),
      signal,
    ).catch(() => null),
    fetchBuiltIndex(scan.center, scan.radiusKm, signal).catch(() => null),
  ]);

  // Nothing landed: re-scoring would reproduce the input exactly, so hand it back untouched rather
  // than spending a second pass to prove it.
  if (!falls && !built) return marks;

  const paved = new Map(scan.roads.map((r) => [r.id, r.paved]));
  return rank(
    marks.map((m) =>
      markFor(m.window, scan, opts, falls?.get(m.window.id) ?? null, built, paved.get(m.roadId)),
    ),
  );
}

/** Strongest first. `Array.prototype.sort` is stable, so marks tied on an integer score — which is
 *  common, since the composite rounds to whole points — keep the order they arrived in, and that
 *  order is along-road within a road. Deterministic output for a deterministic input. */
function rank(marks: ReelMark[]): ReelMark[] {
  return [...marks].sort((a, b) => b.score - a.score);
}
