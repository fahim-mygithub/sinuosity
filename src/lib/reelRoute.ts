// Chain a shortlist of shots into one drivable evening.
//
// The Reel tab hands a rider 40 unconnected 400 m stretches, each with a direction of travel and an
// hour to be there. This turns a prefix of that list into a single ride: the stretches in the order
// that rides shortest, joined by real roads, optionally closing back to where it started.
//
// WHAT THIS DOES NOT DO, because it was a deliberate choice and not an oversight. It does not
// re-score a mark for the minute the rider will actually reach it. Every mark on the shortlist was
// scored for ONE instant, and a ride spread over an evening reaches its later shots under a sun that
// has moved — so a light-aware builder would re-rank, and the ride would stop matching the list the
// rider is looking at. The ride therefore keeps each mark's own score and reports arrival times
// alongside them, flagging any shot the rider would reach outside the usable light (see
// {@link ScheduledShot.light}). That puts the discrepancy in front of the rider instead of resolving
// it silently in either direction.
//
// GEOMETRY IS EXACT; TIME IS AN ESTIMATE. Every metre of the drawn line is a real road from the
// scanned corpus, stitched at shared junction nodes. The clock is a division: distance over
// PLANNING_SPEED_KMH, the same 45 mph the panel already quotes. Junctions, villages and stopping to
// actually film are not modelled, so arrival times are a floor and the rider should read them as
// "no earlier than".

import { haversine, pathLength, type LatLng } from './geometry';
import { RESAMPLE_M, type ReelMark } from './reelTypes';
import { resampleAlong } from './reelGeometry';
import { PLANNING_SPEED_KMH, type ShootWindow } from './reelPlan';
import {
  connectedComponents,
  findPathsFrom,
  findReturnPath,
  getReturnGraph,
  sameNode,
  type Components,
  type ReturnGraph,
} from './returnPath';
import type { AreaScan } from './overpass';
import type { RideShape } from './routeBuilder';

// ------------------------------------------------------------------------------------------------
// Tuning
// ------------------------------------------------------------------------------------------------

/**
 * Shortlist marks the builder is allowed to consider, in rank order.
 *
 * The distance matrix costs one graph search per candidate — see {@link findPathsFrom} — so this
 * bounds the expensive part of the build at 17 searches rather than the shortlist's 40. Candidates
 * past this are not silently ignored: they are reported as dropped with reason `cap`, because a
 * builder that quietly considers a quarter of the list while appearing to consider all of it is the
 * kind of cap that reads as coverage.
 */
export const MAX_CANDIDATES = 16;

/**
 * Shots one ride may contain.
 *
 * Set by the exact ordering below rather than by taste: {@link orderShots} is a Held-Karp dynamic
 * program at O(2^n · n²), which is 102,400 steps at n = 10 and 40 million at n = 20. Ten shots is
 * also about as many as a rider can actually stop and film in one window, so the exact answer and
 * the useful answer run out at roughly the same place. Above this the honest move would be a
 * heuristic tour, and the note in {@link ShootRide.dropped} says which bound bound.
 */
export const MAX_SHOTS = 10;

/**
 * A connector longer than this (km) is treated as no connection at all.
 *
 * Not a routing limit but a sanity one: without it a single reachable-but-absurd shot 80 km across
 * the scan would be chained in and eat the whole budget. Scaled from the rider's own target so a
 * long ride can take long connectors and a short one cannot.
 */
const connectorBudgetKm = (targetKm: number) => Math.max(12, targetKm * 0.6);

// ------------------------------------------------------------------------------------------------
// Types
// ------------------------------------------------------------------------------------------------

/** One stretch of the drawn ride. `shot` legs are the 400 m the cards are about; the rest is transit. */
export interface RideLeg {
  kind: 'shot' | 'connector' | 'return';
  coords: LatLng[];
  km: number;
  /** Set on `shot` legs — the mark this leg is. */
  markId?: string;
}

/** How a shot's predicted arrival sits against the evening's usable light. */
export type LightStanding = 'early' | 'in' | 'late';

export interface ScheduledShot {
  mark: ReelMark;
  /** 1-based position IN THE RIDE, which is not the mark's rank in the shortlist. */
  order: number;
  /** Predicted arrival at the start of the 400 m stretch. A floor — see the header. */
  at: Date;
  /** Cumulative distance from the ride's start to that point (km). */
  km: number;
  light: LightStanding;
}

/** Why a shortlist mark is not in the ride. Every candidate the builder saw gets one. */
export type DropReason =
  /** No route to it through the scanned corpus, or it is too far off the ride to join. */
  | 'unreachable'
  /** Adding it would push the ride past the rider's target distance. */
  | 'budget'
  /** The ride is already at {@link MAX_SHOTS}, or the mark is past {@link MAX_CANDIDATES}. */
  | 'cap';

export interface ShootRide {
  /** In riding order. */
  shots: ScheduledShot[];
  legs: RideLeg[];
  /** The whole drivable line, shots and transit alike, ready for a map or a deep link. */
  coords: LatLng[];
  km: number;
  /** Riding minutes at {@link PLANNING_SPEED_KMH}. Excludes time spent actually filming. */
  minutes: number;
  shape: RideShape;
  /** `circuit` = a genuinely different way home; `retrace` = back the way you came. */
  returnKind: 'circuit' | 'retrace' | null;
  depart: Date;
  finish: Date;
  /** Where the ride actually begins — see {@link pickIsland}. Often not near the rider's pin. */
  start: LatLng;
  /**
   * How far {@link start} is from the pin the rider actually dropped (km).
   *
   * Reported because it can be large and the rider would otherwise have no way to know. Measured at
   * Ellicottville with a 30 km radius it was 22.7 km: the shots worth chaining all stood on one
   * island of the network, and that island's nearest junction was most of the way across the scan.
   * The ride is real and rideable, but it does not start where the rider was looking, and a ride
   * view that opened with "leave at 8:25" without saying that would be lying by omission.
   */
  startOffsetKm: number;
  dropped: { mark: ReelMark; reason: DropReason }[];
}

export interface RideOptions {
  /** The rider's pin. Snapped to the nearest junction, which is what `ShootRide.start` reports. */
  from: LatLng;
  /** Distance the ride should stay under (km). */
  targetKm: number;
  /** Close the ride back to where it started. */
  loop: boolean;
  /** When the rider sets off. */
  departAt: Date;
  /** The evening's usable light, for flagging shots reached outside it. */
  window: ShootWindow;
}

// ------------------------------------------------------------------------------------------------
// A shot's approach and departure
// ------------------------------------------------------------------------------------------------

/**
 * The road a mark sits on, resampled exactly as {@link cutWindows} resampled it.
 *
 * Re-derived rather than stored on the mark because it is only needed when a ride is built, and the
 * marks are held in React state where a copy of every parent road's geometry would be carried around
 * for the 99% of sessions that never chain anything. `resampleAlong` copies both endpoints through
 * unchanged, so the resampled line's ends are the raw way's ends bit for bit — which is what lets
 * the along-road geometry below and the junction graph agree about where a road stops.
 */
interface RoadLine {
  line: LatLng[];
  spacingM: number;
}

function roadLineFor(coords: LatLng[]): RoadLine | null {
  const line = resampleAlong(coords, RESAMPLE_M);
  if (line.length < 2) return null;
  const totalM = pathLength(line) * 1000;
  if (!(totalM > 0)) return null;
  return { line, spacingM: totalM / (line.length - 1) };
}

/**
 * Everything the router needs about one shot: the stretch itself in travel order, the road either
 * side of it, and the two junctions those run out at.
 *
 * THE DIRECTION IS THE CONSTRAINT THAT SHAPES ALL OF THIS. A mark is not a place, it is a place
 * ridden a particular way — that is the Reel category's whole output. So a shot has an entry and an
 * exit rather than a position, you leave it travelling in its direction and cannot turn round inside
 * it, and the road you continue onto is fixed: the end of the parent way that lies AHEAD. A builder
 * that treated shots as waypoints would produce shorter rides that film nothing.
 */
interface ShotGeometry {
  mark: ReelMark;
  /** The 400 m, in travel order. */
  shot: LatLng[];
  shotKm: number;
  /** Road from the junction behind, up to the shot's entry, in travel order. */
  lead: LatLng[];
  leadKm: number;
  /** Road from the shot's exit, on to the junction ahead, in travel order. */
  tail: LatLng[];
  tailKm: number;
  /** Junction the `lead` starts at — where a connector INTO this shot must arrive. */
  fromNode: LatLng;
  /** Junction the `tail` ends at — where a connector OUT of this shot departs. */
  toNode: LatLng;
}

export function shotGeometry(mark: ReelMark, coords: LatLng[]): ShotGeometry | null {
  const rl = roadLineFor(coords);
  if (!rl) return null;
  const { line, spacingM } = rl;
  const i = Math.max(0, Math.min(line.length - 1, Math.round(mark.window.startM / spacingM)));
  const j = Math.max(i, Math.min(line.length - 1, i + Math.round(mark.window.lengthM / spacingM)));
  if (j <= i) return null;

  // In the road's stored order: [0..i] runs up to the window, [i..j] is the window, [j..] runs on.
  const before = line.slice(0, i + 1);
  const shot = line.slice(i, j + 1);
  const after = line.slice(j);

  // Riding `reverse` flips which of those is the approach and which is the departure, and reverses
  // all three. Everything downstream is then in travel order and needs no further sign handling.
  const rev = mark.direction === 'reverse';
  const lead = rev ? [...after].reverse() : before;
  const tail = rev ? [...before].reverse() : after;
  const shotPts = rev ? [...shot].reverse() : shot;

  return {
    mark,
    shot: shotPts,
    shotKm: pathLength(shotPts),
    lead,
    leadKm: pathLength(lead),
    tail,
    tailKm: pathLength(tail),
    fromNode: lead[0],
    toNode: tail[tail.length - 1],
  };
}

// ------------------------------------------------------------------------------------------------
// Ordering
// ------------------------------------------------------------------------------------------------

/**
 * The cheapest visiting order for a fixed set of shots, exactly.
 *
 * Held-Karp over subsets. The cost matrix is ASYMMETRIC — going from shot A to shot B leaves A at
 * its exit and enters B at its entry, and the reverse trip uses two different junctions — so the
 * usual 2-opt style improvement is unavailable here: reversing a run of the tour would reverse the
 * shots inside it, and a reversed shot is a different shot pointing the wrong way. That rules out
 * the cheap heuristics and is why this is exact instead.
 *
 * `d[i][j]` is the cost from stop i to stop j with index 0 as the ride's start. `closed` adds the
 * cost home. Returns null when no ordering is finite, i.e. some shot cannot be reached at all.
 */
export function orderShots(d: number[][], closed: boolean): { order: number[]; km: number } | null {
  const n = d.length - 1; // stops, excluding the start at index 0
  if (n <= 0) return { order: [], km: 0 };
  const full = 1 << n;
  const INF = Infinity;
  // best[mask][k] = cheapest route from the start, visiting exactly `mask`, standing at shot k.
  const best: number[][] = Array.from({ length: full }, () => new Array(n).fill(INF));
  const from: number[][] = Array.from({ length: full }, () => new Array(n).fill(-1));
  for (let k = 0; k < n; k++) best[1 << k][k] = d[0][k + 1];

  for (let mask = 1; mask < full; mask++) {
    for (let k = 0; k < n; k++) {
      const cur = best[mask][k];
      if (!(cur < INF) || !(mask & (1 << k))) continue;
      for (let m = 0; m < n; m++) {
        if (mask & (1 << m)) continue;
        const next = mask | (1 << m);
        const cost = cur + d[k + 1][m + 1];
        if (cost < best[next][m]) {
          best[next][m] = cost;
          from[next][m] = k;
        }
      }
    }
  }

  const last = full - 1;
  let endK = -1;
  let endKm = INF;
  for (let k = 0; k < n; k++) {
    const total = best[last][k] + (closed ? d[k + 1][0] : 0);
    if (total < endKm) {
      endKm = total;
      endK = k;
    }
  }
  if (endK < 0 || !(endKm < INF)) return null;

  const order: number[] = [];
  let mask = last;
  let k = endK;
  while (k >= 0) {
    order.push(k);
    const prev = from[mask][k];
    mask ^= 1 << k;
    k = prev;
  }
  order.reverse();
  return { order, km: endKm };
}

// ------------------------------------------------------------------------------------------------
// Building
// ------------------------------------------------------------------------------------------------

/**
 * Nearest of `nodes` to `at`.
 *
 * Compared in squared degrees, not metres. This ranks candidates rather than measuring them, and
 * over a scan radius the longitude foreshortening is constant enough not to change which node wins.
 */
function nearest(nodes: LatLng[], at: LatLng): LatLng | null {
  let best: LatLng | null = null;
  let bestD = Infinity;
  for (const p of nodes) {
    const d = (p[0] - at[0]) ** 2 + (p[1] - at[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * The piece of the network the ride will happen on, and where in it to start.
 *
 * NOT the junction nearest the rider's pin, which is what this replaces and why the whole builder
 * returned nothing. A scanned corpus is a set of islands rather than one network — measured at
 * Ellicottville, 129 components over 996 nodes — and the nearest junction to a pin is very often a
 * stub with nothing reachable from it. Measured on that scan the pin landed on an 8-node island
 * holding ZERO of the 16 candidate shots, while the shots sat scattered across nine other
 * components, so every route the builder asked for failed and it reported an empty ride.
 *
 * So the island is chosen first, by how many shots stand on it, and the start is the node of THAT
 * island nearest the pin. Ties go to the island whose nearest node is closer to the pin, so a rider
 * whose shots split evenly still sets off toward the nearer half.
 *
 * The rider is told: the ride starts at `ShootRide.start`, which may be some way from their pin, and
 * every shot on another island is reported as `unreachable` rather than quietly forgotten.
 */
function pickIsland(
  comps: Components,
  geoms: ShotGeometry[],
  at: LatLng,
): { start: LatLng; id: number } | null {
  const population = new Map<number, number>();
  for (const g of geoms) {
    const id = comps.of(g.fromNode);
    if (id !== null) population.set(id, (population.get(id) ?? 0) + 1);
  }
  let best: { start: LatLng; id: number; count: number; d: number } | null = null;
  for (const [id, count] of population) {
    const start = nearest(comps.nodes(id), at);
    if (!start) continue;
    const d = (start[0] - at[0]) ** 2 + (start[1] - at[1]) ** 2;
    if (!best || count > best.count || (count === best.count && d < best.d)) {
      best = { start, id, count, d };
    }
  }
  return best ? { start: best.start, id: best.id } : null;
}

/**
 * Chain the top of a shortlist into one ride.
 *
 * Selection is BY RANK, not by what happens to lie close: candidates are offered in shortlist order
 * and taken whenever the resulting tour still fits the rider's target distance. That keeps the ride
 * honest about the list it came from — the alternative, growing toward whatever is nearest, quietly
 * builds a ride out of mediocre adjacent shots and calls it the best of the evening.
 *
 * Returns null only when nothing at all could be chained: no corpus, no reachable shot, or a pin
 * with no junction near it.
 */
export function buildShootRide(marks: ReelMark[], scan: AreaScan, opts: RideOptions): ShootRide | null {
  if (!marks.length || !scan.corpus?.length) return null;
  const graph = getReturnGraph(scan.corpus);

  // Roads by id, corpus first: the corpus is what the junction graph was built from, so its geometry
  // is the geometry whose endpoints hash to real nodes.
  const byId = new Map<string, LatLng[]>();
  for (const r of scan.roads) if ((r.coords?.length ?? 0) >= 2) byId.set(r.id, r.coords);
  for (const r of scan.corpus) if ((r.coords?.length ?? 0) >= 2) byId.set(r.id, r.coords);

  const dropped: { mark: ReelMark; reason: DropReason }[] = [];
  const candidates: ShotGeometry[] = [];
  for (const m of marks) {
    if (candidates.length >= MAX_CANDIDATES) {
      dropped.push({ mark: m, reason: 'cap' });
      continue;
    }
    const coords = byId.get(m.roadId);
    const g = coords ? shotGeometry(m, coords) : null;
    if (!g) dropped.push({ mark: m, reason: 'unreachable' });
    else candidates.push(g);
  }
  if (!candidates.length) return null;

  // Pick the island before routing anything: everything on another one is unreachable by definition,
  // and knowing that up front saves a graph search per shot that could only ever return nothing.
  const comps = connectedComponents(graph);
  const island = pickIsland(comps, candidates, opts.from);
  if (!island) return null;
  const start = island.start;
  const geoms: ShotGeometry[] = [];
  for (const g of candidates) {
    if (comps.of(g.fromNode) === island.id) geoms.push(g);
    else dropped.push({ mark: g.mark, reason: 'unreachable' });
  }
  if (!geoms.length) return null;

  // One graph search per stop, each settling a whole row of the matrix. Index 0 is the ride's start,
  // which has no shot geometry: leaving it costs nothing extra and arriving back at it closes a loop.
  const maxKm = connectorBudgetKm(opts.targetKm);
  const exits = [start, ...geoms.map((g) => g.toNode)];
  const entries = [start, ...geoms.map((g) => g.fromNode)];
  const gapPath: (LatLng[] | null)[][] = exits.map((from) => {
    const paths = findPathsFrom(graph, from, entries, { maxKm });
    // A null from `findPathsFrom` means "already there" as well as "no way through"; only the second
    // is a missing connection. Two shots on adjoining ways share a junction and need no connector.
    return paths.map((p, j) => (p === null && sameNode(from, entries[j]) ? [] : p));
  });

  const legKm = (i: number, j: number): number => {
    const gap = gapPath[i][j];
    if (gap === null) return Infinity;
    const tail = i === 0 ? 0 : geoms[i - 1].tailKm;
    const lead = j === 0 ? 0 : geoms[j - 1].leadKm;
    return tail + pathLength(gap) + lead;
  };

  // Full cost matrix over start + every candidate, including the shot's own 400 m on arrival so the
  // tour's length is the ride's length and the budget test needs no correction afterwards.
  const n = geoms.length;
  const cost: number[][] = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === j ? 0 : legKm(i, j) + (j === 0 ? 0 : geoms[j - 1].shotKm))),
  );

  // Offer candidates in rank order; keep each one that still fits. Re-solving the tour per candidate
  // is what makes "fits" mean the ORDERED length rather than a running sum that no real ride has.
  const chosen: number[] = [];
  let solved: { order: number[]; km: number } | null = { order: [], km: 0 };
  for (let c = 0; c < n; c++) {
    if (chosen.length >= MAX_SHOTS) {
      dropped.push({ mark: geoms[c].mark, reason: 'cap' });
      continue;
    }
    const trial = [...chosen, c];
    const sub = subMatrix(cost, trial);
    const attempt = orderShots(sub, opts.loop);
    if (!attempt) {
      dropped.push({ mark: geoms[c].mark, reason: 'unreachable' });
      continue;
    }
    if (attempt.km > opts.targetKm) {
      dropped.push({ mark: geoms[c].mark, reason: 'budget' });
      continue;
    }
    chosen.push(c);
    solved = attempt;
  }
  if (!chosen.length || !solved) return null;

  // `solved.order` indexes into `chosen`; map back to candidate indices, then to matrix indices.
  const tour = solved.order.map((k) => chosen[k]);
  const ride = assemble(tour, geoms, gapPath, start, graph, opts);
  // Everything the builder looked at and did not take, in the order it considered them. Carried on
  // the ride rather than logged, because "why is shot #2 not in this?" is a question the rider will
  // ask and the panel can only answer if the reason travelled with the result.
  ride.dropped = dropped;
  return ride;
}

/** The cost matrix restricted to the start plus `pick`, preserving the start at index 0. */
function subMatrix(cost: number[][], pick: number[]): number[][] {
  const idx = [0, ...pick.map((p) => p + 1)];
  return idx.map((i) => idx.map((j) => cost[i][j]));
}

/** Stitch the chosen tour into legs, coordinates, distances and a clock. */
function assemble(
  tour: number[],
  geoms: ShotGeometry[],
  gapPath: (LatLng[] | null)[][],
  start: LatLng,
  graph: ReturnGraph,
  opts: RideOptions,
): ShootRide {
  const legs: RideLeg[] = [];
  const shots: ScheduledShot[] = [];
  const usedWayIds = new Set<string>();
  let km = 0;
  let at = start;
  let atIdx = 0; // matrix index of where we stand

  const push = (kind: RideLeg['kind'], coords: LatLng[], markId?: string) => {
    if (coords.length < 2) return;
    const legDistance = pathLength(coords);
    legs.push({ kind, coords, km: legDistance, ...(markId ? { markId } : {}) });
    km += legDistance;
  };

  const arrival = (cumKm: number) =>
    new Date(opts.departAt.getTime() + (cumKm / PLANNING_SPEED_KMH) * 3600_000);

  tour.forEach((c, n) => {
    const g = geoms[c];
    usedWayIds.add(g.mark.roadId);
    // Transit: off the previous road to its junction, across the graph, then onto this one.
    const tail = atIdx === 0 ? [] : geoms[atIdx - 1].tail;
    const gap = gapPath[atIdx][c + 1] ?? [];
    push('connector', joinPath([tail, gap, g.lead]));
    shots.push({
      mark: g.mark,
      order: n + 1,
      at: arrival(km),
      km,
      light: standing(arrival(km), opts.window),
    });
    push('shot', g.shot, g.mark.id);
    at = g.shot[g.shot.length - 1];
    atIdx = c + 1;
  });

  // Closing the ride. A circuit home over roads the ride has not already used is the good answer;
  // retracing is the honest fallback, and the two are labelled differently because they are a
  // different evening — see routeBuilder's LoopReturn, which draws the same distinction.
  let shape: RideShape = 'out-and-back';
  let returnKind: 'circuit' | 'retrace' | null = null;
  if (opts.loop) {
    const lastTail = geoms[atIdx - 1].tail;
    const circuit = findReturnPath(graph, lastTail[lastTail.length - 1] ?? at, start, {
      excludeWayIds: usedWayIds,
      maxKm: connectorBudgetKm(opts.targetKm) * 2,
    });
    if (circuit) {
      push('return', joinPath([lastTail, circuit]));
      shape = 'loop';
      returnKind = 'circuit';
    } else {
      const back = [...legs.flatMap((l) => l.coords)].reverse();
      push('return', back);
      returnKind = 'retrace';
    }
  }

  const coords = joinPath(legs.map((l) => l.coords));
  const minutes = (km / PLANNING_SPEED_KMH) * 60;
  return {
    shots,
    legs,
    coords,
    km,
    minutes,
    shape,
    returnKind,
    depart: opts.departAt,
    finish: new Date(opts.departAt.getTime() + minutes * 60_000),
    start,
    startOffsetKm: haversine(start, opts.from),
    dropped: [],
  };
}

/** Concatenate polylines that meet end-to-end, dropping the duplicated shared vertex. */
export function joinPath(parts: LatLng[][]): LatLng[] {
  const out: LatLng[] = [];
  for (const p of parts) {
    if (!p || p.length === 0) continue;
    if (out.length === 0) out.push(...p);
    else {
      const prev = out[out.length - 1];
      out.push(...(prev[0] === p[0][0] && prev[1] === p[0][1] ? p.slice(1) : p));
    }
  }
  return out;
}

/** Where an arrival sits against the evening's usable light. */
export function standing(at: Date, window: ShootWindow): LightStanding {
  if (!window.usable) return 'late';
  const t = at.getTime();
  if (t < window.start.getTime()) return 'early';
  if (t > window.end.getTime()) return 'late';
  return 'in';
}
