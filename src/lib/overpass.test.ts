import { describe, it, expect, vi, afterEach } from 'vitest';
import { scanRoads, dedupeByName, OverpassError } from './overpass';
import type { ScannedRoad } from '../data/types';

const HOME: [number, number] = [42.9808, -78.7441];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => 'application/json; charset=utf-8' },
    json: async () => body,
  } as unknown as Response;
}

// A way that genuinely zig-zags, so its measured sinuosity clears a low threshold.
const ZIGZAG_WAY = {
  type: 'way',
  id: 1,
  tags: { name: 'Twisty Hollow Rd' },
  geometry: [
    { lat: 42.5, lon: -78.6 }, { lat: 42.52, lon: -78.58 }, { lat: 42.51, lon: -78.55 },
    { lat: 42.53, lon: -78.53 }, { lat: 42.52, lon: -78.5 }, { lat: 42.54, lon: -78.48 },
  ],
};

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('scanRoads error handling', () => {
  it('throws timeout when Overpass returns HTTP 200 + a runtime-error remark', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 27 seconds.' }),
    );
    await expect(scanRoads(HOME, 10, 0.3)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('returns [] (not an error) for a genuine empty result with no remark', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ elements: [] }));
    await expect(scanRoads(HOME, 10, 0.3)).resolves.toEqual([]);
  });

  it('throws http after all mirrors return non-ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}, false, 504));
    await expect(scanRoads(HOME, 10, 0.3)).rejects.toMatchObject({ kind: 'http' });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3); // tried every mirror
  });

  it('throws network when every mirror fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(scanRoads(HOME, 10, 0.3)).rejects.toMatchObject({ kind: 'network' });
  });

  it('throws timeout immediately on a caller abort (does not retry mirrors)', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    globalThis.fetch = vi.fn().mockRejectedValue(abortErr);
    await expect(scanRoads(HOME, 10, 0.3)).rejects.toMatchObject({ kind: 'timeout' });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('abandons a stalled mirror after the per-mirror timeout and fails over to the next', async () => {
    vi.useFakeTimers();
    let calls = 0;
    globalThis.fetch = vi.fn((_url: string, opts: { signal: AbortSignal }) => {
      calls++;
      if (calls === 1) {
        // First mirror stalls: it only settles if/when its signal is aborted.
        return new Promise<Response>((_resolve, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      }
      // Second mirror answers fine.
      return Promise.resolve(jsonResponse({ elements: [ZIGZAG_WAY] }));
    }) as typeof fetch;

    const p = scanRoads(HOME, 10, 0.1);
    await vi.advanceTimersByTimeAsync(8000); // trip the per-mirror timeout on mirror #1
    const roads = await p;
    expect(calls).toBe(2); // failed over, did not give up
    expect(roads).toHaveLength(1);
    expect(roads[0].name).toBe('Twisty Hollow Rd');
  });

  it('is an OverpassError with a usable message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ elements: [], remark: 'rate_limited' }));
    const err = await scanRoads(HOME, 10, 0.3).catch((e) => e);
    expect(err).toBeInstanceOf(OverpassError);
  });
});

describe('scanRoads geometry handling', () => {
  it('parses inline geometry, scores curvature, and skips ways with <=3 points', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        elements: [
          ZIGZAG_WAY,
          { type: 'way', id: 2, tags: { name: 'Stub' }, geometry: [{ lat: 42.5, lon: -78.6 }, { lat: 42.51, lon: -78.6 }, { lat: 42.52, lon: -78.6 }] },
        ],
      }),
    );
    const roads = await scanRoads(HOME, 10, 0.1);
    expect(roads).toHaveLength(1);
    expect(roads[0].name).toBe('Twisty Hollow Rd');
    expect(roads[0].coords.length).toBe(6);
    expect(roads[0].score).toBeGreaterThan(0);
  });

  it('filters out roads below the minSinuosity threshold', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ elements: [ZIGZAG_WAY] }));
    const roads = await scanRoads(HOME, 10, 99); // impossibly high threshold
    expect(roads).toEqual([]);
  });
});

describe('dedupeByName', () => {
  const mk = (name: string, score: number, id: string): ScannedRoad => ({
    id, name, curveDensity: score / 30, sinuosity: 5, score, coords: [[42, -78], [42.1, -78.1]],
  });

  it('keeps only the highest-scoring row per named road', () => {
    const deduped = dedupeByName([mk('Main St', 40, 'a'), mk('Main St', 70, 'b'), mk('Oak Rd', 55, 'c')]);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((r) => r.name === 'Main St')!.score).toBe(70);
  });

  it('never merges distinct unnamed roads together', () => {
    const deduped = dedupeByName([mk('Unnamed road', 60, 'a'), mk('Unnamed road', 50, 'b')]);
    expect(deduped).toHaveLength(2);
  });

  it('returns rows sorted by score descending', () => {
    const deduped = dedupeByName([mk('A', 30, '1'), mk('B', 90, '2'), mk('C', 60, '3')]);
    expect(deduped.map((r) => r.score)).toEqual([90, 60, 30]);
  });
});
