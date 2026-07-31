import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { scanAreaFromTiles, inCoverage, TileMissError, tileCountFor } from './tileSource';
import { fetchAreaScan } from './areaSource';
import { tileKey, tilesForBounds } from './tileCodec';
import { clearAreaCache } from './overpass';

const WNY: [number, number] = [42.75, -78.25]; // inside tile t_85_-157
const REAL_TILE_PATH = 'public/tiles/t_85_-157.json';

afterEach(() => {
  vi.unstubAllGlobals();
  clearAreaCache();
});

/** Serve the committed spike tile for the key it belongs to; 404 every other key. */
function stubTiles(body?: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (body !== undefined && url.includes(tileKey(85, -157))) {
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
      }
      if (body === undefined && url.includes(tileKey(85, -157)) && existsSync(REAL_TILE_PATH)) {
        return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(REAL_TILE_PATH, 'utf8')) } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }),
  );
}

describe('inCoverage', () => {
  it('accepts NY and rejects outside the built grid', () => {
    expect(inCoverage(WNY)).toBe(true);
    expect(inCoverage([44.9, -74.0])).toBe(true);
    expect(inCoverage([34.05, -118.24])).toBe(false); // Los Angeles
    expect(inCoverage([45.5, -73.6])).toBe(false); // Montreal — north of the grid
  });
});

describe('tile count', () => {
  it('keeps a max-radius scan to a handful of tiles', () => {
    const n = tileCountFor(WNY, 30);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(12);
  });
});

describe('scanAreaFromTiles', () => {
  it('treats a 404 as an empty neighbour, not a failure', async () => {
    // The scan bbox routinely overhangs the coverage edge; those tiles legitimately do not exist.
    stubTiles();
    if (!existsSync(REAL_TILE_PATH)) return; // corpus not built in this checkout
    const scan = await scanAreaFromTiles(WNY, 30);
    expect(scan.corpus.length).toBeGreaterThan(0);
    expect(tilesForBounds(WNY[0], WNY[1], 30).length).toBeGreaterThan(1); // several were 404s
  });

  it('throws TileMissError when every tile is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
    await expect(scanAreaFromTiles(WNY, 30)).rejects.toBeInstanceOf(TileMissError);
  });

  it('throws TileMissError on a non-404 HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response));
    await expect(scanAreaFromTiles(WNY, 30)).rejects.toBeInstanceOf(TileMissError);
  });

  it('produces the AreaScan shape the Overpass path produces', async () => {
    stubTiles();
    if (!existsSync(REAL_TILE_PATH)) return;
    const scan = await scanAreaFromTiles(WNY, 30);

    expect(scan.center).toEqual(WNY);
    expect(scan.radiusKm).toBe(30);
    expect(Array.isArray(scan.corpus)).toBe(true);
    expect(scan.catalog.tells).toHaveProperty('waterPts');
    expect(scan.catalog.tells).toHaveProperty('greenAreas');
    expect(Array.isArray(scan.catalog.pois)).toBe(true);

    for (const r of scan.roads) {
      expect(r.id).toMatch(/^scan-\d+$/); // same identity shape as parseRoads()
      expect(r.coords.length).toBeGreaterThan(3);
      expect(r.rubric.curvature).toBeGreaterThanOrEqual(0);
      expect(r.rubric).toHaveProperty('scenery');
      expect(r.rubric).toHaveProperty('greenery');
      expect(r.rubric).toHaveProperty('water');
      expect(r.rubric).toHaveProperty('notability');
    }
    // Weighted tells must survive the parallel-array encoding with their weights intact.
    for (const w of scan.catalog.tells.waterPts.slice(0, 50)) {
      expect(Number.isFinite(w.pt[0])).toBe(true);
      expect(w.w).toBeGreaterThan(0);
    }
  });

  it('caps candidates AFTER merging tiles, and only keeps roads touching the radius', async () => {
    stubTiles();
    if (!existsSync(REAL_TILE_PATH)) return;
    const wide = await scanAreaFromTiles(WNY, 30);
    expect(wide.roads.length).toBeLessThanOrEqual(300);

    // A tiny radius over the same tiles must keep strictly fewer roads — proof the radius filter
    // runs, rather than the whole tile being handed back regardless of scan size.
    const tight = await scanAreaFromTiles(WNY, 3);
    expect(tight.corpus.length).toBeLessThan(wide.corpus.length);
  });

  it('rejects a malformed tile rather than returning junk geometry', async () => {
    stubTiles({ v: 1, bbox: [0, 0, 1, 1] }); // no roads/tells/pois
    await expect(scanAreaFromTiles(WNY, 30)).rejects.toBeTruthy();
  });
});

describe('fetchAreaScan fallback', () => {
  it('uses Overpass when the centre is outside coverage', async () => {
    const overpassBody = { elements: [] };
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => overpassBody,
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { source } = await fetchAreaScan([34.05, -118.24], 20);
    expect(source).toBe('overpass');
    expect(fetchMock.mock.calls.some((c) => String((c as unknown[])[0]).includes('interpreter'))).toBe(true);
  });

  it('falls back to Overpass when the tile corpus fails inside coverage', async () => {
    let overpassHit = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/tiles/')) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      overpassHit = true;
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ elements: [] }),
      } as unknown as Response;
    }));

    const { source } = await fetchAreaScan(WNY, 20);
    expect(source).toBe('overpass');
    expect(overpassHit).toBe(true);
  });

  it('propagates an abort instead of silently starting a slow Overpass query', async () => {
    const ctl = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      ctl.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }));
    await expect(fetchAreaScan(WNY, 20, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
