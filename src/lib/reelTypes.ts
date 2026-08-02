// Shared contract for the Reel category. Types + tuning constants only — no logic, so every Reel
// module can import this without creating a cycle.
//
// Reel asks a different question from Scan. Scan asks "is this road good?"; Reel asks "is this road
// good AT 20:15 ON THE 15th, ridden WEST-to-EAST, with the camera boom out to the RIGHT?" A rider
// cannot change a road's bearing, so the two deliverables are WHICH DIRECTION to ride it and WHEN
// to be there. Everything here exists to answer those two.
//
// Read docs/plans/2026-08-01-reel-category-design.md (revision 2) before changing any number in
// this file. Most of them are measured; the ones that are not say so.

import type { LatLng } from './geometry';

// ------------------------------------------------------------------------------------------------
// Windowing
// ------------------------------------------------------------------------------------------------

/**
 * Length of a scored window (m). A reel shot is ~2 s at 180 BPM / 6 beats; at 45 mph that is ~40 m
 * of road, but the rider needs a stretch they can SET UP and hold, not a single instant. 400 m is
 * ~20 s at that speed — long enough to contain a whole shot with entry and exit, short enough that
 * one good corner is not averaged away by the kilometre of straight either side of it. Ride-level
 * means cannot see a moment; that is the entire reason windows exist.
 */
export const WINDOW_M = 400;

/**
 * Distance between window starts (m). Half a window, so a good stretch straddling a boundary is
 * still fully contained by one of the two overlapping windows. Overlap is then removed by
 * {@link NMS_RADIUS_M}, not by pretending it never happened.
 */
export const STRIDE_M = 200;

/**
 * Resampling interval inside a window (m). 400/25 = 17 samples.
 *
 * NON-NEGOTIABLE, and the reason `sampleAlong` cannot be reused: 50% of real 400 m windows contain
 * fewer than 3 OSM vertices and 11% contain none at all, where `measureRubric` silently returns
 * all-zeros. The same window scored at 3 vs 17 samples moves by up to 4.4 points out of 10.
 * `sampleAlong` SNAPS to vertices, so asking it for 17 samples of a 3-vertex window returns 17
 * entries drawn from 3 distinct points and then averages duplicates as if they were independent.
 * {@link import('./reelGeometry').resampleAlong} interpolates instead.
 */
export const RESAMPLE_M = 25;

/** Two marks closer than this along the road are the same moment; keep the stronger. */
export const NMS_RADIUS_M = 400;

/** One scored stretch of road, before any Reel measurement is attached. */
export interface RoadWindow {
  /** Stable id: `${roadId}@${Math.round(startM)}`. */
  id: string;
  /** The source road this window was cut from. */
  roadId: string;
  roadName: string;
  /** Interpolated points at {@link RESAMPLE_M} spacing — never raw OSM vertices. */
  pts: LatLng[];
  /** Distance from the start of the road to the start of this window (m). */
  startM: number;
  /** Ground length of the window (m). The final window of a road may be short. */
  lengthM: number;
  /** Point at the middle of the window — where a shoot card is anchored. */
  mid: LatLng;
  /** Mean direction of travel through the window (deg, 0 = N), in the road's stored order. */
  bearingDeg: number;
}

// ------------------------------------------------------------------------------------------------
// Sides
// ------------------------------------------------------------------------------------------------

/**
 * Which side of the rider something is on, in the direction of travel.
 *
 * This is the axis the whole category turns on. The rig puts the camera out to the RIGHT, so it
 * films a side profile of rider + engine against whatever is on the right. Ride the same road the
 * other way and that backdrop moves behind the camera. `measureRubric` has ZERO directional
 * awareness — every one of its signals is radial — which is why none of it could be reused here.
 */
export type Side = 'left' | 'right';

/** A measurement taken independently on each side of the road. */
export interface PerSide<T> {
  left: T;
  right: T;
}

/** Flip a per-side reading to describe riding the same road in the opposite direction. */
export function flipSides<T>(s: PerSide<T>): PerSide<T> {
  return { left: s.right, right: s.left };
}

// ------------------------------------------------------------------------------------------------
// Terrain (backdrop, mechanism 1 of 2)
// ------------------------------------------------------------------------------------------------

/**
 * Lateral probe distances (m). Max-over-distances, NOT a single distance — measured, and there is
 * no one value that works: Zoar Valley's signal lives at 200–800 m and VANISHES to 0 at 1500 m,
 * while Letchworth's keeps growing all the way out (34 → 129 → 142 → 149 m). The distance at which
 * the max occurs is the scale of the landform, recorded for free.
 *
 * The near field is deliberately absent. Copernicus GLO-90 as served by Open-Meteo has a measured
 * cell of ~69 m at 42°N (a 600 m transect at 10 m steps returned identical-value runs of mean length
 * 6.0), so a probe closer than ~140 m lands in the SAME CELL as the road and is structurally zero.
 * Revision 1's 30–50 m probe measured nothing at all. Near-field openness comes from OSM polygons.
 */
export const PROBE_DISTANCES_M = [200, 400, 800, 1500] as const;

/** Lateral relief measured to one side of a road. */
export interface LateralFall {
  /** Greatest drop from road level to a probe on this side (m). Never negative — ground ABOVE the
   *  road is a wall, not a view, and reads as zero here. */
  fallM: number;
  /** Which of {@link PROBE_DISTANCES_M} produced `fallM` — the scale of the landform. */
  atM: number;
  /** Greatest RISE on this side (m). Reported, not scored: a wall opposite the drop is what frames
   *  the shot, but it is also what eats the low sun (see the terrain-horizon gap in sun.ts). */
  riseM: number;
}

/**
 * Fall (m) that saturates the terrain term.
 *
 * Calibrated against measurement, and the honest ceiling is recorded with it. Letchworth Park Rd
 * reads 130.3 m mean lateral fall against a flat-farmland negative control of 7.9 m (three longest
 * ways in each of two flat boxes, no name filter, no cherry-picking) — a 16x separation. But Zoar
 * Valley (23.3 m) and the Lake Erie shore (17.7 m) separate by only 2.2–2.9x. So this detector
 * reliably finds MAJOR relief; modest relief is a hint, not a finding.
 *
 * The bias is one-signed in the optimistic direction: GLO-90 smooths narrow valleys (measured as a
 * 3.6x horizon-angle underestimate at Zoar), so it systematically UNDER-rates exactly the enclosed
 * gorge roads this feature wants. Modest-relief roads must lean on water and on Street View
 * confirmation rather than on this number.
 */
export const FULL_FALL_M = 120;

// ------------------------------------------------------------------------------------------------
// Backdrop (mechanism 2 of 2: water)
// ------------------------------------------------------------------------------------------------

/**
 * Open water beyond this distance (m) on a side is not a backdrop for that side, at any strength.
 *
 * A HARD cutoff, not `exp(-d/tau)`. Water is the only sharp signal in the existing rubric precisely
 * because `alongFrac` uses a cutoff rather than a decay: decay terms cannot localise a moment, and
 * adjacent 400 m windows under one differ by only 3.5%.
 *
 * A hard cutoff is NOT the same as ignoring distance inside it, and the two were confused once. The
 * cutoff decides membership; `WATER_BANDS` in reelScore.ts then grades MAGNITUDE within it, because
 * a lake at 80 m fills a 9:16 frame and the same lake at 390 m is a smudge. Measured on the real
 * corpus, the hits inside this radius are spread right across it (p25 = 84 m, p50 = 154 m,
 * p75 = 252 m, p90 = 337 m over 8,167 window-sample hits), so "was there a hit" throws away the
 * majority of what the reading knows.
 *
 * Larger than `WATER_SIGHT_M` (120 m) on purpose, and this is a genuine redefinition rather than
 * drift. `WATER_SIGHT_M` answers "am I riding ALONGSIDE water" — a near-field question. This answers
 * "is there water BEHIND ME IN FRAME" — a lake 300 m out is a better backdrop than a creek in the
 * ditch, and fills more of a 9:16 frame. There is no occlusion model behind either number; see the
 * `water` tag caveat in the design doc, and prefer the Street View check for anything marginal.
 */
export const BACKDROP_WATER_M = 400;

/** The DEM cannot see water at all — a lake surface is flat, and the Lake Erie shore returned 0 m
 *  of lateral fall. This is why backdrop needs two independent mechanisms and not just the better
 *  one of the two. */
export interface BackdropReading {
  /** 0–10 from terrain relief on this side. */
  terrain10: number;
  /** 0–10 from open water on this side. */
  water10: number;
  /** Combined 0–10 for this side. */
  score10: number;
  fall: LateralFall | null;
  /** Distance to the nearest open water on this side (m), or null if none within
   *  {@link BACKDROP_WATER_M}. */
  waterM: number | null;
}

// ------------------------------------------------------------------------------------------------
// Cleanliness
// ------------------------------------------------------------------------------------------------

/**
 * Built-up way density (ways/km²) that saturates the penalty.
 *
 * `highway=residential|service` way density is the measured suburbia signal: 20.6x separation and
 * MONOTONE across the whole range — 1888 / 1609 / 559 / 198 / 130 / 54 / 13 from suburban Amherst
 * out to rural Zoar Valley. Roads are the best-mapped class in OSM.
 *
 * Two rejected alternatives, both from revision 1:
 *  - `landuse=residential`: FOUR such polygons within 15 km of Ellicottville, and zero at every
 *    rural site sampled. It cannot rank rural roads against each other, which is the entire job.
 *  - buildings: the signal INVERTS where it is needed — Ellicottville village returned more
 *    buildings (1116) than suburban Amherst (959).
 *
 * THE UNITS, because this constant was wrong once and the failure was silent. That series is a
 * series of raw COUNTS, taken at r = 2 km: the one site with an area recorded is 1,888 ways in
 * 12.6 km², and 12.6 km² is exactly the area of a 2 km disc (pi * 2^2 = 12.57). `builtDensityNear`
 * returns a DENSITY — it divides by the actual disc area so a reading is comparable across radii —
 * so the series in this function's units is 150 / 128 / 44 / 16 / 10 / 4.3 / 1.0 ways/km², and a
 * second live count on 2026-08-02 agrees on the order (1,094 ways within 2 km of the app's home
 * point in suburban Amherst = 87 ways/km²).
 *
 * This constant previously held 600, which is the COUNT that sits between rural Ellicottville
 * (~200) and the suburban floor (~1600). Divided by the disc those counts were taken over, that
 * intent is 600 / 12.57 = 48 ways/km², and 48 is what it now holds. At 600 the penalty could never
 * exceed 150/600 = 0.25 anywhere on earth that has ever been measured, so the measured refinement
 * scored actual suburbia at 7.5/10 on a dimension defined as the INVERSE of suburbia — strictly
 * worse than the free junction proxy it replaces, which does reach zero. The ranking was monotone
 * either way; the range was not, and cleanliness carries a quarter of the composite.
 *
 * At 48 the measured series reads 0 / 0 / 0.8 / 6.7 / 7.9 / 9.1 / 9.8 on the cleanliness scale,
 * which is the original intent: suburbia bottoms out, a village takes a partial penalty, and rural
 * roads still rank against each other.
 */
export const FULL_BUILT_DENSITY = 48;

/**
 * Junction density (junctions/km) ALONG a window that saturates the free proxy.
 *
 * The free proxy exists because the built-up query is NOT cheap in the way that matters: Overpass
 * wall time is near-constant dispatch overhead (measured 24.4 s at 1.9 MB vs 34.9 s at 55 MB), so
 * bolting one onto a tile-sourced scan takes it from ~1 s to ~20–25 s and negates the corpus it
 * rides on. Junction density over `AreaScan.corpus` costs nothing — the ways are already in hand —
 * and it is a weaker but real proxy for the same thing, since a suburban grid tees into the
 * through-roads constantly.
 *
 * So cleanliness ships instant-and-approximate, then REFINES when the built-up query lands. The
 * refinement never blocks the ranking.
 *
 * THE LIMIT THIS READING HAS, measured, and the reason {@link FULL_JUNCTION_DENSITY} exists beside
 * it: counted along a single 400 m window the answer is QUANTISED to 2.5/km per physical junction,
 * so against a saturating 6 there are exactly four reachable scores — 0 junctions reads 10, one
 * reads 5.8, two read 1.7, three or more read 0. Over all 1,404 windows of a real 30 km scan that
 * left `junctionsPerKm` at 0 at BOTH the 25th and the 50th percentile and 70.7% of windows on
 * exactly 10, i.e. a dimension carrying a quarter of the composite that could not rank rural roads
 * against each other at all.
 */
export const FULL_JUNCTION_PER_KM = 6;

/**
 * Way-endpoint density (nodes/km²) AROUND a window that saturates the free proxy.
 *
 * The second free reading of the same quantity, and the one that supplies the variance the
 * along-window count cannot (see {@link FULL_JUNCTION_PER_KM}). Read over a disc rather than along
 * the strip of road, it is continuous where the other is quantised: over the same 1,404 windows it
 * spans p25 = 0.50, p50 = 1.50, p75 = 4.00, p90 = 9.40 nodes/km² with 72 distinct values and 15.7%
 * at zero — against four reachable values and 70.7% at the clean end for the along-window count.
 *
 * 5.0 is where measured suburbia bottoms out. The ladder, taken at r = 800 m over the 83-tile
 * corpus on 2026-08-02 (nodes/km², distinct rounded endpoints as `junctionsPerKm` counts them):
 * Buffalo city core 56.2 / Buffalo Elmwood 13.4 / Amherst suburb 5.0 / Cheektowaga 4.0 /
 * Tonawanda 4.0 / Williamsville village 4.0 / Ellicottville village 4.0 / Springville village 2.0 /
 * Clarence rural fringe 0.0 / Letchworth Park Rd 0.0 / Zoar Valley 0.0 / Genesee farmland 0.0.
 * (Taken at bare points, so no window road's own endpoints were in play; the exclusion the scored
 * function applies removes at most two nodes from a disc that holds 113 at the top of that ladder.)
 *
 * The outcome, on the same 1,404 windows: provisional cleanliness went from 70.7% of windows on
 * exactly 10 and 4.8% on exactly 0 — four reachable values in all — to 15.5% and 22.4%, spread over
 * every bucket of the 0-10 range, and the top-40 shortlist went from three distinct values (sd 0.89)
 * to seven (sd 1.63).
 *
 * READ THE COLLISION IN THAT LADDER BEFORE TRUSTING THIS. A dense suburb (4.0) and a rural village
 * (4.0) are indistinguishable here, because `AreaScan.corpus` holds only secondary/tertiary/
 * unclassified ways and suburbia's fabric is `residential`, which is not in it. That is the same
 * gap `junctionsPerKm` already documents and exactly what the measured built-up query closes; this
 * proxy separates city and suburb from open country (56 / 5 / 0) and ranks windows against each
 * other, and it does not claim more than that.
 *
 * A REJECTED ALTERNATIVE, measured, so it is not re-tried: total corpus way LENGTH per km² (the
 * obvious continuous signal). It INVERTS on the same ladder — suburban Amherst 0.75 km/km² against
 * Ellicottville village 1.10 and Zoar Valley 0.58 — because a rural through-road contributes its
 * own ~1.6 km to an 800 m disc whatever is around it, so the measurement is dominated by a constant
 * offset that has nothing to do with suburbia. Same failure as the `landuse=residential` and
 * building counts recorded under {@link FULL_BUILT_DENSITY}: the signal cannot separate the two
 * places it exists to separate.
 */
export const FULL_JUNCTION_DENSITY = 5.0;

export interface CleanReading {
  /** 0–10, high = clean. */
  score10: number;
  /** Built-up ways per km² near the window, or null when the supplementary query has not landed. */
  builtDensity: number | null;
  /** Junctions per km ALONG the window — the free proxy, always present, quantised (see
   *  {@link FULL_JUNCTION_PER_KM}). */
  junctionsPerKm: number;
  /** Corpus way-endpoint nodes per km² AROUND the window — the free proxy's continuous half. */
  junctionDensity: number;
  /** Fraction of the window inside an `uglyAreas` polygon (industrial/quarry/retail). */
  uglyFrac: number;
  /** True while `builtDensity` is null and the score rests on the two proxies alone. */
  provisional: boolean;
}

// ------------------------------------------------------------------------------------------------
// Light
// ------------------------------------------------------------------------------------------------

/**
 * Which virtual camera the light is being scored for.
 *
 * These want OPPOSITE geometry, so one number cannot serve both and picking silently would be a
 * lie. The forward/rear angles look ALONG the road, so they want the sun near the travel axis
 * (`directionalLight10`, |cos|). The right-boom angle looks ACROSS the road at a side profile of
 * rider and engine, so it wants the sun near 90° off-axis — cross-light is what sculpts a subject
 * viewed side-on, and axial light renders it flat.
 *
 * `side` is the default because it is the rig actually mounted: an Insta360 on a boom out to the
 * right, filming rider + engine + exhaust against the backdrop.
 */
export type CameraAim = 'side' | 'forward';

export interface LightReading {
  /** 0–10 from sun elevation alone — see `lightQuality10`. Near-constant across one scan area at
   *  one instant, so it sets the ceiling for the shoot time but does not rank marks against each
   *  other. Direction is what ranks. */
  quality10: number;
  /** 0–10 from the sun's bearing relative to travel, for the selected {@link CameraAim}. */
  aim10: number;
  /** Combined 0–10. */
  score10: number;
  /** 0–180; 0 = riding straight into the sun. */
  offAxisDeg: number;
  /** Which side of the rider the sun is on. `none` ⇒ the disc is below the (flat-earth) horizon. */
  sunSide: 'left' | 'right' | 'ahead' | 'behind' | 'none';
  sunElevationDeg: number;
  sunAzimuthDeg: number;
}

// ------------------------------------------------------------------------------------------------
// Drama
// ------------------------------------------------------------------------------------------------

/**
 * Total unsigned heading change (deg) over one window that saturates `drama`.
 *
 * `flowCurvature` is unusable at this scale in four independent ways, all verified by execution:
 * its `dist < 0.3` floor makes a 200 m window ALWAYS return 0; `FLOW_MIN_TURN` 4° discards the
 * per-vertex turning of a finely-sampled 45° arc, so resampling (which Reel requires) DESTROYS the
 * signal rather than improving it; `FLOW_MAX_TURN` 75° reads an 80° kink — the most filmable corner
 * there is — as 0.0; and dividing by distance saturates so hard that the usable range at 400 m is
 * essentially {0, 10}.
 *
 * The replacement has no floor, no ceiling, and no division: window length is FIXED at
 * {@link WINDOW_M}, so total turning is already a density. 150° over 400 m is a genuinely dramatic
 * stretch — a full switchback pair — and a single sweeping 90° bend lands at 6.
 *
 * Crests are NOT part of drama. `gradeDrama` has one elevation sample per 400 m and the real DEM
 * floor is ~69 m, so a crest is not resolvable at window scale. Out of scope rather than faked.
 */
export const FULL_HEADING_CHANGE_DEG = 150;

// ------------------------------------------------------------------------------------------------
// The mark
// ------------------------------------------------------------------------------------------------

/** The four scored dimensions. Parallel to `ScenicRubric`, NEVER added to it — the baked scenic and
 *  curated datasets and the tile corpus must stay byte-identical. */
export interface ReelMetrics {
  /** Open view to at least one side, and which side. SELECTS the shortlist rather than ranking it —
   *  see {@link REEL_WEIGHTS} and {@link BACKDROP_MIN}. */
  backdrop: number;
  /** Inverse of suburbia — the headline complaint about the reference ride. */
  cleanliness: number;
  /** Sun elevation quality x aim alignment, at the chosen shoot instant. */
  light: number;
  /** Corners, measured at window scale. */
  drama: number;
}

/**
 * Weights for the Reel composite. Invented, not measured — there is no ground truth that could
 * calibrate them (see the kappa note below), so they are round numbers chosen to say what the
 * category is about, and they are exposed as sliders rather than buried.
 *
 * WHAT 0.40 ON BACKDROP ACTUALLY DOES, because it is not what the number looks like it does. It does
 * not weight the ranking of the list the rider reads; it CHOOSES that list, and the other three then
 * rank inside the choice. Measured on the 83-tile corpus (1,417 windows, ten instant x aim
 * combinations): only 479 of the 1,417 windows carry a backdrop at all, and on the top-40 shortlist
 * backdrop reads min 9.1, 92.5% exactly 10, 3 distinct values, sd 0.204 — it contributes 0.82 to the
 * shortlist composite's sd against cleanliness 3.88, drama 3.58 and light 2.65. Filter-then-rank is
 * the correct shape for this category and this weight is the filter, so do not "fix" the saturation
 * by lowering it: lowering it does not spread the shortlist, it changes which roads reach it.
 * reelScore.ts's Backdrop section carries the full statement and the rest of the numbers.
 */
export const REEL_WEIGHTS: ReelMetrics = {
  backdrop: 0.4,
  cleanliness: 0.25,
  light: 0.2,
  drama: 0.15,
};

/**
 * One filmable stretch of road, in one direction of travel, at one instant.
 *
 * `direction` is half the deliverable. The same window ridden the other way is a DIFFERENT mark:
 * the backdrop swaps sides and the sun moves from ahead to behind.
 *
 * WHICH of the two directions is emitted is decided in `reelScore.pickDirection`, and the order of
 * that tiebreak chain is itself part of the contract — see the comment there. The short version:
 * the two directions of a window score EXACTLY equal under today's metrics (verified on all 1,404
 * windows of a real 30 km scan), so the tiebreak is not a corner case, it IS the mechanism, and it
 * resolves toward putting the backdrop on the side {@link Side} says the boom is on.
 */
export interface ReelMark {
  id: string;
  roadId: string;
  roadName: string;
  window: RoadWindow;
  /** `forward` = the road's stored vertex order; `reverse` = ridden the other way. */
  direction: 'forward' | 'reverse';
  /** Direction of travel for THIS mark (deg, 0 = N). `reverse` is the window bearing + 180. */
  travelBearingDeg: number;
  metrics: ReelMetrics;
  /** 0–100 composite under {@link REEL_WEIGHTS} or the rider's own weights. NOT a view ranking, and
   *  a UI must not present it as one: under the default weights backdrop selects the list and then
   *  contributes almost nothing to the variance inside it (sd 0.204 on the top 40), so the order
   *  reads "has a view; best light, corners and surroundings first". See {@link REEL_WEIGHTS}. */
  score: number;
  /**
   * Which side the backdrop is on for this direction of travel — `null` when neither side clears
   * {@link BACKDROP_MIN}. With a right-boom rig, `right` is the one that films.
   *
   * IN PRACTICE THIS IS `'right' | null` AND NOTHING ELSE, which a UI may rely on. `reelScore`
   * resolves the direction of travel toward the one that puts the backdrop on the boom, and because
   * the two directions of a window tie exactly under today's metrics that resolution always
   * succeeds: measured `right` on every emitted mark of all 1,417 corpus windows across ten
   * (instant x aim) combinations, with zero windows where some direction yields a right-side backdrop
   * and the emitted one does not. It is pinned by test in `reelScore.test.ts` rather than left as an
   * observation. The type stays `Side | null` because the guarantee is contingent: it rests on both
   * aim functions being symmetric about 90 deg, and an asymmetric one would let the composite
   * outrank the boom rule (see `pickDirection` step 1).
   */
  backdropSide: Side | null;
  backdrop: PerSide<BackdropReading>;
  clean: CleanReading;
  light: LightReading;
  /** Predicted tags, using D:\MotoProject's closed enum verbatim as a REPORTING convention.
   *  Only the honest ones — see the design doc for the five that were dropped as wishful. */
  tags: ReelTag[];
}

/**
 * The subset of the reel editor's closed tag enum that map data can honestly predict.
 *
 * Adopting a shared word with a DIFFERENT referent is worse than having no shared word, so the
 * six dropped tags are dropped rather than approximated: `scenery` (falsified on its own data —
 * 7 of 12 scenery marks are one municipal park, and zero involve a viewpoint or peak, which is
 * exactly what `sceneryTells` computes), `open-road` (4 of 9 are ALSO tagged canopy, including one
 * described as a tunnel feel), `traffic` (half duplicates `urban`, half is a stranger's car),
 * `hazard` (the one instance is pedestrians on a shoulder), `golden-hour` (the reference footage's
 * own golden-hour marks sit at 18–20° elevation, outside any golden band).
 *
 * `canopy` is the sixth, and it was emitted for a while before being dropped, so the reason is
 * recorded rather than left as an absence. Three facts, none of them recoverable by tuning:
 *  - It rested on `fractionInside(greenAreas)`, and features.ts pools `leisure=park` with
 *    `landuse=forest` into that one bucket, so a mown municipal lawn was indistinguishable from
 *    closed forest — while the literature is explicit that flat green is UNscenic. Separating tree
 *    cover from grass moves baked Scenic and Curated scores, so it is a different decision.
 *  - The reel project's own frame measurements say the label is over-applied, and that canopy is a
 *    property of the (mark, ANGLE) pair rather than of the road — which a per-window map reading
 *    cannot represent at all.
 *  - It was the single most expensive computation in `reelScore`: measured 379-409 ms of a 614 ms
 *    `buildMarks` on the real 11-tile Buffalo scan (8,124 green polygons, 1,404 windows), on the
 *    main thread, paid again on every debounced rebuild — to emit one boolean the design already
 *    distrusted. A signal worth 400 ms has to be one the module is willing to rank on.
 *
 * `water` is half-honest and is emitted anyway, labelled: presence yes, VISIBILITY no. There is a
 * documented case in their corpus where a six-way yaw sweep at a water mark's peak found no water
 * at any bearing — trees, a fence and a car-park shelter.
 */
export type ReelTag = 'corner' | 'water' | 'urban' | 'gravel';

/**
 * A side must clear this to be called a backdrop at all, rather than "slightly less flat".
 *
 * IT IS ALSO THE SELECTION BAR, which is the load-bearing half. With `REEL_WEIGHTS.backdrop` at 0.40
 * the shortlist is drawn almost entirely from the windows that clear this — measured on the 83-tile
 * corpus, 479 of 1,417 windows clear it on either side, and 92.5% of the top-40 shortlist sits at
 * backdrop exactly 10. So a change here is not a change to a tag threshold; it is a change to which
 * roads the rider is ever shown. See the Backdrop section of reelScore.ts.
 */
export const BACKDROP_MIN = 3.5;

/**
 * THE CEILING ON EVERYTHING ABOVE. Read before adding a decimal place anywhere.
 *
 * The only human verdicts in existence are 32 good/bad calls on rendered shots from ONE 28-minute
 * suburban ride, one evening, one rider, one camera, one town — and 49% of the rendered shots were
 * never judged at all. Of the seven marks judged more than once, pairwise agreement was 7/9 against
 * 0.53 expected by chance, so kappa = 0.53: the same mark scored *good* as `rear` in one reel and
 * *bad* as `rear` in another.
 *
 * That bounds any per-mark predictor at roughly 78% agreement with a human who does not agree with
 * themselves beyond it. The UI must never imply more confidence than that, and no weight in this
 * file should be tuned to a precision the ground truth cannot support.
 */
export const GROUND_TRUTH_KAPPA = 0.53;
