import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { scanAreaFromTiles } from './tileSource';
import { buildMarks } from './reelScore';
import { chainContext, chainRide, nextSteps, appendShot, unroutedGaps, type Chain } from './reelRoute';
import type { AreaScan } from './overpass';
import type { ReelMark } from './reelTypes';

/**
 * A PROBE over the real committed tile corpus, not a synthetic unit test.
 *
 * It exists because the thing that went wrong here could not be seen from a test fixture. Chaining
 * shots by hand originally treated the scanned network as authoritative: an arrow it could not route
 * to was dimmed and refused the tap. Every unit test passed, because a four-road square block is
 * perfectly connected. The real corpus is not — it carries secondary, tertiary and unclassified ways
 * but none of the residential streets that join them — and the measurement below is what that costs.
 *
 * Fast (~2 s) and offline: the tiles are committed, and the reader's `fetch` is pointed at disk.
 */

const PENDLETON: [number, number] = [43.09, -78.75];
const AT = new Date('2026-08-03T20:23:00');
const NO_LIGHT = { start: AT, end: AT, minutes: 0, rideKm: 0, golden: null, kind: 'evening' as const, usable: true };

let scan: AreaScan;
let marks: ReelMark[];

beforeAll(async () => {
  // The tile reader fetches static files; under Node those are just files on disk.
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const name = String(url).replace(/^.*\/tiles\//, '');
    try {
      const body = await readFile(resolve(process.cwd(), 'public/tiles', name), 'utf8');
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }) as typeof fetch;

  scan = await scanAreaFromTiles(PENDLETON, 30);
  marks = buildMarks(scan, { at: AT, aim: 'side' });
}, 120_000);

describe('chaining over the real corpus', () => {
  it('lets every arrow follow every other one, however islanded the scan is', () => {
    const ctx = chainContext(marks, scan)!;
    expect(ctx.geom.size).toBe(marks.length);

    const routable: number[] = [];
    for (const anchor of marks) {
      const chain = appendShot([], anchor, nextSteps(ctx, [], marks).get(anchor.id))!;
      const steps = nextSteps(ctx, chain, marks);
      const others = [...steps].filter(([id]) => id !== anchor.id);

      // THE CLAIM. Every other arrow is available to tap next — that is what "the corpus does not
      // get a veto" means, and it has to hold from EVERY anchor, including the worst one.
      expect(others.filter(([, s]) => !s.chained), `nothing can follow ${anchor.roadName}`).toHaveLength(
        marks.length - 1,
      );
      routable.push(others.filter(([, s]) => s.routed).length);
    }

    routable.sort((a, b) => a - b);
    const pct = (n: number) => Math.round((n / (marks.length - 1)) * 100);
    const med = routable[routable.length >> 1];
    console.log(
      `[probe] ${marks.length} marks over ${scan.corpus.length} corpus ways · ROAD-routable from an ` +
        `anchor: min ${routable[0]} (${pct(routable[0])}%), median ${med} (${pct(med)}%), ` +
        `max ${routable[routable.length - 1]} (${pct(routable[routable.length - 1])}%). ` +
        `Those were the only arrows the old build let the rider tap.`,
    );
  });

  it('routes what it can and draws the rest straight, in one ride', () => {
    const ctx = chainContext(marks, scan)!;
    const anchor = marks[0];
    let chain: Chain = appendShot([], anchor, nextSteps(ctx, [], marks).get(anchor.id))!;

    // One road-routable follower and one the network cannot reach, so a single ride holds both.
    const steps = nextSteps(ctx, chain, marks);
    const routed = marks.find((m) => m.id !== anchor.id && steps.get(m.id)?.routed);
    const stranded = marks.find((m) => steps.get(m.id)?.routed === false);
    expect(routed, 'no routable follower — the junction graph joined nothing').toBeDefined();

    chain = appendShot(chain, routed!, steps.get(routed!.id))!;
    // A corpus wide enough to route everything would be an improvement, not a failure: take the gap
    // leg out of the expectations rather than reporting green code as broken.
    if (stranded) chain = appendShot(chain, stranded, nextSteps(ctx, chain, marks).get(stranded.id))!;

    const ride = chainRide(ctx, chain, { from: PENDLETON, loop: false, departAt: AT, window: NO_LIGHT })!;
    const kinds = ride.legs.map((l) => l.kind);
    expect(kinds.filter((k) => k === 'shot')).toHaveLength(chain.length);
    expect(kinds).toContain('connector');

    // Every leg starts exactly where the last one ended — a gap is a straight line, not a teleport.
    for (let i = 1; i < ride.legs.length; i++) {
      const prev = ride.legs[i - 1].coords;
      expect(prev[prev.length - 1]).toEqual(ride.legs[i].coords[0]);
    }

    const gaps = unroutedGaps(ride);
    expect(gaps.count).toBe(stranded ? 1 : 0);
    if (stranded) {
      expect(kinds).toContain('gap');
      expect(gaps.km).toBeGreaterThan(0);
      expect(gaps.km).toBeLessThan(ride.km);
    }
    console.log(
      `[probe] mixed ride: ${ride.km.toFixed(1)} km, of which ${gaps.km.toFixed(1)} km across ` +
        `${gaps.count} straight-line hop(s) · legs = ${kinds.join(' → ')}`,
    );
  });
});
