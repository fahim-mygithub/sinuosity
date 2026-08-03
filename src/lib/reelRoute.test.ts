import { describe, it, expect } from 'vitest';
import {
  MAX_SHOTS,
  buildShootRide,
  joinPath,
  orderShots,
  shotGeometry,
  standing,
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

/** A junction lattice, 0.01 deg apart, so every node key is exact at the graph's 4 dp rounding. */
const P = (latStep: number, lonStep: number): LatLng => [
  Number((42.9 + latStep * 0.01).toFixed(4)),
  Number((-78.9 + lonStep * 0.01).toFixed(4)),
];

/** Four ways round a square block: A east along the bottom, B north, C west along the top, D south. */
const SQUARE = [
  { id: 'A', name: 'Bottom Road', coords: [P(0, 0), P(0, 2)] },
  { id: 'B', name: 'Right Road', coords: [P(0, 2), P(1, 2)] },
  { id: 'C', name: 'Top Road', coords: [P(1, 2), P(1, 0)] },
  { id: 'D', name: 'Left Road', coords: [P(1, 0), P(0, 0)] },
];

function scanOf(ways: { id: string; name: string; coords: LatLng[] }[]): AreaScan {
  const roads = ways.map((w) => ({ id: w.id, name: w.name, coords: w.coords }));
  return { roads, corpus: roads, center: P(0, 1), radiusKm: 10, catalog: {} } as unknown as AreaScan;
}

function mark(roadId: string, startM: number, direction: 'forward' | 'reverse'): ReelMark {
  const way = SQUARE.find((w) => w.id === roadId)!;
  return {
    id: `${roadId}@${startM}:${direction}`,
    roadId,
    roadName: way.name,
    direction,
    travelBearingDeg: 0,
    window: {
      id: `${roadId}@${startM}`,
      roadId,
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

const opts = (over: Partial<Parameters<typeof buildShootRide>[2]> = {}) => ({
  from: P(0, 0),
  targetKm: 40,
  loop: false,
  departAt: DEPART,
  window: WINDOW,
  ...over,
});

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

describe('orderShots', () => {
  it('returns the empty tour for no stops', () => {
    expect(orderShots([[0]], false)).toEqual({ order: [], km: 0 });
  });

  it('finds the cheapest order, not the order it was given', () => {
    // Start 0. Visiting 2 then 1 costs 1 + 1 + 1 = 3; visiting 1 then 2 costs 10 + 1 + ... worse.
    const d = [
      [0, 10, 1],
      [10, 0, 1],
      [1, 1, 0],
    ];
    const got = orderShots(d, false)!;
    expect(got.order).toEqual([1, 0]);
    expect(got.km).toBe(2);
  });

  it('respects an ASYMMETRIC matrix, where a reversed tour is a different price', () => {
    // A shot is entered at one end and left at the other, so d[i][j] !== d[j][i] in general. A
    // solver that assumed symmetry (or improved a tour by reversing a run) would miss this.
    const d = [
      [0, 1, 9],
      [9, 0, 1],
      [1, 9, 0],
    ];
    // 0→1→2 costs 1 + 1 = 2. 0→2→1 costs 9 + 9 = 18.
    expect(orderShots(d, false)!.order).toEqual([0, 1]);
    expect(orderShots(d, false)!.km).toBe(2);
  });

  it('prices the way home when the ride is closed, and can pick a different order because of it', () => {
    const d = [
      [0, 1, 2],
      [1, 0, 1],
      [2, 1, 0],
    ];
    const open = orderShots(d, false)!;
    const closed = orderShots(d, true)!;
    expect(closed.km).toBe(open.km + d[open.order[open.order.length - 1] + 1][0]);
  });

  it('returns null when a stop cannot be reached at all', () => {
    const d = [
      [0, 1, Infinity],
      [1, 0, Infinity],
      [Infinity, Infinity, 0],
    ];
    expect(orderShots(d, false)).toBeNull();
  });

  it('visits every stop exactly once', () => {
    const n = 6;
    const d = Array.from({ length: n + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === j ? 0 : 1 + ((i * 7 + j * 13) % 9))),
    );
    const got = orderShots(d, true)!;
    expect([...got.order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('shotGeometry', () => {
  const way = SQUARE[0];

  it('puts the entry before the exit in travel order, both ways round', () => {
    const fwd = shotGeometry(mark('A', 400, 'forward'), way.coords)!;
    const rev = shotGeometry(mark('A', 400, 'reverse'), way.coords)!;
    // Riding forward you arrive from the west end; riding reverse, from the east.
    expect(gapM(fwd.fromNode, way.coords[0])).toBeLessThan(JOIN_TOL_M);
    expect(gapM(fwd.toNode, way.coords[1])).toBeLessThan(JOIN_TOL_M);
    expect(gapM(rev.fromNode, way.coords[1])).toBeLessThan(JOIN_TOL_M);
    expect(gapM(rev.toNode, way.coords[0])).toBeLessThan(JOIN_TOL_M);
  });

  it('rides the same ground either way, in opposite orders', () => {
    const fwd = shotGeometry(mark('A', 400, 'forward'), way.coords)!;
    const rev = shotGeometry(mark('A', 400, 'reverse'), way.coords)!;
    expect(rev.shot).toEqual([...fwd.shot].reverse());
    expect(fwd.shotKm).toBeCloseTo(rev.shotKm, 9);
  });

  it('joins lead → shot → tail with no gap, so the road through a shot is continuous', () => {
    for (const dir of ['forward', 'reverse'] as const) {
      const g = shotGeometry(mark('A', 400, dir), way.coords)!;
      expect(gapM(g.lead[g.lead.length - 1], g.shot[0])).toBeLessThan(1);
      expect(gapM(g.shot[g.shot.length - 1], g.tail[0])).toBeLessThan(1);
    }
  });

  it('measures the stretch at roughly the window length it was cut to', () => {
    const g = shotGeometry(mark('A', 400, 'forward'), way.coords)!;
    // Resampling lands the cut on 25 m samples, so this is exact to a sample, not to the metre.
    expect(g.shotKm * 1000).toBeGreaterThan(375);
    expect(g.shotKm * 1000).toBeLessThan(425);
  });

  it('returns null for a road too short to hold the window it claims', () => {
    expect(shotGeometry(mark('A', 400, 'forward'), [P(0, 0), P(0, 0)])).toBeNull();
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

describe('the junction graph the ride routes over', () => {
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
    const graph = buildReturnGraph([
      { id: 'A', name: 'A', coords: [P(0, 0), P(0, 2)] },
      { id: 'B', name: 'B', coords: [P(5, 0), P(5, 2)] },
    ] as never);
    const comps = connectedComponents(graph);
    expect(comps.of(P(0, 0))).not.toBe(comps.of(P(5, 0)));
    expect(findReturnPath(graph, P(0, 0), P(5, 2))).toBeNull();
  });

  it('keeps a split way under its parent id, so excluding the road excludes all of it', () => {
    const graph = buildReturnGraph([
      { id: 'T', name: 'Through', coords: [P(0, 0), P(0, 1), P(0, 2)] },
      { id: 'S', name: 'Side', coords: [P(0, 1), P(1, 1)] },
    ] as never);
    // With T excluded there is no way from one end of it to the other, even though it is two edges.
    expect(findReturnPath(graph, P(0, 0), P(0, 2), { excludeWayIds: new Set(['T']) })).toBeNull();
  });

  it('reports component sizes, which is what picking a start depends on', () => {
    const graph = buildReturnGraph([
      { id: 'A', name: 'A', coords: [P(0, 0), P(0, 1), P(0, 2)] },
      { id: 'B', name: 'B', coords: [P(0, 1), P(1, 1)] },
      { id: 'C', name: 'C', coords: [P(9, 0), P(9, 2)] },
    ] as never);
    const comps = connectedComponents(graph);
    const big = comps.of(P(0, 0))!;
    const small = comps.of(P(9, 0))!;
    expect(comps.size(big)).toBeGreaterThan(comps.size(small));
    expect(comps.size(small)).toBe(2);
    expect(comps.nodes(small)).toHaveLength(2);
  });
});

describe('buildShootRide', () => {
  const scan = scanOf(SQUARE);

  it('starts on the island the shots are on, not at the junction nearest the pin', () => {
    // A stub road right next to the pin, connected to nothing. Snapping by distance alone lands on
    // it and every route then fails — which is exactly what shipped nothing on the real corpus.
    const stub = { id: 'STUB', name: 'Stub', coords: [P(0, -3), P(0, -2)] };
    const withStub = scanOf([...SQUARE, stub]);
    const ride = buildShootRide(
      [mark('C', 400, 'forward')],
      withStub,
      opts({ from: P(0, -3) }),
    )!;
    expect(ride).not.toBeNull();
    expect(ride.shots).toHaveLength(1);
    // The start is on the square, not on the stub it was dropped next to.
    expect(gapM(ride.start, P(0, -3))).toBeGreaterThan(500);
    expect(ride.startOffsetKm).toBeGreaterThan(0.5);
  });

  it('measures how far the start is from the pin, so the view can say so', () => {
    const ride = buildShootRide([mark('A', 400, 'forward')], scan, opts({ from: P(0, 0) }))!;
    expect(ride.startOffsetKm).toBeCloseTo(0, 2);
  });

  it('chains two shots on opposite sides of a block into one continuous ride', () => {
    const ride = buildShootRide([mark('A', 400, 'forward'), mark('C', 400, 'forward')], scan, opts())!;
    expect(ride).not.toBeNull();
    expect(ride.shots).toHaveLength(2);
    assertContinuous(ride);
    // The drawn line starts at the ride's start and every shot appears in it.
    expect(gapM(ride.coords[0], ride.start)).toBeLessThan(JOIN_TOL_M);
    expect(ride.legs.filter((l) => l.kind === 'shot')).toHaveLength(2);
  });

  it('rides each shot in its own direction, not whichever way is convenient', () => {
    // C reversed must be ridden east-to-west's opposite; the leg drawn has to match the mark.
    const m = mark('C', 400, 'reverse');
    const ride = buildShootRide([m], scan, opts())!;
    const leg = ride.legs.find((l) => l.markId === m.id)!;
    const geom = shotGeometry(m, SQUARE[2].coords)!;
    expect(leg.coords).toEqual(geom.shot);
  });

  it('closes a loop back to the start when asked', () => {
    const ride = buildShootRide(
      [mark('A', 400, 'forward'), mark('C', 400, 'forward')],
      scan,
      opts({ loop: true }),
    )!;
    assertContinuous(ride);
    expect(ride.returnKind).not.toBeNull();
    const last = ride.coords[ride.coords.length - 1];
    expect(gapM(last, ride.start)).toBeLessThan(JOIN_TOL_M);
  });

  it('leaves the ride open when a loop was not asked for', () => {
    const ride = buildShootRide([mark('A', 400, 'forward')], scan, opts())!;
    expect(ride.returnKind).toBeNull();
    expect(ride.shape).toBe('out-and-back');
    expect(ride.legs.some((l) => l.kind === 'return')).toBe(false);
  });

  it('keeps the ride inside the distance the rider set, and says what it dropped', () => {
    const marks = [mark('A', 400, 'forward'), mark('C', 400, 'forward')];
    const tight = buildShootRide(marks, scan, opts({ targetKm: 2 }))!;
    expect(tight.km).toBeLessThanOrEqual(2);
    expect(tight.shots.length).toBeLessThan(2);
    expect(tight.dropped.some((d) => d.reason === 'budget')).toBe(true);
  });

  it('takes shots in shortlist order — the ride matches the list, not the geography', () => {
    // Both fit, but only one at a time. The FIRST-ranked mark is the one that must survive.
    const first = mark('A', 400, 'forward');
    const second = mark('C', 400, 'forward');
    const ride = buildShootRide([first, second], scan, opts({ targetKm: 2 }))!;
    expect(ride.shots[0].mark.id).toBe(first.id);
    expect(ride.dropped[0].mark.id).toBe(second.id);
  });

  it('schedules arrivals in riding order, at the planning speed', () => {
    const ride = buildShootRide(
      [mark('A', 400, 'forward'), mark('C', 400, 'forward')],
      scan,
      opts(),
    )!;
    expect(ride.shots[0].at.getTime()).toBeLessThan(ride.shots[1].at.getTime());
    expect(ride.shots[0].at.getTime()).toBeGreaterThanOrEqual(DEPART.getTime());
    expect(ride.shots.map((s) => s.order)).toEqual([1, 2]);
    // Distance and clock are the same quantity twice; they may not disagree by more than a Date can
    // represent. `finish` is built by adding milliseconds to a Date, which truncates, so the two
    // agree to within one — asking for more precision tests the clock's resolution, not the ride.
    expect(Math.abs(ride.finish.getTime() - ride.depart.getTime() - ride.minutes * 60_000)).toBeLessThan(1);
  });

  it('flags a shot the rider would reach after the light has gone', () => {
    const dusk = { ...WINDOW, end: new Date(DEPART.getTime() + 1000) };
    const ride = buildShootRide([mark('A', 400, 'forward')], scan, opts({ window: dusk }))!;
    expect(ride.shots[0].light).toBe('late');
  });

  it('reports a mark on a road the corpus does not have, rather than dropping it silently', () => {
    const orphan = mark('A', 400, 'forward');
    (orphan as { roadId: string }).roadId = 'NOPE';
    const ride = buildShootRide([mark('C', 400, 'forward'), orphan], scan, opts())!;
    expect(ride.dropped.find((d) => d.mark.id === orphan.id)?.reason).toBe('unreachable');
  });

  it('caps the shots in one ride and names the cap rather than truncating quietly', () => {
    // More candidates than MAX_SHOTS, all on the same block so all are reachable and cheap.
    const many = Array.from({ length: MAX_SHOTS + 4 }, (_, i) =>
      mark(SQUARE[i % 4].id, 200 + (i % 2) * 400, 'forward'),
    ).map((m, i) => ({ ...m, id: `m${i}` }) as ReelMark);
    const ride = buildShootRide(many, scan, opts({ targetKm: 500 }))!;
    expect(ride.shots.length).toBeLessThanOrEqual(MAX_SHOTS);
    expect(ride.shots.length + ride.dropped.length).toBe(many.length);
  });

  it('returns null rather than an empty ride when there is nothing to work with', () => {
    expect(buildShootRide([], scan, opts())).toBeNull();
    expect(buildShootRide([mark('A', 400, 'forward')], { ...scan, corpus: [] } as AreaScan, opts())).toBeNull();
  });
});
