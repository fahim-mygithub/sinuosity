import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildBuiltUpQuery,
  countBuiltWays,
  builtDensityNear,
  fetchBuiltIndex,
  clearBuiltCache,
} from './reelTells';
import { buildTellsQuery } from './features';
import { overpassSettings, SERVER_TIMEOUT_S, MAXSIZE_FEATURES_MIB, type OverpassElement } from './overpass';
import { FULL_BUILT_DENSITY } from './reelTypes';

// These tests check ARITHMETIC and KNOWN GEOMETRY, not what the implementation happens to return.
// A lattice of spacing S has exactly 1e6/S² points per km² by construction, a point placed 300 m
// away is 300 m away whatever the code thinks, and a disc of radius r has area pi*r². Every density
// expectation below comes from one of those three facts.
//
// The query tests are the regression guard for the catch-all bug documented at the top of
// reelTells.ts: if any tag key that `categorizeFeatures` switches on ever appears in this query,
// somebody has started down the road that silently rescores every Scenic, Curated and Scan result.

const C: [number, number] = [42.9, -78.85]; // the app's home region

/** One degree of latitude in metres on the sphere geometry.ts's haversine uses (R = 6371 km). */
const M_PER_DEG_LAT = (6371000 * Math.PI) / 180;
const dLat = (m: number) => m / M_PER_DEG_LAT;
const dLon = (m: number) => m / (M_PER_DEG_LAT * Math.cos((C[0] * Math.PI) / 180));

let nextId = 1;
beforeEach(() => {
  nextId = 1;
  clearBuiltCache();
});
afterEach(() => vi.restoreAllMocks());

/**
 * A three-vertex way whose MIDDLE vertex sits exactly on `at`, so a test that places ways at known
 * distances is testing the density maths rather than the choice of representative vertex.
 */
function wayAt(at: [number, number]): OverpassElement {
  const e = dLat(8); // ~8 m of leg either side — a short street block
  return {
    type: 'way',
    id: nextId++,
    geometry: [
      { lat: at[0] - e, lon: at[1] },
      { lat: at[0], lon: at[1] },
      { lat: at[0] + e, lon: at[1] },
    ],
  };
}

/** A way whose middle vertex is `metres` from C on a bearing of `deg`. */
function wayAtOffset(metres: number, deg: number): OverpassElement {
  const th = (deg * Math.PI) / 180;
  return wayAt([C[0] + dLat(metres * Math.cos(th)), C[1] + dLon(metres * Math.sin(th))]);
}

/** A square lattice of ways at `spacingM`, covering +/- `halfExtentM` around C. */
function lattice(spacingM: number, halfExtentM: number): OverpassElement[] {
  const n = Math.floor(halfExtentM / spacingM);
  const out: OverpassElement[] = [];
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      out.push(wayAt([C[0] + dLat(i * spacingM), C[1] + dLon(j * spacingM)]));
    }
  }
  return out;
}

/** Ways per km² of a lattice, from first principles: one way per spacing² of ground. */
const latticeDensity = (spacingM: number) => 1e6 / spacingM ** 2;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => 'application/json; charset=utf-8' },
    json: async () => body,
  } as unknown as Response;
}

describe('buildBuiltUpQuery — the separate-query guarantee', () => {
  const q = buildBuiltUpQuery(C, 8000);

  it('selects residential and service ways and nothing else', () => {
    expect(q).toContain('way["highway"~"^(residential|service)$"]');
    expect(q).toContain('(around:8000,42.9,-78.85)');
    // One selector, one output statement. Anything more has grown a second feature class.
    expect(q.match(/\(around:/g)).toHaveLength(1);
  });

  it('names no tag key that categorizeFeatures switches on', () => {
    // Pull the keys straight out of the shared tells query rather than hard-coding a list, so a new
    // feature class added there is automatically covered here.
    const tellKeys = new Set(
      [...buildTellsQuery(C, 8000).matchAll(/\["([a-z_]+)"/g)].map((m) => m[1]),
    );
    expect(tellKeys.size).toBeGreaterThan(4); // the regex found real keys, not nothing
    for (const key of tellKeys) expect(q).not.toContain(`["${key}"`);
  });

  it('touches neither landuse nor building — the two measured-and-rejected alternatives', () => {
    expect(q).not.toContain('landuse');
    expect(q).not.toContain('building');
  });

  it('asks for ids + geometry, never tags', () => {
    // Positions and a count are the whole job; a tag block on the densest class in OSM is waste.
    expect(q.trimEnd().endsWith('out ids geom;')).toBe(true);
    expect(q).not.toContain('out body');
    expect(q).not.toContain('out tags');
  });

  it('uses the shared overpassSettings prefix rather than its own literal', () => {
    // Drift between the two is what previously left a query with a too-tight budget that blew
    // during `print`, after the payload had already been gathered and downloaded.
    expect(q.startsWith(overpassSettings(MAXSIZE_FEATURES_MIB) + ';')).toBe(true);
    expect(q).toContain(`[timeout:${SERVER_TIMEOUT_S}]`);
  });
});

describe('countBuiltWays', () => {
  it('counts one point per way and ignores non-way elements', () => {
    const index = countBuiltWays([
      wayAt(C),
      { type: 'node', id: 900, lat: C[0], lon: C[1] },
      { type: 'relation', id: 901, members: [{ geometry: [{ lat: C[0], lon: C[1] }] }] },
      wayAtOffset(100, 0),
    ]);
    expect(index.pts).toHaveLength(2);
  });

  it('ignores ways with no usable geometry', () => {
    const index = countBuiltWays([
      { type: 'way', id: 1 }, // `out ids` with no geom, or a truncated response
      { type: 'way', id: 2, geometry: [] },
      { type: 'way', id: 3, geometry: [{ lat: NaN, lon: NaN }] },
      wayAt(C),
    ]);
    expect(index.pts).toHaveLength(1);
  });

  it('places each way at one of its own vertices', () => {
    // The representative point must lie ON the way; a fabricated position would move a density.
    const w = wayAt(C);
    const [pt] = countBuiltWays([w]).pts;
    expect(w.geometry!.some((g) => g.lat === pt[0] && g.lon === pt[1])).toBe(true);
  });

  it('is unaffected by how finely a way is traced', () => {
    // Two ways over the same ground, one with 3 vertices and one with 41, are two streets — not
    // 3 and 41 units of suburbia. Counting vertices would measure the mapper, not the place.
    const coarse = wayAt(C);
    const fine: OverpassElement = {
      type: 'way',
      id: 500,
      geometry: Array.from({ length: 41 }, (_, k) => ({ lat: C[0] + dLat(k - 20), lon: C[1] })),
    };
    expect(countBuiltWays([coarse]).pts).toHaveLength(1);
    expect(countBuiltWays([fine]).pts).toHaveLength(1);
  });
});

describe('builtDensityNear — counting', () => {
  it('counts exactly what is inside the radius', () => {
    // 12 ways on a 100 m circle, 7 on a 300 m circle. A 200 m query sees exactly the 12.
    const els = [
      ...Array.from({ length: 12 }, (_, k) => wayAtOffset(100, k * 30)),
      ...Array.from({ length: 7 }, (_, k) => wayAtOffset(300, k * 51)),
    ];
    const index = countBuiltWays(els);
    expect(builtDensityNear(index, C, 200)).toBeCloseTo(12 / (Math.PI * 0.2 ** 2), 6);
    expect(builtDensityNear(index, C, 500)).toBeCloseTo(19 / (Math.PI * 0.5 ** 2), 6);
  });

  it('falls to zero once everything is outside the radius', () => {
    const index = countBuiltWays(Array.from({ length: 8 }, (_, k) => wayAtOffset(500, k * 45)));
    expect(builtDensityNear(index, C, 200)).toBe(0);
    expect(builtDensityNear(index, C, 400)).toBe(0);
    expect(builtDensityNear(index, C, 600)).toBeGreaterThan(0); // they were there all along
  });

  it('counts exactly through the grid path too, not only the linear one', () => {
    // Above the grid threshold: 600 ways clustered inside 40 m, plus 600 more ~5 km away that no
    // 200 m query may ever see. The swept cell window must contain the disc and nothing extra.
    const near = Array.from({ length: 600 }, (_, k) => wayAtOffset(40, k * 0.6));
    const far = Array.from({ length: 600 }, (_, k) => wayAtOffset(5000, k * 0.6));
    const index = countBuiltWays([...near, ...far]);
    expect(index.pts).toHaveLength(1200);
    expect(builtDensityNear(index, C, 200)).toBeCloseTo(600 / (Math.PI * 0.2 ** 2), 6);
  });

  it('counts the disc, not the box that bounds it — on both the linear and the grid path', () => {
    // 48 ways on a 900 m circle: a count known before the code runs, and the ONLY ways inside a 1 km
    // query. The decoys sit at 1.1–1.4 km on the DIAGONALS — outside the disc but inside the square
    // that bounds it, so they land in the swept cell window and are rejected only by the exact
    // haversine test. That is the test that would disappear if the cell window were ever trusted on
    // its own, and this is the ring of ground where the two disagree.
    //
    // They also carry the index from 48 ways to 748, i.e. across the grid threshold, so the same
    // count has to come back from the linear scan and from the ring of swept cells.
    const inside = Array.from({ length: 48 }, (_, k) => wayAtOffset(900, k * 7.5));
    const corners = Array.from({ length: 700 }, (_, k) =>
      wayAtOffset(1100 + (k % 4) * 100, 45 + (k % 4) * 90 + (k % 7)));
    const expected = 48 / (Math.PI * 1 ** 2);

    expect(countBuiltWays(inside).cells.size).toBe(0); // linear path
    expect(builtDensityNear(countBuiltWays(inside), C, 1000)).toBeCloseTo(expected, 9);

    const withCorners = countBuiltWays([...inside, ...corners]);
    expect(withCorners.cells.size).toBeGreaterThan(0); // grid path
    expect(withCorners.pts).toHaveLength(748); // the decoys really are in the index
    expect(builtDensityNear(withCorners, C, 1000)).toBeCloseTo(expected, 9);
  });

  it('returns 0 for an empty index and for a non-positive radius', () => {
    expect(builtDensityNear(countBuiltWays([]), C, 400)).toBe(0);
    expect(builtDensityNear(countBuiltWays([wayAt(C)]), C, 0)).toBe(0);
  });
});

describe('builtDensityNear — normalisation to ways per km²', () => {
  it('divides by the true disc area', () => {
    // A lattice of spacing S holds exactly 1e6/S² ways per km². Sampled with a disc of radius R the
    // count is short or long by at most the ring of cells the circle cuts, i.e. ~S/R relative — 5%
    // here — so the tolerance below is the sampling error, not slack for the implementation.
    const index = countBuiltWays(lattice(50, 1400));
    const measured = builtDensityNear(index, C, 1000);
    expect(measured).toBeGreaterThan(latticeDensity(50) * 0.94);
    expect(measured).toBeLessThan(latticeDensity(50) * 1.06);
  });

  it('is a density, not a count: quadrupling the area with the same ways quarters it', () => {
    // Every way is inside both discs, so the only thing that changes is pi*r².
    const index = countBuiltWays(Array.from({ length: 9 }, (_, k) => wayAtOffset(30, k * 40)));
    expect(builtDensityNear(index, C, 400)).toBeCloseTo(builtDensityNear(index, C, 200) / 4, 9);
  });

  it('reads the same density however the same ways are arranged inside the disc', () => {
    // A density is a count over an area, so WHERE 60 ways sit inside the disc cannot change it. The
    // three arrangements are the ones that would break a distance-weighted or cell-sampled
    // implementation: a knot at the centre, a ring just inside the rim, and a spiral that fills the
    // disc. All three are 60 ways in the same pi*0.5² km².
    const knot = Array.from({ length: 60 }, (_, k) => wayAtOffset(20 + (k % 5), k * 6));
    const rim = Array.from({ length: 60 }, (_, k) => wayAtOffset(480, k * 6));
    const spiral = Array.from({ length: 60 }, (_, k) => wayAtOffset(40 + k * 7, k * 47));
    const expected = 60 / (Math.PI * 0.5 ** 2);
    for (const arrangement of [knot, rim, spiral]) {
      expect(builtDensityNear(countBuiltWays(arrangement), C, 500)).toBeCloseTo(expected, 9);
    }
  });

  it('reads the same density at any radius on a uniform lattice', () => {
    // The definitional property of a density. A raw count would have grown 4x between these.
    const index = countBuiltWays(lattice(40, 1600));
    const near = builtDensityNear(index, C, 600);
    const far = builtDensityNear(index, C, 1200);
    expect(far).toBeGreaterThan(near * 0.9);
    expect(far).toBeLessThan(near * 1.1);
  });
});

describe('builtDensityNear — against FULL_BUILT_DENSITY', () => {
  // The measured field separation is 20.6x (1888 ways at suburban Amherst against 54 out at rural
  // Zoar Valley). These two lattices reproduce that separation and straddle the saturation constant.
  //
  // Both spacings are derived from the one field measurement that has an AREA attached — 1,888 ways
  // in 12.6 km² = 150 ways/km² — and not from the raw counts. That distinction is the whole point:
  // the counts were taken over a 2 km disc, so treating 1888 and 54 as if they were already
  // densities is a 12.57x unit error, and it is exactly the error that used to sit in
  // FULL_BUILT_DENSITY (600 counts, read as 600 ways/km²). A lattice spaced to a count would
  // reproduce the error here and quietly agree with it.
  //
  // So: suburban is the measured 150 ways/km², rural is that over the measured 20.6x separation,
  // and each spacing is sqrt(1e6 / density) by construction.
  //
  // Every assertion below therefore compares a lattice against something OUTSIDE the lattice — the
  // saturation constant, or the other lattice. There is deliberately no "build a lattice of spacing
  // sqrt(A/n), read back n/A" test: a lattice of that spacing has that density by construction, so
  // such a test is arithmetic asserting itself and would pass against a `builtDensityNear` that had
  // been broken in any way the two errors cancelled. The units are pinned instead by the two tests
  // above, which use counts and areas known independently of any spacing.
  const SUBURBAN_DENSITY = 1888 / 12.6; // 149.8 ways/km², suburban Amherst, measured
  const RURAL_DENSITY = SUBURBAN_DENSITY / 20.6; // 7.3 ways/km², rural Zoar Valley
  const SUBURBAN_SPACING = Math.sqrt(1e6 / SUBURBAN_DENSITY); // 81.7 m
  const RURAL_SPACING = Math.sqrt(1e6 / RURAL_DENSITY); // 370.7 m

  it('puts real suburban density above the saturation point', () => {
    // The load-bearing assertion of the whole calibration: the DENSEST place anyone has measured
    // has to be able to saturate the penalty, or `cleanliness` — defined as the inverse of
    // suburbia — scores suburbia several points above zero and the dimension does nothing. At the
    // old constant of 600 this read 150 > 600 and was false.
    const index = countBuiltWays(lattice(SUBURBAN_SPACING, 1300));
    expect(builtDensityNear(index, C, 1000)).toBeGreaterThan(FULL_BUILT_DENSITY);
  });

  it('puts a sparse rural network well below it', () => {
    const index = countBuiltWays(lattice(RURAL_SPACING, 1300));
    const rural = builtDensityNear(index, C, 1000);
    expect(rural).toBeLessThan(FULL_BUILT_DENSITY / 5);
    expect(rural).toBeGreaterThan(0); // rural is not empty — it must still rank against other rural
  });

  it('preserves the measured 20.6x separation between the two', () => {
    const suburban = builtDensityNear(countBuiltWays(lattice(SUBURBAN_SPACING, 1300)), C, 1000);
    const rural = builtDensityNear(countBuiltWays(lattice(RURAL_SPACING, 1300)), C, 1000);
    expect(suburban / rural).toBeGreaterThan(17);
    expect(suburban / rural).toBeLessThan(25);
  });
});

describe('fetchBuiltIndex', () => {
  it('sends exactly the query buildBuiltUpQuery produced', () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ elements: [wayAt(C)] }));
    globalThis.fetch = fetchMock as typeof fetch;
    return fetchBuiltIndex(C, 8).then(() => {
      const body = (fetchMock.mock.calls[0][1] as { body: string }).body;
      expect(body).toBe('data=' + encodeURIComponent(buildBuiltUpQuery(C, 8000)));
    });
  });

  it('caches per center+radius and does not re-query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ elements: [wayAt(C), wayAtOffset(100, 0)] }));
    globalThis.fetch = fetchMock as typeof fetch;

    const first = await fetchBuiltIndex(C, 8);
    const second = await fetchBuiltIndex(C, 8);
    expect(first!.pts).toHaveLength(2);
    expect(second).toBe(first);
    expect(fetchMock.mock.calls).toHaveLength(1);

    await fetchBuiltIndex(C, 12); // a different radius is a different area
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it('returns null instead of throwing when every mirror fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as typeof fetch;
    // Throwing here would break a ranking that the free junction proxy could have carried.
    await expect(fetchBuiltIndex(C, 8)).resolves.toBeNull();
  });

  it('returns null on an Overpass runtime-timeout remark', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 45 seconds.' }),
    ) as typeof fetch;
    await expect(fetchBuiltIndex(C, 8)).resolves.toBeNull();
  });

  it('does not cache a failure — a loaded mirror must not disable an area for the session', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as typeof fetch;
    expect(await fetchBuiltIndex(C, 8)).toBeNull();

    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ elements: [wayAt(C)] })) as typeof fetch;
    expect((await fetchBuiltIndex(C, 8))!.pts).toHaveLength(1);
  });

  it('treats a genuinely empty area as a real result, not a failure', async () => {
    // Deep rural really does return almost nothing, and 0 ways/km² is the correct answer there.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ elements: [] }));
    globalThis.fetch = fetchMock as typeof fetch;

    const index = await fetchBuiltIndex(C, 8);
    expect(index).not.toBeNull();
    expect(builtDensityNear(index!, C, 400)).toBe(0);

    await fetchBuiltIndex(C, 8);
    expect(fetchMock.mock.calls).toHaveLength(1); // cached, unlike a failure
  });
});
