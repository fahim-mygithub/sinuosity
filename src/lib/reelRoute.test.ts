import { describe, it, expect } from 'vitest';
import {
  appendShot,
  chainContext,
  chainRide,
  joinPath,
  nextSteps,
  shotGeometry,
  standing,
  truncateAt,
  unroutedGaps,
  type Chain,
  type ChainContext,
  type ShootRide,
} from './reelRoute';
import { buildReturnGraph, connectedComponents, findReturnPath } from './returnPath';
import { haversine, type LatLng } from './geometry';
import type { ReelMark } from './reelTypes';
import type { ShootWindow } from './reelPlan';
import type { AreaScan } from './overpass';

// The thing that can go wrong here and not look wrong is a ride that teleports: a polyline that
// renders as a plausible route while jumping between two roads that never meet. So the load-bearing
// assertions below are about JOINS — every leg starting where the last one ended — rather than about
// distances, which are easy to make agree with themselves and still be nonsense.
//
// The second load-bearing claim is that the rider's taps survive. A chained ride must ride the shots
// in the order they were tapped even when that is the long way round; the moment it reorders them to
// save distance it is the builder this replaced.

/** A junction lattice, 0.01 deg apart, so every node key is exact at the graph's 4 dp rounding. */
const P = (latStep: number, lonStep: number): LatLng => [
  Number((42.9 + latStep * 0.01).toFixed(4)),
  Number((-78.9 + lonStep * 0.01).toFixed(4)),
];

interface Way {
  id: string;
  name: string;
  coords: LatLng[];
}

/** Four ways round a square block: A east along the bottom, B north, C west along the top, D south. */
const A: Way = { id: 'A', name: 'Bottom Road', coords: [P(0, 0), P(0, 2)] };
const B: Way = { id: 'B', name: 'Right Road', coords: [P(0, 2), P(1, 2)] };
const C: Way = { id: 'C', name: 'Top Road', coords: [P(1, 2), P(1, 0)] };
const D: Way = { id: 'D', name: 'Left Road', coords: [P(1, 0), P(0, 0)] };
const SQUARE = [A, B, C, D];

/** A road that touches nothing — the islanded corpus, in miniature. */
const ISLE: Way = { id: 'ISLE', name: 'Island Road', coords: [P(9, 0), P(9, 2)] };

function scanOf(ways: Way[]): AreaScan {
  const roads = ways.map((w) => ({ id: w.id, name: w.name, coords: w.coords }));
  return { roads, corpus: roads, center: P(0, 1), radiusKm: 10, catalog: {} } as unknown as AreaScan;
}

function mark(way: Way, startM: number, direction: 'forward' | 'reverse'): ReelMark {
  return {
    id: `${way.id}@${startM}:${direction}`,
    roadId: way.id,
    roadName: way.name,
    direction,
    travelBearingDeg: 0,
    window: {
      id: `${way.id}@${startM}`,
      roadId: way.id,
      roadName: way.name,
      pts: way.coords,
      startM,
      lengthM: 400,
      mid: way.coords[0],
      bearingDeg: 0,
    },
    metrics: { backdrop: 5, cleanliness: 5, light: 5, drama: 5 },
    score: 50,
    backdropSide: 'right',
    tags: [],
  } as unknown as ReelMark;
}

const WINDOW: ShootWindow = {
  start: new Date('2026-08-02T23:00:00Z'),
  end: new Date('2026-08-03T01:00:00Z'),
  minutes: 120,
  rideKm: 144,
  golden: null,
  kind: 'evening',
  usable: true,
};

const DEPART = new Date('2026-08-02T23:00:00Z');

const opts = (over: Partial<Parameters<typeof chainRide>[2]> = {}) => ({
  from: P(0, 0),
  loop: false,
  departAt: DEPART,
  window: WINDOW,
  ...over,
});

/**
 * The same mark, on a road the corpus does not carry.
 *
 * A distinct id, because a mark is identified by its window and direction, so two marks differing
 * only in parent road would otherwise collide. And a window OFF THE JUNCTION LATTICE, because that
 * is the real shape of this case: a 400 m stretch sits mid-road, and its ends are ordinary vertices
 * rather than junctions. Reusing a way's own endpoints here would hand the fallback geometry two
 * real graph nodes and quietly make the unroutable case routable.
 */
const orphaned = (m: ReelMark): ReelMark =>
  ({
    ...m,
    id: `${m.id}:orphan`,
    roadId: 'NOPE',
    window: { ...m.window, pts: [[42.9037, -78.9037], [42.9037, -78.9021]] as LatLng[] },
  }) as ReelMark;

/** Tap marks in order, exactly as the map does: ask what can follow, then follow it. */
function chainOf(ctx: ChainContext, marks: ReelMark[], taps: ReelMark[]): Chain {
  let chain: Chain = [];
  for (const t of taps) {
    const next = appendShot(chain, t, nextSteps(ctx, chain, marks).get(t.id));
    expect(next).not.toBeNull();
    chain = next!;
  }
  return chain;
}

/** Metres between two points — the unit the join assertions are stated in. */
const gapM = (a: LatLng, b: LatLng) => haversine(a, b) * 1000;

/** The graph rounds node keys to 4 dp, so two points that ARE one junction can differ by ~11 m. */
const JOIN_TOL_M = 15;

function assertContinuous(ride: ShootRide) {
  for (let i = 1; i < ride.legs.length; i++) {
    const prev = ride.legs[i - 1].coords;
    const next = ride.legs[i].coords;
    expect(gapM(prev[prev.length - 1], next[0])).toBeLessThan(JOIN_TOL_M);
  }
}

describe('shotGeometry', () => {
  it('puts the entry before the exit in travel order, both ways round', () => {
    const fwd = shotGeometry(mark(A, 400, 'forward'), A.coords)!;
    const rev = shotGeometry(mark(A, 400, 'reverse'), A.coords)!;
    // Riding forward you arrive from the west end; riding reverse, from the east.
    expect(gapM(fwd.fromNode, A.coords[0])).toBeLessThan(JOIN_TOL_M);
    expect(gapM(fwd.toNode, A.coords[1])).toBeLessThan(JOIN_TOL_M);
    expect(gapM(rev.fromNode, A.coords[1])).toBeLessThan(JOIN_TOL_M);
    expect(gapM(rev.toNode, A.coords[0])).toBeLessThan(JOIN_TOL_M);
  });

  it('rides the same ground either way, in opposite orders', () => {
    const fwd = shotGeometry(mark(A, 400, 'forward'), A.coords)!;
    const rev = shotGeometry(mark(A, 400, 'reverse'), A.coords)!;
    expect(rev.shot).toEqual([...fwd.shot].reverse());
    expect(fwd.shotKm).toBeCloseTo(rev.shotKm, 9);
  });

  it('joins lead → shot → tail with no gap, so the road through a shot is continuous', () => {
    for (const dir of ['forward', 'reverse'] as const) {
      const g = shotGeometry(mark(A, 400, dir), A.coords)!;
      expect(gapM(g.lead[g.lead.length - 1], g.shot[0])).toBeLessThan(1);
      expect(gapM(g.shot[g.shot.length - 1], g.tail[0])).toBeLessThan(1);
    }
  });

  it('measures the stretch at roughly the window length it was cut to', () => {
    const g = shotGeometry(mark(A, 400, 'forward'), A.coords)!;
    // Resampling lands the cut on 25 m samples, so this is exact to a sample, not to the metre.
    expect(g.shotKm * 1000).toBeGreaterThan(375);
    expect(g.shotKm * 1000).toBeLessThan(425);
  });

  it('returns null for a road too short to hold the window it claims', () => {
    expect(shotGeometry(mark(A, 400, 'forward'), [P(0, 0), P(0, 0)])).toBeNull();
  });
});

describe('joinPath', () => {
  it('drops the shared vertex where two parts meet', () => {
    expect(joinPath([[P(0, 0), P(0, 1)], [P(0, 1), P(0, 2)]])).toEqual([P(0, 0), P(0, 1), P(0, 2)]);
  });

  it('keeps both points when the parts do not actually meet', () => {
    expect(joinPath([[P(0, 0), P(0, 1)], [P(1, 1), P(1, 2)]])).toHaveLength(4);
  });

  it('skips empty parts rather than producing holes', () => {
    expect(joinPath([[P(0, 0), P(0, 1)], [], [P(0, 1), P(0, 2)]])).toHaveLength(3);
    expect(joinPath([])).toEqual([]);
  });
});

describe('standing', () => {
  it('places an arrival against the usable light', () => {
    expect(standing(new Date('2026-08-02T22:00:00Z'), WINDOW)).toBe('early');
    expect(standing(new Date('2026-08-03T00:00:00Z'), WINDOW)).toBe('in');
    expect(standing(new Date('2026-08-03T02:00:00Z'), WINDOW)).toBe('late');
  });

  it('calls everything late on a day with no usable light at all', () => {
    expect(standing(DEPART, { ...WINDOW, usable: false })).toBe('late');
  });
});

describe('the junction graph the chain routes over', () => {
  it('joins a side road that meets the MIDDLE of a through road', () => {
    // The failure this replaces. Endpoint-only noding left a real road network in pieces: measured
    // on the Ellicottville corpus, 298 components over 978 nodes with the largest holding 18.
    const through = { id: 'T', name: 'Through', coords: [P(0, 0), P(0, 1), P(0, 2)] };
    const side = { id: 'S', name: 'Side', coords: [P(0, 1), P(1, 1)] };
    const graph = buildReturnGraph([through, side] as never);
    const comps = connectedComponents(graph);
    // Both ends of the through road and the far end of the side road are one network.
    expect(comps.of(P(0, 0))).not.toBeNull();
    expect(comps.of(P(0, 0))).toBe(comps.of(P(1, 1)));
    expect(comps.of(P(0, 2))).toBe(comps.of(P(1, 1)));
    // …and the through road really was cut at the junction rather than left whole.
    expect(comps.of(P(0, 1))).toBe(comps.of(P(0, 0)));
    expect(findReturnPath(graph, P(1, 1), P(0, 2))).not.toBeNull();
  });

  it('leaves genuinely separate roads separate', () => {
    // Two ways that share no vertex do not meet, whatever a bridge looks like from above.
    const graph = buildReturnGraph([A, ISLE] as never);
    const comps = connectedComponents(graph);
    expect(comps.of(P(0, 0))).not.toBe(comps.of(P(9, 0)));
    expect(findReturnPath(graph, P(0, 0), P(9, 2))).toBeNull();
  });

  it('keeps a split way under its parent id, so excluding the road excludes all of it', () => {
    const graph = buildReturnGraph([
      { id: 'T', name: 'Through', coords: [P(0, 0), P(0, 1), P(0, 2)] },
      { id: 'S', name: 'Side', coords: [P(0, 1), P(1, 1)] },
    ] as never);
    // With T excluded there is no way from one end of it to the other, even though it is two edges.
    expect(findReturnPath(graph, P(0, 0), P(0, 2), { excludeWayIds: new Set(['T']) })).toBeNull();
  });

  it('reports component sizes, which is what the reachability read depends on', () => {
    const graph = buildReturnGraph([
      { id: 'A', name: 'A', coords: [P(0, 0), P(0, 1), P(0, 2)] },
      { id: 'B', name: 'B', coords: [P(0, 1), P(1, 1)] },
      ISLE,
    ] as never);
    const comps = connectedComponents(graph);
    const big = comps.of(P(0, 0))!;
    const small = comps.of(P(9, 0))!;
    expect(comps.size(big)).toBeGreaterThan(comps.size(small));
    expect(comps.size(small)).toBe(2);
    expect(comps.nodes(small)).toHaveLength(2);
  });
});

describe('chainContext', () => {
  it('carries geometry for every mark whose road the corpus has', () => {
    const marks = [mark(A, 400, 'forward'), mark(C, 400, 'forward')];
    const ctx = chainContext(marks, scanOf(SQUARE))!;
    expect(ctx.geom.size).toBe(2);
  });

  it('falls back to the stretch the mark carries when the corpus lacks its road', () => {
    // The window's own points ARE the 400 m, resampled and already drawn on the map. What is missing
    // is the road either side, so the stretch has no approach, no departure and no junctions — which
    // is what makes every hop to or from it unrouted rather than impossible.
    const orphan = orphaned(mark(A, 400, 'forward'));
    const ctx = chainContext([mark(C, 400, 'forward'), orphan], scanOf(SQUARE))!;
    const g = ctx.geom.get(orphan.id)!;
    expect(g.shot).toEqual(orphan.window.pts);
    expect(g.leadKm).toBe(0);
    expect(g.tailKm).toBe(0);
    expect(g.fromNode).toEqual(orphan.window.pts[0]);
    expect(ctx.geom.size).toBe(2);
  });

  it('rides a fallback stretch the way the mark points, same as any other', () => {
    const rev = orphaned(mark(A, 400, 'reverse'));
    const ctx = chainContext([rev], scanOf(SQUARE))!;
    expect(ctx.geom.get(rev.id)!.shot).toEqual([...rev.window.pts].reverse());
  });

  it('is null when there is nothing to chain over', () => {
    expect(chainContext([], scanOf(SQUARE))).toBeNull();
    expect(chainContext([mark(A, 400, 'forward')], null)).toBeNull();
    expect(chainContext([mark(A, 400, 'forward')], { ...scanOf(SQUARE), corpus: [] } as AreaScan)).toBeNull();
  });
});

describe('nextSteps', () => {
  const marks = [mark(A, 400, 'forward'), mark(C, 400, 'forward'), mark(D, 200, 'forward')];
  const ctx = chainContext(marks, scanOf(SQUARE))!;

  it('costs nothing to start a chain — any shot can be the first', () => {
    const steps = nextSteps(ctx, [], marks);
    expect([...steps.values()].every((s) => !s.chained && s.routed && s.km === 0)).toBe(true);
  });

  it('marks what is already in the chain, so a tap there cuts back instead of repeating a shot', () => {
    const chain = chainOf(ctx, marks, [marks[0]]);
    expect(nextSteps(ctx, chain, marks).get(marks[0].id)!.chained).toBe(true);
  });

  it('quotes the WHOLE ride to the next shot, not just the hop between junctions', () => {
    // Off the current stretch to its junction, across the graph, and on to the next stretch. A
    // number that counted only the middle would under-quote every hop by up to two roads' length.
    const chain = chainOf(ctx, marks, [marks[0]]);
    const step = nextSteps(ctx, chain, marks).get(marks[1].id)!;
    const from = ctx.geom.get(marks[0].id)!;
    const to = ctx.geom.get(marks[1].id)!;
    expect(step.routed).toBe(true);
    expect(step.km).toBeGreaterThan(from.tailKm + to.leadKm);
    expect(step.km).toBeCloseTo(from.tailKm + haversine(P(0, 2), P(1, 2)) + to.leadKm, 6);
  });

  it('charges nothing for a hop between stretches that already share a junction', () => {
    // A ridden forward ends at P(0,2); B ridden forward starts there. There is no connector to route
    // and no distance to add beyond running off one road and on to the next.
    const pair = [mark(A, 400, 'forward'), mark(B, 200, 'forward')];
    const adj = chainContext(pair, scanOf(SQUARE))!;
    const chain = chainOf(adj, pair, [pair[0]]);
    const step = nextSteps(adj, chain, pair).get(pair[1].id)!;
    expect(step.routed).toBe(true);
    expect(step.path).toEqual([]);
    expect(step.km).toBeCloseTo(
      adj.geom.get(pair[0].id)!.tailKm + adj.geom.get(pair[1].id)!.leadKm,
      6,
    );
  });

  it('offers a shot on another island as a STRAIGHT hop rather than refusing it', () => {
    // The corpus carries no residential streets, so it is genuinely islanded — measured on a real
    // Buffalo scan one tap left 6 of 39 arrows routable and another left none. Refusing the tap put
    // that gap in charge of the rider's route; quoting it as a straight line does not.
    const all = [...marks, mark(ISLE, 400, 'forward')];
    const isled = chainContext(all, scanOf([...SQUARE, ISLE]))!;
    const chain = chainOf(isled, all, [all[0]]);
    const step = nextSteps(isled, chain, all).get(all[3].id)!;
    expect(step.routed).toBe(false);
    expect(step.path).toEqual([]);
    // The straight line from the end of the last stretch to the start of the island one.
    const from = isled.geom.get(all[0].id)!;
    const to = isled.geom.get(all[3].id)!;
    expect(step.km).toBeCloseTo(haversine(from.shot[from.shot.length - 1], to.shot[0]), 9);
    // …and the routable neighbour is still routed, so this is not a blanket give-up.
    expect(nextSteps(isled, chain, all).get(all[1].id)!.routed).toBe(true);
  });

  it('offers a mark whose road the corpus never loaded, using the stretch the mark carries', () => {
    const orphan = orphaned(mark(A, 400, 'forward'));
    const all = [...marks, orphan];
    const withOrphan = chainContext(all, scanOf(SQUARE))!;
    expect(withOrphan.geom.has(orphan.id)).toBe(true);
    const step = nextSteps(withOrphan, chainOf(withOrphan, all, [all[0]]), all).get(orphan.id)!;
    expect(step.chained).toBe(false);
    expect(step.routed).toBe(false);
  });
});

describe('appendShot', () => {
  const marks = [mark(A, 400, 'forward'), mark(C, 400, 'forward')];
  const ctx = chainContext(marks, scanOf(SQUARE))!;

  it('accepts a shot with no road route to it — the corpus does not get a veto', () => {
    const all = [...marks, mark(ISLE, 400, 'forward')];
    const isled = chainContext(all, scanOf([...SQUARE, ISLE]))!;
    const chain = chainOf(isled, all, [all[0]]);
    const steps = nextSteps(isled, chain, all);
    const grown = appendShot(chain, all[2], steps.get(all[2].id))!;
    expect(grown).toHaveLength(2);
    expect(grown[1].routed).toBe(false);
  });

  it('declines only a repeat, which is the cut-back gesture', () => {
    const chain = chainOf(ctx, marks, [marks[0]]);
    const steps = nextSteps(ctx, chain, marks);
    expect(appendShot(chain, marks[0], steps.get(marks[0].id))).toBeNull();
    expect(appendShot(chain, marks[1], undefined)).toBeNull();
  });

  it('keeps the routed hop on the link, so the ride never re-routes what the rider chose', () => {
    const chain = chainOf(ctx, marks, [marks[0], marks[1]]);
    const step = nextSteps(ctx, [chain[0]], marks).get(marks[1].id)!;
    expect(chain[1].connector).toEqual(step.path);
    expect(chain[1].transitKm).toBe(step.km);
    expect(chain[1].routed).toBe(true);
    expect(chain[0].transitKm).toBe(0);
  });
});

describe('truncateAt', () => {
  const marks = [mark(A, 400, 'forward'), mark(C, 400, 'forward'), mark(D, 200, 'forward')];
  const ctx = chainContext(marks, scanOf(SQUARE))!;

  it('cuts the tapped shot AND everything after it', () => {
    const chain = chainOf(ctx, marks, [marks[0], marks[1], marks[2]]);
    expect(truncateAt(chain, marks[1].id).map((l) => l.mark.id)).toEqual([marks[0].id]);
    expect(truncateAt(chain, marks[2].id)).toHaveLength(2);
    expect(truncateAt(chain, marks[0].id)).toEqual([]);
  });

  it('leaves a chain alone when the shot is not in it', () => {
    const chain = chainOf(ctx, marks, [marks[0]]);
    expect(truncateAt(chain, 'nope')).toBe(chain);
  });
});

describe('chainRide', () => {
  const marks = [mark(A, 400, 'forward'), mark(C, 400, 'forward')];
  const ctx = chainContext(marks, scanOf(SQUARE))!;

  it('chains two shots on opposite sides of a block into one continuous ride', () => {
    const ride = chainRide(ctx, chainOf(ctx, marks, [marks[0], marks[1]]), opts())!;
    expect(ride).not.toBeNull();
    expect(ride.shots).toHaveLength(2);
    assertContinuous(ride);
    expect(ride.legs.filter((l) => l.kind === 'shot')).toHaveLength(2);
    expect(ride.legs.filter((l) => l.kind === 'connector')).toHaveLength(1);
  });

  it('rides them in the order they were TAPPED, both ways round', () => {
    // The whole point of hand-chaining. A builder that reordered for distance would return the same
    // ride for both of these, and the rider's second tap would silently become their first shot.
    const forwards = chainRide(ctx, chainOf(ctx, marks, [marks[0], marks[1]]), opts())!;
    const backwards = chainRide(ctx, chainOf(ctx, marks, [marks[1], marks[0]]), opts())!;
    expect(forwards.shots.map((s) => s.mark.id)).toEqual([marks[0].id, marks[1].id]);
    expect(backwards.shots.map((s) => s.mark.id)).toEqual([marks[1].id, marks[0].id]);
    assertContinuous(backwards);
  });

  it('starts at the first stretch, and measures how far that is from the pin', () => {
    const chain = chainOf(ctx, marks, [marks[1]]);
    const ride = chainRide(ctx, chain, opts({ from: P(0, 0) }))!;
    expect(ride.start).toEqual(ctx.geom.get(marks[1].id)!.shot[0]);
    expect(gapM(ride.coords[0], ride.start)).toBeLessThan(1);
    // C is the far side of the block from the pin, and the ride says so rather than routing there.
    expect(ride.startOffsetKm).toBeGreaterThan(1);
  });

  it('rides each shot in its own direction, not whichever way is convenient', () => {
    const m = mark(C, 400, 'reverse');
    const rev = chainContext([m], scanOf(SQUARE))!;
    const ride = chainRide(rev, chainOf(rev, [m], [m]), opts())!;
    expect(ride.legs.find((l) => l.markId === m.id)!.coords).toEqual(shotGeometry(m, C.coords)!.shot);
  });

  it('closes a loop back to the start when asked, over roads it has not filmed', () => {
    const ride = chainRide(ctx, chainOf(ctx, marks, [marks[0], marks[1]]), opts({ loop: true }))!;
    assertContinuous(ride);
    expect(ride.returnKind).toBe('circuit');
    expect(gapM(ride.coords[ride.coords.length - 1], ride.start)).toBeLessThan(JOIN_TOL_M);
  });

  it('calls a retrace a retrace when there is no other way home', () => {
    // A dead-end pair: nothing joins the far end of B back to the near end of A except A and B.
    const pair = [mark(A, 400, 'forward'), mark(B, 200, 'forward')];
    const deadEnd = chainContext(pair, scanOf([A, B]))!;
    const ride = chainRide(deadEnd, chainOf(deadEnd, pair, pair), opts({ loop: true }))!;
    expect(ride.returnKind).toBe('retrace');
    expect(gapM(ride.coords[ride.coords.length - 1], ride.start)).toBeLessThan(JOIN_TOL_M);
  });

  it('leaves the ride open when a loop was not asked for', () => {
    const ride = chainRide(ctx, chainOf(ctx, marks, [marks[0]]), opts())!;
    expect(ride.returnKind).toBeNull();
    expect(ride.legs.some((l) => l.kind === 'return')).toBe(false);
  });

  it('schedules arrivals in riding order, at the planning speed', () => {
    const ride = chainRide(ctx, chainOf(ctx, marks, [marks[0], marks[1]]), opts())!;
    expect(ride.shots[0].at.getTime()).toBeLessThan(ride.shots[1].at.getTime());
    expect(ride.shots[0].at.getTime()).toBeGreaterThanOrEqual(DEPART.getTime());
    expect(ride.shots.map((s) => s.order)).toEqual([1, 2]);
    expect(ride.shots[0].km).toBe(0);
    // Distance and clock are the same quantity twice; they may not disagree by more than a Date can
    // represent. `finish` is built by adding milliseconds to a Date, which truncates, so the two
    // agree to within one — asking for more precision tests the clock's resolution, not the ride.
    expect(Math.abs(ride.finish.getTime() - ride.depart.getTime() - ride.minutes * 60_000)).toBeLessThan(1);
  });

  it('flags a shot the rider would reach after the light has gone', () => {
    const dusk = { ...WINDOW, end: new Date(DEPART.getTime() + 1000) };
    const ride = chainRide(ctx, chainOf(ctx, marks, [marks[0], marks[1]]), opts({ window: dusk }))!;
    expect(ride.shots[1].light).toBe('late');
  });

  it('has nothing to draw for an empty chain', () => {
    expect(chainRide(ctx, [], opts())).toBeNull();
  });

  describe('an unrouted hop', () => {
    const all = [mark(A, 400, 'forward'), mark(ISLE, 400, 'forward')];
    const isled = chainContext(all, scanOf([...SQUARE, ISLE]))!;
    const ride = chainRide(isled, chainOf(isled, all, all), opts())!;

    it('is drawn as the straight line between the two stretches, and nothing else', () => {
      // NOT via either road's junctions. Those are approaches to a crossing this hop is not using,
      // and including them would dress a guess up as measured road.
      const gap = ride.legs.find((l) => l.kind === 'gap')!;
      expect(gap.coords).toHaveLength(2);
      const from = isled.geom.get(all[0].id)!;
      const to = isled.geom.get(all[1].id)!;
      expect(gap.coords[0]).toEqual(from.shot[from.shot.length - 1]);
      expect(gap.coords[1]).toEqual(to.shot[0]);
      assertContinuous(ride);
    });

    it('is reported separately, so the ride is never read as fully measured', () => {
      const gaps = unroutedGaps(ride);
      expect(gaps.count).toBe(1);
      expect(gaps.km).toBeGreaterThan(0);
      expect(gaps.km).toBeLessThan(ride.km);
      // The straight line is a floor: the real road across it can only be longer.
      expect(gaps.km).toBeCloseTo(haversine(...(ride.legs.find((l) => l.kind === 'gap')!.coords as [LatLng, LatLng])), 9);
    });

    it('leaves a fully routed ride reporting nothing', () => {
      const clean = chainRide(ctx, chainOf(ctx, marks, [marks[0], marks[1]]), opts())!;
      expect(unroutedGaps(clean)).toEqual({ count: 0, km: 0 });
      expect(clean.legs.some((l) => l.kind === 'gap')).toBe(false);
    });
  });
});
