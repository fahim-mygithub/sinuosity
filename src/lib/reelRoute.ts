// One evening as one ride, chained BY HAND.
//
// The rider taps an arrow on the map, then taps the next one, and this finds the road between them.
// Tap by tap that becomes a drivable route: the stretches they chose, in the order they chose them,
// joined by real road and optionally closed back to the first.
//
// WHAT THIS REPLACES, and why. There used to be a builder here that chose the shots itself: it took
// the shortlist in rank order, solved an exact asymmetric TSP (Held-Karp) over the top sixteen under
// a distance budget, and returned the best tour it could fit. It worked, and it was measured working
// — 5 shots, 41.5 km, every leg joining to the metre. It is gone anyway, for two reasons.
//
// The first is that it answered a question the rider had not asked. Which shots to ride, and in what
// order, IS the planning — it is the part with a view about traffic, about which road is worth the
// detour, about being at the good one when the light lands. Solving it optimally for a cost function
// of pure distance produces a defensible answer to a question nobody posed, and the rider then has
// to argue with it rather than with the map.
//
// The second is that the corpus cannot support the confident version. The scan carries secondary,
// tertiary and unclassified ways but not the residential streets that knit them together, so the
// junction graph is genuinely a set of islands — measured at Ellicottville, 129 components over 996
// nodes. The old builder met that by silently dropping shots (10 of 40 on one real run) into a
// footnote. Chaining by hand turns the same fact into something the rider can see: an arrow that
// cannot be reached from where they are standing is drawn as unreachable BEFORE they tap it, and the
// count of what is still reachable is on screen. Same limitation, visible instead of accounted for.
//
// WHAT SURVIVED, because none of it was the problem: the noded junction graph and its Dijkstra, the
// direction handling in {@link shotGeometry}, leg assembly, the circuit-versus-retrace distinction,
// and the arrival clock.
//
// GEOMETRY IS EXACT; TIME IS AN ESTIMATE. Every metre of the drawn line is a real road from the
// scanned corpus, stitched at shared junction nodes. The clock is a division: distance over
// PLANNING_SPEED_KMH, the same 45 mph the panel already quotes. Junctions, villages and stopping to
// actually film are not modelled, so arrival times are a floor and the rider should read them as
// "no earlier than". The shots also keep the scores from their own cards, which were computed for a
// single instant — a shot reached two hours later is under a sun that has moved, and the ride says
// so per shot (see {@link ScheduledShot.light}) rather than quietly re-ranking.

import { haversine, pathLength, type LatLng } from './geometry';
import { RESAMPLE_M, type ReelMark } from './reelTypes';
import { resampleAlong } from './reelGeometry';
import { PLANNING_SPEED_KMH, type ShootWindow } from './reelPlan';
import {
  findPathsFrom,
  findReturnPath,
  getReturnGraph,
  sameNode,
  type ReturnGraph,
} from './returnPath';
import type { AreaScan } from './overpass';

// ------------------------------------------------------------------------------------------------
// The ride
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
  /** 1-based position in the ride, which is the order the rider tapped them in. */
  order: number;
  /** Predicted arrival at the start of the 400 m stretch. A floor — see the header. */
  at: Date;
  /** Cumulative distance from the ride's start to that point (km). */
  km: number;
  light: LightStanding;
}

export interface ShootRide {
  /** In riding order. */
  shots: ScheduledShot[];
  legs: RideLeg[];
  /** The whole drivable line, shots and transit alike, ready for a map or a deep link. */
  coords: LatLng[];
  km: number;
  /** Riding minutes at {@link PLANNING_SPEED_KMH}. Excludes time spent actually filming. */
  minutes: number;
  /** `circuit` = a genuinely different way home; `retrace` = back the way you came. */
  returnKind: 'circuit' | 'retrace' | null;
  depart: Date;
  finish: Date;
  /** Where the ride begins: the start of the first stretch the rider chained. */
  start: LatLng;
  /** Straight-line distance from the rider's pin to {@link start} (km), for the view to report. */
  startOffsetKm: number;
}

// ------------------------------------------------------------------------------------------------
// A shot's approach and departure
// ------------------------------------------------------------------------------------------------

/**
 * The road a mark sits on, resampled exactly as {@link cutWindows} resampled it.
 *
 * Re-derived rather than stored on the mark because it is only needed when a ride is chained, and the
 * marks are held in React state where a copy of every parent road's geometry would be carried around
 * for the sessions that never chain anything. `resampleAlong` copies both endpoints through
 * unchanged, so the resampled line's ends are the raw way's ends bit for bit — which is what lets the
 * along-road geometry below and the junction graph agree about where a road stops.
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
 * it, and the road you continue onto is fixed: the end of the parent way that lies AHEAD. This is
 * also why tapping two arrows can produce a longer connector than the map suggests: the route has to
 * leave the first stretch pointing the way it films and arrive at the second the same way.
 */
export interface ShotGeometry {
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
// The chain
// ------------------------------------------------------------------------------------------------

/**
 * The scanned network plus the geometry of every mark on it, computed once per shortlist.
 *
 * Built as a unit because the two must agree: `geom` is derived from the SAME road coordinates the
 * junction graph was noded from, so a shot's entry and exit hash to nodes the graph actually has. A
 * mark whose parent road is not in the corpus gets no entry here at all, and is reported as
 * unchainable rather than routed from a point the graph has never heard of.
 */
export interface ChainContext {
  graph: ReturnGraph;
  /** markId → geometry, for every mark whose parent road the corpus carries. */
  geom: Map<string, ShotGeometry>;
}

export function chainContext(marks: ReelMark[], scan: AreaScan | null): ChainContext | null {
  if (!scan?.corpus?.length || !marks.length) return null;
  const graph = getReturnGraph(scan.corpus);

  // Roads by id, corpus LAST: the corpus is what the junction graph was built from, so where the two
  // carry the same road it is the corpus geometry whose endpoints hash to real nodes.
  const byId = new Map<string, LatLng[]>();
  for (const r of scan.roads) if ((r.coords?.length ?? 0) >= 2) byId.set(r.id, r.coords);
  for (const r of scan.corpus) if ((r.coords?.length ?? 0) >= 2) byId.set(r.id, r.coords);

  const geom = new Map<string, ShotGeometry>();
  for (const m of marks) {
    const coords = byId.get(m.roadId);
    const g = coords ? shotGeometry(m, coords) : null;
    if (g) geom.set(m.id, g);
  }
  return geom.size ? { graph, geom } : null;
}

/** One tap: the shot, and the road ridden from the previous shot to reach it. */
export interface ChainLink {
  mark: ReelMark;
  /** The junction-to-junction hop only. Empty for the first link, and for two stretches whose roads
   *  already meet — in both of those there is no connector to route. */
  connector: LatLng[];
  /** Everything ridden between the previous stretch and this one (km): off the last road to its
   *  junction, across the graph, and on to this one. Zero for the first link. */
  transitKm: number;
}

export type Chain = ChainLink[];

/** Why a mark cannot follow the chain as it stands. */
export type NextBlocked =
  /** Its parent road is not in the scanned corpus, so there is no geometry to ride. */
  | 'no-geometry'
  /** No route through the scanned network from the end of the chain to its entry. */
  | 'unreachable'
  /** It is already in the chain. */
  | 'chained';

export interface NextStep {
  /** Null when the mark can be tapped next; otherwise why it cannot. */
  blocked: NextBlocked | null;
  /** What riding to it would add (km) — the same quantity as {@link ChainLink.transitKm}. */
  km: number;
  /** The junction-to-junction hop, ready to become a {@link ChainLink}. */
  path: LatLng[];
}

/**
 * Every mark's standing against the end of the chain, in ONE graph search.
 *
 * This is the affordance the whole hand-chained model rests on: the rider finds out an arrow is out
 * of reach by looking at it, not by tapping it and getting an error. One multi-target Dijkstra from
 * the chain's exit settles the whole shortlist at once — see {@link findPathsFrom} for why that is a
 * row rather than N searches.
 *
 * DELIBERATELY UNBOUNDED in distance. The old builder capped a connector at a fraction of the
 * rider's target and called anything longer unreachable, which conflated "there is no road" with
 * "that is further than I would ride" — two different answers, and only the first is the network's
 * to give. A 40 km hop is shown as 40 km and left to the rider.
 */
export function nextSteps(ctx: ChainContext, chain: Chain, marks: ReelMark[]): Map<string, NextStep> {
  const out = new Map<string, NextStep>();
  const blocked = (id: string, why: NextBlocked) => out.set(id, { blocked: why, km: 0, path: [] });

  const inChain = new Set(chain.map((l) => l.mark.id));
  const open: ReelMark[] = [];
  for (const m of marks) {
    if (inChain.has(m.id)) blocked(m.id, 'chained');
    else if (!ctx.geom.has(m.id)) blocked(m.id, 'no-geometry');
    else open.push(m);
  }

  // An empty chain has no end to route from, so anything with geometry can start one.
  const end = chain.length ? ctx.geom.get(chain[chain.length - 1].mark.id) : null;
  if (!end) {
    for (const m of open) out.set(m.id, { blocked: null, km: 0, path: [] });
    return out;
  }

  const entries = open.map((m) => ctx.geom.get(m.id)!.fromNode);
  const paths = findPathsFrom(ctx.graph, end.toNode, entries);
  open.forEach((m, i) => {
    // `findPathsFrom` answers null for "you are already there" as well as "there is no way through",
    // and only the second is a missing connection. Two shots on adjoining ways share a junction and
    // need no connector at all; treating that as unreachable would drop the easiest pair on the map.
    const path = paths[i] ?? (sameNode(end.toNode, entries[i]) ? [] : null);
    if (path === null) {
      blocked(m.id, 'unreachable');
      return;
    }
    const g = ctx.geom.get(m.id)!;
    out.set(m.id, { blocked: null, km: end.tailKm + pathLength(path) + g.leadKm, path });
  });
  return out;
}

/**
 * Add a tapped mark to the chain, or refuse.
 *
 * Takes the mark's already-computed {@link NextStep} rather than routing again: `nextSteps` has just
 * settled every reachable entry from this same node, so re-running one of those searches per tap
 * would be the same answer at the same cost. It also means the guard the rider sees on the map (a
 * dimmed arrow) and the guard that runs on the tap are literally the same value, and cannot drift.
 *
 * Returns null when the mark cannot follow, so the caller has one thing to check.
 */
export function appendShot(chain: Chain, mark: ReelMark, step: NextStep | undefined): Chain | null {
  if (!step || step.blocked !== null) return null;
  return [...chain, { mark, connector: step.path, transitKm: step.km }];
}

/**
 * Cut the chain back to just before a mark — the undo.
 *
 * Tapping a shot that is already in the chain removes it AND everything after it, which is one rule
 * rather than two: tapping the last shot undoes the last tap, and tapping the second of five backs
 * out to one. Removing from the middle is deliberately not offered — every link after a removed one
 * would need its connector re-routed from a different junction, so "remove shot 2" quietly rebuilds
 * a route the rider drew by hand, which is the thing this whole model exists to stop doing.
 */
export function truncateAt(chain: Chain, markId: string): Chain {
  const i = chain.findIndex((l) => l.mark.id === markId);
  return i < 0 ? chain : chain.slice(0, i);
}

// ------------------------------------------------------------------------------------------------
// Assembly
// ------------------------------------------------------------------------------------------------

export interface ChainRideOptions {
  /** When the rider sets off. */
  departAt: Date;
  /** The evening's usable light, for flagging shots reached outside it. */
  window: ShootWindow;
  /** Close the ride back to the start of the first stretch. */
  loop: boolean;
  /** The rider's pin — reported against the ride's start, never routed from. */
  from: LatLng;
}

/**
 * The chain as a drivable ride: legs, one polyline, distances and a clock.
 *
 * The ride STARTS AT THE FIRST STRETCH, not at the rider's pin and not at the junction behind it.
 * Getting to the first shot is a thing the rider does with a maps app from wherever they actually
 * are, and the pin is frequently on a different island of the scanned network entirely — routing to
 * it would fail, and routing to the junction behind would prepend a leg nobody asked for. What the
 * ride does instead is report how far the pin is (`startOffsetKm`) and let the view say so.
 */
export function chainRide(ctx: ChainContext, chain: Chain, opts: ChainRideOptions): ShootRide | null {
  if (!chain.length) return null;
  const geoms: ShotGeometry[] = [];
  for (const link of chain) {
    const g = ctx.geom.get(link.mark.id);
    if (!g) return null;
    geoms.push(g);
  }

  const legs: RideLeg[] = [];
  const shots: ScheduledShot[] = [];
  let km = 0;
  const push = (kind: RideLeg['kind'], coords: LatLng[], markId?: string) => {
    if (coords.length < 2) return;
    const legDistance = pathLength(coords);
    legs.push({ kind, coords, km: legDistance, ...(markId ? { markId } : {}) });
    km += legDistance;
  };
  const arrival = (cumKm: number) =>
    new Date(opts.departAt.getTime() + (cumKm / PLANNING_SPEED_KMH) * 3600_000);

  geoms.forEach((g, i) => {
    // Transit: off the previous stretch to its junction, across the graph, then on to this one.
    if (i > 0) push('connector', joinPath([geoms[i - 1].tail, chain[i].connector, g.lead]));
    shots.push({
      mark: g.mark,
      order: i + 1,
      at: arrival(km),
      km,
      light: standing(arrival(km), opts.window),
    });
    push('shot', g.shot, g.mark.id);
  });

  const first = geoms[0];
  const last = geoms[geoms.length - 1];
  const start = first.shot[0];

  // Closing the ride. A circuit home over roads the ride has not already filmed is the good answer;
  // retracing is the honest fallback, and the two are labelled differently because they are a
  // different evening — see routeBuilder's LoopReturn, which draws the same distinction.
  let returnKind: ShootRide['returnKind'] = null;
  if (opts.loop) {
    const home = sameNode(last.toNode, first.fromNode)
      ? []
      : findReturnPath(ctx.graph, last.toNode, first.fromNode, {
          excludeWayIds: new Set(geoms.map((g) => g.mark.roadId)),
        });
    if (home) {
      push('return', joinPath([last.tail, home, first.lead]));
      returnKind = 'circuit';
    } else {
      push('return', [...legs.flatMap((l) => l.coords)].reverse());
      returnKind = 'retrace';
    }
  }

  const minutes = (km / PLANNING_SPEED_KMH) * 60;
  return {
    shots,
    legs,
    coords: joinPath(legs.map((l) => l.coords)),
    km,
    minutes,
    returnKind,
    depart: opts.departAt,
    finish: new Date(opts.departAt.getTime() + minutes * 60_000),
    start,
    startOffsetKm: haversine(start, opts.from),
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
