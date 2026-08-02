import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { scanAreaFromTiles, inCoverage, TileMissError, tileCountFor, clearManifestCache } from './tileSource';
import { fetchAreaScan } from './areaSource';
import { tileKey, tilesForBounds, tilesForRadius, TILE_FORMAT_V } from './tileCodec';
import { clearAreaCache } from './overpass';

const WNY: [number, number] = [42.75, -78.25]; // inside tile t_85_-157
const REAL_TILE_PATH = 'public/tiles/t_85_-157.json';

afterEach(() => {
  vi.unstubAllGlobals();
  clearAreaCache();
  clearManifestCache(); // memoized per session — a leaked manifest would mask coverage failures
});

/**
 * Serve a manifest claiming every tile a 30km scan of WNY needs, plus the committed spike tile's
 * contents for all of them. The real corpus is built by a separate crawl, so tests must not depend
 * on which tiles happen to exist on disk.
 */
function stubTiles(body?: unknown, manifestTiles?: string[]) {
  const real = existsSync(REAL_TILE_PATH) ? JSON.parse(readFileSync(REAL_TILE_PATH, 'utf8')) : null;
  const tiles = manifestTiles ?? tilesForBounds(WNY[0], WNY[1], 30).map(([a, b]) => tileKey(a, b));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('manifest.json')) {
        return { ok: true, status: 200, json: async () => ({ v: 1, tileDeg: 0.5, marginKm: 12, tiles }) } as unknown as Response;
      }
      if (body !== undefined) return { ok: true, status: 200, json: async () => body } as unknown as Response;
      if (real) return { ok: true, status: 200, json: async () => real } as unknown as Response;
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }),
  );
  return real !== null;
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
  it('skips margin tiles the manifest does not list, without failing', async () => {
    // Margin tiles hold ways whose midpoints fall outside the radius; a missing one costs a few
    // edge roads, not the integrity of the scan.
    const required = tilesForRadius(WNY[0], WNY[1], 30).map(([a, b]) => tileKey(a, b));
    if (!stubTiles(undefined, required)) return; // corpus not built in this checkout
    // A manifest listing ONLY the required tiles must still produce a scan — the margin tiles it
    // omits are the best-effort ones.
    const scan = await scanAreaFromTiles(WNY, 30);
    expect(scan.corpus.length).toBeGreaterThan(0);
    expect(scan.roads.length).toBeGreaterThan(0);
  });

  it('refuses when a tile overlapping the scanned radius is absent', async () => {
    // This is the border case: dropping a required tile would return a plausible-looking scan
    // that is missing a whole sector of the circle, so it must fall back instead.
    const required = tilesForRadius(WNY[0], WNY[1], 30).map(([a, b]) => tileKey(a, b));
    stubTiles(undefined, required.slice(1));
    await expect(scanAreaFromTiles(WNY, 30)).rejects.toBeInstanceOf(TileMissError);
  });

  it('throws TileMissError when the manifest itself is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
    await expect(scanAreaFromTiles(WNY, 30)).rejects.toBeInstanceOf(TileMissError);
  });

  it('throws TileMissError when a listed tile fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('manifest.json')) {
        return {
          ok: true, status: 200,
          json: async () => ({ v: 1, tileDeg: 0.5, marginKm: 12, tiles: tilesForBounds(WNY[0], WNY[1], 30).map(([a, b]) => tileKey(a, b)) }),
        } as unknown as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }));
    await expect(scanAreaFromTiles(WNY, 30)).rejects.toBeInstanceOf(TileMissError);
  });

  it('produces the AreaScan shape the Overpass path produces', async () => {
    if (!stubTiles()) return; // corpus not built in this checkout
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

  it('measures gradeDrama, which is not baked into tiles', async () => {
    // Without this the tile path silently drops a whole rubric dimension the Overpass path has, so
    // the same road would rank differently depending on which source served the scan.
    const real = existsSync(REAL_TILE_PATH) ? JSON.parse(readFileSync(REAL_TILE_PATH, 'utf8')) : null;
    if (!real) return;
    let elevationHit = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('manifest.json')) {
        return {
          ok: true, status: 200,
          json: async () => ({ v: 1, tileDeg: 0.5, marginKm: 25, tiles: tilesForBounds(WNY[0], WNY[1], 30).map(([a, b]) => tileKey(a, b)) }),
        } as unknown as Response;
      }
      if (u.includes('open-meteo')) {
        elevationHit = true;
        const n = (new URL(u).searchParams.get('latitude') ?? '').split(',').length;
        return { ok: true, status: 200, json: async () => ({ elevation: Array.from({ length: n }, (_, i) => 300 + i * 7) }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => real } as unknown as Response;
    }));

    const scan = await scanAreaFromTiles(WNY, 30);
    expect(elevationHit).toBe(true);
    expect(scan.roads.some((r) => typeof r.rubric.gradeDrama === 'number')).toBe(true);
  });

  it('still returns a scan when the elevation lookup fails', async () => {
    const real = existsSync(REAL_TILE_PATH) ? JSON.parse(readFileSync(REAL_TILE_PATH, 'utf8')) : null;
    if (!real) return;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('manifest.json')) {
        return {
          ok: true, status: 200,
          json: async () => ({ v: 1, tileDeg: 0.5, marginKm: 25, tiles: tilesForBounds(WNY[0], WNY[1], 30).map(([a, b]) => tileKey(a, b)) }),
        } as unknown as Response;
      }
      if (u.includes('open-meteo')) return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
      return { ok: true, status: 200, json: async () => real } as unknown as Response;
    }));

    const scan = await scanAreaFromTiles(WNY, 30);
    expect(scan.roads.length).toBeGreaterThan(0); // degrades, does not fail
  });

  it('caps candidates AFTER merging tiles, and only keeps roads touching the radius', async () => {
    if (!stubTiles()) return; // corpus not built in this checkout
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

describe('wire format version guard', () => {
  /**
   * A structurally valid tile carrying nothing. Enough to prove the reader got past both version
   * checks, and it does not depend on the committed spike tile — a fresh checkout may not have one,
   * and a "does the current version load?" test that silently skips itself proves nothing.
   */
  function emptyTile(v: number) {
    return {
      v,
      bbox: [42.5, -78.5, 43.0, -78.0],
      roads: [] as unknown[],
      tells: {
        waterPts: { pts: [], w: [] }, waterAreas: [], greenAreas: [], greenPts: [],
        uglyAreas: [], uglyPts: [], view: [], peak: [], notable: { pts: [], w: [] },
      },
      pois: { pts: [], meta: [] },
    };
  }

  /**
   * What a tile from an older corpus looks like to the current reader once a field has moved:
   * `geom` is absent, so `decodePath(undefined)` reads `.length` off undefined. This exact payload
   * is the one the guard exists to never reach, and the control test below proves it really is
   * poison rather than something the decoder happens to tolerate.
   */
  function staleShapedTile(v: number) {
    return { ...emptyTile(v), roads: [{ id: 12345, name: 'Old Road', curveDensity: 0.5 }] };
  }

  function serve(manifest: Record<string, unknown>, tile: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('manifest.json')) {
          return { ok: true, status: 200, json: async () => manifest } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => tile } as unknown as Response;
      }),
    );
  }

  /** Every tile a 30km WNY scan requires, so coverage never confounds a version assertion. */
  function allTiles(): string[] {
    return tilesForBounds(WNY[0], WNY[1], 30).map(([a, b]) => tileKey(a, b));
  }

  /** Resolve to whatever the scan threw, so a test can assert on the TYPE and on the text. */
  async function failureOf(): Promise<Error> {
    try {
      await scanAreaFromTiles(WNY, 30);
    } catch (e) {
      return e as Error;
    }
    throw new Error('expected scanAreaFromTiles to reject, but it resolved');
  }

  it('accepts a manifest and tiles stamped with the version this build reads', async () => {
    // A guard that rejects everything would also "fix" the silent-fallback bug, and would make the
    // corpus permanently unreachable. The current version has to still load.
    serve({ v: TILE_FORMAT_V, tileDeg: 0.5, marginKm: 25, tiles: allTiles() }, emptyTile(TILE_FORMAT_V));
    const scan = await scanAreaFromTiles(WNY, 30);
    expect(scan.center).toEqual(WNY);
    expect(scan.radiusKm).toBe(30);
  });

  it('rejects a manifest with no version field, naming the version it expected', async () => {
    // The corpus predating the guard has no `v` in the shape the reader is looking for; treating
    // absent as "probably fine" is how the original bug got in.
    serve({ tileDeg: 0.5, marginKm: 25, tiles: allTiles() }, emptyTile(TILE_FORMAT_V));
    const err = await failureOf();
    expect(err).toBeInstanceOf(TileMissError);
    expect(err.message).toMatch(/manifest/);
    expect(err.message).toContain(`v${TILE_FORMAT_V}`);
  });

  it('rejects a manifest from another corpus version, naming both versions', async () => {
    // Diagnosable from a console log alone: the warn line in areaSource.ts prints only `.message`,
    // so a message that says "version mismatch" without the two numbers costs a debugging session.
    const stale = TILE_FORMAT_V + 1;
    serve({ v: stale, tileDeg: 0.5, marginKm: 25, tiles: allTiles() }, emptyTile(stale));
    const err = await failureOf();
    expect(err).toBeInstanceOf(TileMissError);
    expect(err.message).toContain(`v${stale}`);
    expect(err.message).toContain(`v${TILE_FORMAT_V}`);
  });

  it('control: a tile whose fields have moved really is undecodable', async () => {
    // Without this the regression test below could pass against a harmless payload and prove
    // nothing. Stamped with the CURRENT version so the guard waves it through to the decoder.
    serve(
      { v: TILE_FORMAT_V, tileDeg: 0.5, marginKm: 25, tiles: allTiles() },
      staleShapedTile(TILE_FORMAT_V),
    );
    const err = await failureOf();
    expect(err).toBeInstanceOf(TypeError); // decodePath(undefined)
  });

  it('rejects a stale tile on its VERSION rather than on the TypeError decoding it raises', async () => {
    // THE REGRESSION. Same payload as the control, one number different. A TypeError here is caught
    // by the blanket catch in fetchAreaScan and becomes a silent permanent fallback to Overpass:
    // every scan for the rest of the session takes ~25s instead of ~1s. Assert the TYPE, because
    // "it threw" is exactly what the buggy version did too.
    const stale = TILE_FORMAT_V + 1;
    serve({ v: TILE_FORMAT_V, tileDeg: 0.5, marginKm: 25, tiles: allTiles() }, staleShapedTile(stale));
    const err = await failureOf();
    expect(err).toBeInstanceOf(TileMissError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toMatch(/^tile t_-?\d+_-?\d+:/); // which tile, not just "a tile"
    expect(err.message).toContain(`v${stale}`);
    expect(err.message).toContain(`v${TILE_FORMAT_V}`);
  });

  it('checks the tile version independently of the manifest version', async () => {
    // Manifest and tiles are separate static files with separate cache lifetimes, so a browser can
    // hold a fresh manifest alongside a stale tile. A guard on the manifest alone would pass this.
    serve({ v: TILE_FORMAT_V, tileDeg: 0.5, marginKm: 25, tiles: allTiles() }, emptyTile(TILE_FORMAT_V + 1));
    await expect(scanAreaFromTiles(WNY, 30)).rejects.toBeInstanceOf(TileMissError);
  });
});

describe('the version the BUILDER stamps', () => {
  // The guard above only covers the reader. The writer fails symmetrically and worse: stamp a stale
  // version into a freshly built corpus and every tile is rejected, areaSource.ts's blanket catch
  // eats the TileMissError, and every scan in the app silently takes the ~25s Overpass path. Nothing
  // in the reader's own tests can see that, because to them a rejected tile IS the correct outcome.
  //
  // Node cannot import tileCodec.ts, so the constant is duplicated into the .mjs twin and these
  // tests are the whole coupling between the two files.

  /** Resolved from import.meta.url, not cwd — vitest's working directory is not guaranteed. */
  const buildTilesUrl = new URL('../../scripts/build-tiles.mjs', import.meta.url);

  it('matches the version the reader enforces', async () => {
    // Same method as the encoder-parity test in tileCodec.test.ts: import the module and compare the
    // EVALUATED export, so this holds however the constant comes to be written.
    const mjs = await import('../../scripts/lib/tile-codec.mjs');
    expect(mjs.TILE_FORMAT_V).toBe(TILE_FORMAT_V);
  });

  it('stamps tiles and the manifest from the shared constant, never a literal', () => {
    // Source inspection rather than execution: build-tiles.mjs is a top-level IIFE that would start
    // an Overpass crawl on import. Both stamps (the tile object and writeManifest) must read the
    // constant — a literal here is invisible until the day someone bumps the version, which is the
    // exact day it costs the most.
    const src = readFileSync(buildTilesUrl, 'utf8');
    const stamps = [...src.matchAll(/\bv:\s*([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
    expect(stamps).toHaveLength(2); // the tile, and the manifest
    for (const s of stamps) expect(s).toBe('TILE_FORMAT_V');
    expect(src).toMatch(/import\s*{[^}]*\bTILE_FORMAT_V\b[^}]*}\s*from\s*'\.\/lib\/tile-codec\.mjs'/);
  });
});

describe('the committed corpus', () => {
  const TILE_DIR = 'public/tiles';

  /**
   * Read the version out of a tile without parsing it. The corpus measured 116.8 MB across 82 tiles
   * on 2026-08-02, so parsing it in a unit test would cost seconds; `v` is the first key the builder
   * writes, so a 4 KB prefix always contains it. No other key in the wire format is `"v"` — `view`
   * and the weight arrays (`w`) do not collide.
   */
  function tileVersion(path: string): number | null {
    const head = readFileSync(path).subarray(0, 4096).toString('utf8');
    const m = /"v":\s*(\d+)/.exec(head);
    return m ? Number(m[1]) : null;
  }

  it('is stamped with the version this build reads', () => {
    if (!existsSync(REAL_TILE_PATH)) return; // corpus not built in this checkout
    const files = readdirSync(TILE_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
    expect(files.length).toBeGreaterThan(0);
    // Named, not counted: a stale tile has to be identifiable from the failure alone, because the
    // fix is to rebuild that tile.
    const wrong = files.filter((f) => tileVersion(`${TILE_DIR}/${f}`) !== TILE_FORMAT_V);
    expect(wrong).toEqual([]);

    const manifest = JSON.parse(readFileSync(`${TILE_DIR}/manifest.json`, 'utf8'));
    expect(manifest.v).toBe(TILE_FORMAT_V);
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
