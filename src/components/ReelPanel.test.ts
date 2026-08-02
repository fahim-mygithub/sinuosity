import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  MARK_SIDE_COLOR,
  REEL_REBUILD_DEBOUNCE_MS,
  dayAnchor,
  holdInstant,
  instantFrom,
  markColor,
  peakInstant,
  reelPool,
  reelShortlist,
  refinementGaps,
  toDateInput,
  toTimeInput,
} from './ReelPanel';
import { buildMarks, reelComposite, type ReelOptions } from '../lib/reelScore';
import { RESAMPLE_M, WINDOW_M, type ReelMark, type ReelMetrics } from '../lib/reelTypes';
import { WATER_SIZE, type WeightedTell } from '../lib/sceneryTells';
import type { LatLng } from '../lib/geometry';
import type { AreaScan } from '../lib/overpass';
import type { ScoredRoad } from '../data/types';
import type { ShootWindow } from '../lib/reelPlan';

// The wall-clock arithmetic is the one part of the Reel wiring that can be wrong without ever
// looking wrong: a mis-parsed input still produces a plausible evening, a plausible sun angle and a
// plausible list, scored for a time nobody asked for. These assert against facts anybody can
// rederive — an ISO string with no offset is local time, local noon is 12:00 on the rider's clock,
// and a half-typed date is not a time at all — never against what the parser happens to return.
//
// They also cover the helpers that used to be trapped inside App.tsx. App imports Leaflet, which
// touches `document` at module scope, so nothing that lives there can be reached by a test in a node
// environment; that is why `instantFrom` shipped with a fallback to "now" and no coverage.

describe('instantFrom', () => {
  it('reads a complete pair as the rider\'s own local wall clock', () => {
    const d = instantFrom('2026-08-15', '20:15');
    expect(d).not.toBeNull();
    // Asserted through the LOCAL accessors, because local is what the spec says an offsetless
    // `yyyy-mm-ddTHH:mm` means and local is what a rider means by "quarter past eight".
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(7); // August
    expect(d!.getDate()).toBe(15);
    expect(d!.getHours()).toBe(20);
    expect(d!.getMinutes()).toBe(15);
  });

  it('treats a missing time as local midnight of that date, not as invalid', () => {
    // `<input type="time">` can be empty while the date is complete, and midnight of the named day
    // is a real instant the rider can be shown. Only the DATE half is load-bearing.
    const d = instantFrom('2026-08-15', '');
    expect(d).not.toBeNull();
    expect(d!.getDate()).toBe(15);
    expect(d!.getHours()).toBe(0);
    expect(d!.getMinutes()).toBe(0);
  });

  it('returns null for the empty date an `<input type="date">` emits mid-edit', () => {
    // THE BUG. `new Date('T20:15')` is Invalid, and this used to answer `new Date()` — so a
    // transient empty value became a distinct instant, cleared the rebuild debounce on its own and
    // fired a DEM batch scored for whatever o'clock it happened to be.
    expect(instantFrom('', '20:15')).toBeNull();
    expect(instantFrom('', '')).toBeNull();
  });

  it('returns null for a partially typed date or time rather than substituting now', () => {
    expect(instantFrom('2026-', '20:15')).toBeNull();
    expect(instantFrom('not-a-date', '20:15')).toBeNull();
    expect(instantFrom('2026-08-15', '2')).toBeNull();
    expect(instantFrom('2026-08-15', 'xx:15')).toBeNull();
    expect(instantFrom('2026-8-5', '20:15')).toBeNull();
  });

  it('refuses the prefixes V8\'s legacy parser silently invents a day for', () => {
    // Measured on node 22, 2026-08-02: where the ISO grammar does not match, `new Date` falls back
    // to a lenient parser that answers a real, plausible, WRONG instant —
    //   '2026-08T20:15' -> Aug 1 20:15, '2026T20:15' -> Jan 1 20:15.
    // A NaN check alone therefore does not close the finding; it just moves the invented instant
    // from "now" to "the first of something".
    expect(instantFrom('2026-08', '20:15')).toBeNull();
    expect(instantFrom('2026', '20:15')).toBeNull();
  });

  it('refuses a day that does not exist rather than rolling it into the next month', () => {
    // '2026-02-31T20:15' parses, to March 3rd. February has 28 days in 2026, so the only honest
    // answer is that this is not a date. Ranges that fail the ISO grammar outright are covered too.
    expect(instantFrom('2026-02-31', '20:15')).toBeNull();
    expect(instantFrom('2026-13-40', '20:15')).toBeNull();
  });

  it('answers only with instants that round-trip to the day that was typed', () => {
    for (const date of ['2026-01-31', '2026-02-28', '2026-03-08', '2026-11-01', '2026-12-31']) {
      const at = instantFrom(date, '20:15')!;
      expect(at).not.toBeNull();
      expect(toDateInput(at)).toBe(date);
      expect(Number.isNaN(at.getTime())).toBe(false);
    }
  });
});

describe('holdInstant', () => {
  const prev = new Date(2026, 7, 15, 20, 15);

  it('advances to the instant the rider names', () => {
    const next = holdInstant(prev, '2026-08-16', '19:30');
    expect(next).not.toBe(prev);
    expect(next.getDate()).toBe(16);
    expect(next.getHours()).toBe(19);
  });

  it('holds the previous instant BY IDENTITY through an incomplete input', () => {
    // Identity, not equality, is the fix: App keys the debounced rebuild on `reelAt.getTime()` and
    // memoises `reelOpts` on the Date itself, so an equal-but-new Date would still rebuild. A
    // half-typed date must cost nothing at all.
    expect(holdInstant(prev, '', '20:15')).toBe(prev);
    expect(holdInstant(prev, '2026-08', '20:15')).toBe(prev);
    expect(holdInstant(prev, '', '')).toBe(prev);
  });

  it('never lets an incomplete input drift towards now', () => {
    // The old behaviour: each keystroke that emptied the date scored the whole list at `new Date()`.
    const held = holdInstant(prev, '', '20:15');
    expect(held.getTime()).toBe(prev.getTime());
    expect(Math.abs(held.getTime() - Date.now())).toBeGreaterThan(1000);
  });

  it('is stable across a whole mid-edit sequence', () => {
    // What a rider actually produces while retyping a date: a run of values that are each Invalid,
    // a plausible-but-wrong prefix, and then nothing again. Not one of them may move the instant.
    let at = prev;
    for (const pair of [['', '20:1'], ['', '20:15'], ['2026', '20:15'], ['2026-08', '20:15'], ['', '20:15']] as const) {
      at = holdInstant(at, pair[0], pair[1]);
    }
    expect(at).toBe(prev);
  });
});

describe('dayAnchor', () => {
  it('is local noon of the instant\'s own day', () => {
    const anchor = dayAnchor(new Date(2026, 7, 15, 20, 15));
    expect(anchor.getFullYear()).toBe(2026);
    expect(anchor.getMonth()).toBe(7);
    expect(anchor.getDate()).toBe(15);
    expect(anchor.getHours()).toBe(12);
    expect(anchor.getMinutes()).toBe(0);
  });

  it('keeps an evening instant on its own UTC day for every offset in (-12, +12)', () => {
    // The reason it is noon and not the shoot instant: `shootWindow` picks a day by its UTC date, so
    // 8 pm in New York is already tomorrow in UTC and would ask for the wrong evening. Noon is the
    // instant furthest from both UTC midnights, so it survives any offset a rider can be at.
    const anchor = dayAnchor(new Date(2026, 7, 15, 23, 45));
    const offsetHours = -anchor.getTimezoneOffset() / 60;
    expect(Math.abs(offsetHours)).toBeLessThan(12);
    expect(anchor.getUTCDate()).toBe(new Date(2026, 7, 15, 12).getUTCDate());
  });

  it('anchors both ends of a day onto the same noon', () => {
    const early = dayAnchor(new Date(2026, 7, 15, 0, 1));
    const late = dayAnchor(new Date(2026, 7, 15, 23, 59));
    expect(early.getTime()).toBe(late.getTime());
  });
});

describe('peakInstant', () => {
  const win = (start: Date, end: Date, golden: { start: Date; end: Date } | null): ShootWindow =>
    ({ start, end, minutes: 0, rideKm: 0, golden, kind: 'evening', usable: true }) as ShootWindow;

  it('is the middle of the golden band when there is one', () => {
    const peak = peakInstant(
      win(new Date(2026, 7, 15, 18, 0), new Date(2026, 7, 15, 21, 0), {
        start: new Date(2026, 7, 15, 19, 0),
        end: new Date(2026, 7, 15, 20, 0),
      }),
    );
    // The middle of the BAND, not of the wider usable stretch — 19:30, not 19:30-of-18:00-to-21:00.
    expect(peak.getTime()).toBe(new Date(2026, 7, 15, 19, 30).getTime());
  });

  it('falls back to the middle of the usable stretch when the band never opens', () => {
    // A real case rather than a failure: at 63N the sun crosses neither -4 in June nor +6 in
    // December, and there are still usable evenings at both.
    const peak = peakInstant(win(new Date(2026, 7, 15, 18, 0), new Date(2026, 7, 15, 21, 0), null));
    expect(peak.getTime()).toBe(new Date(2026, 7, 15, 19, 30).getTime());
  });
});

describe('toDateInput / toTimeInput', () => {
  it('round-trips a local instant through the two input values', () => {
    const at = new Date(2026, 0, 5, 7, 4);
    expect(toDateInput(at)).toBe('2026-01-05');
    expect(toTimeInput(at)).toBe('07:04');
    expect(instantFrom(toDateInput(at), toTimeInput(at))!.getTime()).toBe(at.getTime());
  });

  it('pads every field to the width the inputs require', () => {
    // An unpadded month or minute is not merely ugly — `2026-1-5T7:4` does not parse, so the round
    // trip would land back on the "hold the last good instant" path forever.
    expect(toDateInput(new Date(2026, 8, 9, 0, 0))).toBe('2026-09-09');
    expect(toTimeInput(new Date(2026, 8, 9, 0, 0))).toBe('00:00');
    expect(instantFrom('2026-09-09', '00:00')).not.toBeNull();
  });
});

describe('REEL_REBUILD_DEBOUNCE_MS', () => {
  it('is long enough to absorb a stepped input and short enough to stay a control', () => {
    // `buildMarks` is measured at 262-314 ms on the main thread for a real 30 km scan, so anything
    // under about two of those is not absorbing anything; past ~1 s the control stops feeling
    // connected to the input. The old 350 was inside the work it was supposed to debounce.
    expect(REEL_REBUILD_DEBOUNCE_MS).toBeGreaterThanOrEqual(600);
    expect(REEL_REBUILD_DEBOUNCE_MS).toBeLessThanOrEqual(1000);
  });

  it('cannot on its own bound Open-Meteo requests, which is why the cache has to', () => {
    // The arithmetic that must not be forgotten: 429 was measured at ~10-15 requests in 2 minutes,
    // and 120 s of settling at this interval still permits an order of magnitude more rebuilds than
    // that. No debounce a rider would tolerate closes the gap — reelTerrain's window-id cache does.
    expect(120_000 / REEL_REBUILD_DEBOUNCE_MS).toBeGreaterThan(15);
  });
});

// --- refinement gaps ----------------------------------------------------------------------------

/** A mark carrying only the two fields the degradation notice reads. */
const markWith = (fall: object | null, provisional: boolean): ReelMark =>
  ({
    backdrop: { left: { fall }, right: { fall } },
    clean: { provisional },
  }) as unknown as ReelMark;

const READ_FALL = { fallM: 12.3, atM: 400, riseM: 0 };

describe('refinementGaps', () => {
  it('says nothing while the refinement is still in flight', () => {
    // Nothing has failed yet, and the spinner already says what is happening.
    expect(refinementGaps([markWith(null, true)], true)).toEqual([]);
  });

  it('says nothing once both halves have landed', () => {
    expect(refinementGaps([markWith(READ_FALL, false)], false)).toEqual([]);
  });

  it('reports a dead DEM, which the built-up flag alone could never see', () => {
    // THE BUG. `clean.provisional` covers the built-up query only. With it landed and the DEM dead,
    // the panel used to be completely silent while `backdrop` — 0.40 of the composite — rested on
    // open water alone, so a gorge road with no lake beside it read as flat and nothing said so.
    const gaps = refinementGaps([markWith(null, false)], false);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(/ground-relief lookup did not land/);
  });

  it('reports a dead built-up query on its own', () => {
    const gaps = refinementGaps([markWith(READ_FALL, true)], false);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(/built-up count did not land/);
  });

  it('reports both when both failed, terrain first', () => {
    // They are awaited together and degrade independently, so both failing is one outcome of four —
    // and terrain leads because it is the heavier loss.
    const gaps = refinementGaps([markWith(null, true)], false);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatch(/ground-relief/);
    expect(gaps[1]).toMatch(/built-up/);
  });

  it('says nothing when there are no marks to probe', () => {
    expect(refinementGaps([], false)).toEqual([]);
  });

  it('probes the top mark, which is the only one guaranteed inside both budgets', () => {
    // `DEFAULT_MARK_LIMIT` is defined as `MAX_PROBE_WINDOWS`, so every mark in a shortlist is in
    // budget — but a caller passing its own larger limit would leave a tail with no terrain reading
    // by design. Reading the tail would report that truncation as a failure.
    const marks = [markWith(READ_FALL, false), markWith(null, true)];
    expect(refinementGaps(marks, false)).toEqual([]);
  });
});

describe('the shortlist list does not render a score', () => {
  const src = readFileSync(new URL('./ReelPanel.tsx', import.meta.url), 'utf8');

  it('has no interpolation of a mark composite in a row', () => {
    // A source assertion, deliberately: the finding is about what is PAINTED, there is no DOM in
    // this test environment, and a 0-100 composite in the Scan tab's emerald badge is exactly the
    // "match %" ShootCard's header forbids. A shortlist's composites span 11-20 points somewhere
    // between 64 and 94, under invented weights over a kappa = 0.53 ground truth, so the digits
    // carried the order and nothing else — and the `#n` on the left already says the order exactly.
    expect(src).not.toMatch(/\{\s*m\.score\s*\}/);
  });

  it('does not justify that with the 87-100 spread, which no measurement produced', () => {
    // FIX 4. Measured across ten (instant x aim) combinations: 70-85, 65-77, 71-85, 74-90, 64-75,
    // 74-94. The conclusion holds; the number quoted for it never did.
    expect(src).not.toMatch(/87-100/);
    expect(src).toMatch(/between 64 and 94/);
  });
});

// ------------------------------------------------------------------------------------------------
// Fixtures for the two wiring contracts below. Deliberately the same shapes reelScore's own suite
// uses: a projection on haversine's sphere so "150 m east" measures 150 m under the metric the
// implementation uses, and lakes laid out against the water BANDS rather than at a round number.
// ------------------------------------------------------------------------------------------------

const M_PER_DEG = (6371 * 1000 * Math.PI) / 180;

function projector(lat0: number, lon0: number) {
  const lonScale = Math.cos((lat0 * Math.PI) / 180);
  return (eastM: number, northM: number): LatLng => [
    lat0 + northM / M_PER_DEG,
    lon0 + eastM / (M_PER_DEG * lonScale),
  ];
}

const BUFFALO = projector(42.9, -78.85);
/** Solar noon at Buffalo on the June solstice. The tests below need only "which half-plane is the
 *  sun in", never a precise instant. */
const NOON = new Date('2026-06-21T17:15:00Z');

/** 150 m: inside three of the four water bands, ~50 m clear of either boundary, so no assertion
 *  here is balanced on a band edge. */
const LAKE_OFFSET_M = 150;

function makeRoad(id: string, name: string, coords: LatLng[]): ScoredRoad {
  return {
    id,
    name,
    curveDensity: 0,
    sinuosity: 0,
    score: 0,
    coords,
    rubric: { curvature: 0, scenery: 0, greenery: 0, water: 0, notability: 0 },
  };
}

function makeScan(roads: ScoredRoad[], waterPts: WeightedTell[] = []): AreaScan {
  return {
    roads,
    catalog: {
      tells: {
        waterPts,
        waterAreas: [],
        greenAreas: [],
        greenPts: [],
        uglyAreas: [],
        uglyPts: [],
        view: [],
        peak: [],
        notable: [],
      },
      pois: [],
    },
    center: roads[0].coords[0],
    radiusKm: 30,
    corpus: roads,
  };
}

/** A due-north road of `WINDOW_M` starting at (eastM, 0) — stored order is south to north. */
const northRoad = (eastM: number): LatLng[] => [BUFFALO(eastM, 0), BUFFALO(eastM, WINDOW_M)];

/** Open-water tells beside a north road. A positive offset is EAST of it, i.e. on the right of a
 *  rider heading north and on the left of one heading south. */
function lakeBeside(roadEastM: number, offsetM: number): WeightedTell[] {
  const out: WeightedTell[] = [];
  for (let n = 0; n <= WINDOW_M; n += RESAMPLE_M) {
    out.push({ pt: BUFFALO(roadEastM + offsetM, n), w: WATER_SIZE.lake });
  }
  return out;
}

/** A switchback pair: 90 deg of turning at every vertex, so it saturates drama outright. */
const zig = (eastM: number): LatLng[] => [
  BUFFALO(eastM, 0), BUFFALO(eastM + 70, 70), BUFFALO(eastM, 140), BUFFALO(eastM + 70, 210),
  BUFFALO(eastM, 280), BUFFALO(eastM + 70, 350), BUFFALO(eastM, 420),
];

// --- FIX 1: a weight change re-SELECTS, it does not re-sort --------------------------------------

describe('reelShortlist — the panel weights select, they do not merely re-order', () => {
  // Two roads worth looking at only for their backdrop and two worth looking at only for their
  // corners, far enough apart that nothing suppresses anything. With a limit of two, the default
  // weights keep the water pair and drama-only weights keep the switchback pair — so the two
  // settings disagree about WHICH marks exist, not merely about their order. Without that, the
  // equality below would hold for a re-sort as well and would prove nothing.
  const roads = [
    makeRoad('scan-1', 'Shore A', northRoad(0)),
    makeRoad('scan-2', 'Shore B', northRoad(4000)),
    makeRoad('scan-3', 'Switchback A', zig(8000)),
    makeRoad('scan-4', 'Switchback B', zig(12000)),
  ];
  const scan = (): AreaScan =>
    makeScan(roads, [...lakeBeside(0, LAKE_OFFSET_M), ...lakeBeside(4000, LAKE_OFFSET_M)]);

  const dramaOnly: ReelMetrics = { backdrop: 0, cleanliness: 0, light: 0, drama: 1 };
  const A = (): ReelOptions => ({ at: NOON, aim: 'side', limit: 2 });
  const B = (): ReelOptions => ({ at: NOON, aim: 'side', limit: 2, weights: dramaOnly });

  const shape = (ms: ReelMark[]) =>
    ms.map((m) => ({ id: m.id, direction: m.direction, score: m.score, metrics: m.metrics }));

  it('picks a genuinely different pair of marks under the two weight settings', () => {
    expect(buildMarks(scan(), A()).map((m) => m.roadId)).toEqual(['scan-1', 'scan-2']);
    expect(buildMarks(scan(), B()).map((m) => m.roadId).sort()).toEqual(['scan-3', 'scan-4']);
  });

  it('selects under B from a pool scored under A exactly as it would have built under B', () => {
    // THE FIX, at the level it shipped broken. reelScore proves this equality of its own two
    // functions; this proves that the pair App actually calls is that pair. The pool has to carry
    // every window and both directions of each, because `pickDirection` starts with the composite
    // and the composite is weight-dependent.
    const pool = reelPool(scan(), A());
    expect(shape(reelShortlist(pool, B()))).toEqual(shape(buildMarks(scan(), B())));
    expect(shape(reelShortlist(pool, A()))).toEqual(shape(buildMarks(scan(), A())));
  });

  it('and re-scoring the shortlist — what App used to do — does NOT', () => {
    // THE TEETH. App.tsx held `reelMarks` as the SELECTED shortlist and applied the sliders with
    // `.map(m => ({...m, score: reelComposite(m.metrics, w)})).sort()`, over a rebuild effect whose
    // dependency list did not contain the weights at all. Dragging drama to 1 therefore re-sorted 40
    // marks the backdrop weights had already chosen: measured on the real corpus, 37 of the 40
    // correct marks were unreachable, and the panel's top-5 drama read 10, 10, 10, 8.6, 6.5 against
    // a true 10, 10, 10, 10, 10.
    const stale = buildMarks(scan(), A())
      .map((m) => ({ ...m, score: reelComposite(m.metrics, dramaOnly) }))
      .sort((a, b) => b.score - a.score);
    const correct = buildMarks(scan(), B());

    expect(stale.map((m) => m.roadId)).not.toEqual(correct.map((m) => m.roadId));
    expect(Math.max(...stale.map((m) => m.metrics.drama))).toBeLessThan(
      Math.max(...correct.map((m) => m.metrics.drama)),
    );
    // …and the seam App now calls gets it right on the same pool.
    expect(reelShortlist(reelPool(scan(), A()), B()).map((m) => m.roadId).sort())
      .toEqual(correct.map((m) => m.roadId).sort());
  });

  it('holds the pool weight-independently, so re-selecting never rescores a window', () => {
    // The property that makes this affordable: the pool is a function of the scan, the instant and
    // the aim only. Measured on a real 30 km scan, 300 ms to build against 12-14 ms to re-select.
    expect(shape(reelPool(scan(), A()))).toEqual(shape(reelPool(scan(), A())));
    const under = (o: ReelOptions) =>
      reelPool(scan(), o).map((m) => `${m.id}:${m.direction}:${JSON.stringify(m.metrics)}`);
    expect(under(A())).toEqual(under(B()));
  });
});

describe('App wires the panel to that seam and to nothing else', () => {
  // A source assertion on App.tsx, from here, because App.tsx can have no test file of its own: it
  // imports Leaflet at module scope, which touches `document` on load. That is not incidental — it
  // is why an untested `.map(reelComposite).sort()` sat in the render path for a whole wave.
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

  it('never calls reelComposite', () => {
    expect(app).not.toMatch(/reelComposite\(/);
  });

  it('goes through reelPool and reelShortlist instead', () => {
    expect(app).toMatch(/reelPool\(scan, opts\)/);
    expect(app).toMatch(/reelShortlist\(pool, opts\)/);
  });

  it('re-selects when the weights change', () => {
    // The other half of the defect: the rebuild effect was keyed on `[reelAt.getTime(), reelAim]`
    // and nothing at all responded to the weights.
    expect(app).toMatch(/\}, \[reelWeights, applyReelPool\]\)/);
  });
});

// --- FIX 2: no emitted mark has its backdrop on the left ----------------------------------------

describe('the emitted side is always right, so the palette has no third colour', () => {
  const shoreRight = () => makeScan([makeRoad('scan-1', 'Shore', northRoad(0))], lakeBeside(0, LAKE_OFFSET_M));
  const shoreLeft = () => makeScan([makeRoad('scan-1', 'Shore', northRoad(0))], lakeBeside(0, -LAKE_OFFSET_M));
  const opts = (): ReelOptions => ({ at: NOON, aim: 'side' });

  it('turns a window round rather than emitting a left-hand backdrop', () => {
    // THE INVARIANT the UI removal rests on. The same road, the same lake, moved from the east verge
    // to the west one: forward the backdrop is on the LEFT, and `pickDirection`'s second step emits
    // the reverse direction instead, which puts that same lake on the right. Measured on the real
    // corpus this is not a corner case — 221 of 1,417 windows have their better verge on the left
    // going forward, and zero marks come back as `left` across ten (instant x aim) combinations.
    const [right] = buildMarks(shoreRight(), opts());
    const [left] = buildMarks(shoreLeft(), opts());

    expect(right.backdropSide).toBe('right');
    expect(left.backdropSide).toBe('right');
    // Same window, opposite ways round the road — that is the whole mechanism.
    expect(left.direction).not.toBe(right.direction);
    expect(Math.abs(left.travelBearingDeg - right.travelBearingDeg)).toBeCloseTo(180, 6);
  });

  it('has no left swatch to select', () => {
    expect(Object.keys(MARK_SIDE_COLOR).sort()).toEqual(['none', 'right']);
    expect(MARK_SIDE_COLOR).not.toHaveProperty('left');
  });

  it('colours a backdrop mark emerald and a viewless one slate, and has no third answer', () => {
    const mark = (backdropSide: ReelMark['backdropSide']) => ({ backdropSide }) as ReelMark;
    expect(markColor(mark('right'))).toBe(MARK_SIDE_COLOR.right);
    expect(markColor(mark(null))).toBe(MARK_SIDE_COLOR.none);
    // A `left` mark would be a bug in `pickDirection`, not a colour this palette has to describe —
    // so it renders as "not the case the palette is about" rather than as an expected fourth state.
    expect(markColor(mark('left'))).toBe(MARK_SIDE_COLOR.none);
  });

  it('drops the legend that told the rider about it', () => {
    const src = readFileSync(new URL('./ReelPanel.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/amber = on your left/);
    expect(src).toMatch(/backdropSide === 'left'/); // the invariant, stated where the branch was
  });
});
