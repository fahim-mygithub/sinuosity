import { describe, it, expect, vi, afterEach } from 'vitest';
import { geocode, reverseGeocode, shortLabel, toLatLng, GeocodeError } from './geocode';

function mockFetch(impl: (url: string) => { ok?: boolean; json?: unknown; contentType?: string }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const r = impl(url);
    return {
      ok: r.ok ?? true,
      headers: { get: () => r.contentType ?? 'application/json' },
      json: async () => r.json,
    } as unknown as Response;
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('shortLabel', () => {
  it('builds "name, locality" from address parts', () => {
    expect(
      shortLabel({ name: 'Ellicottville', address: { village: 'Ellicottville', county: 'Cattaraugus County' } }),
    ).toBe('Ellicottville, Cattaraugus County');
  });

  it('does not repeat the locality when it equals the primary', () => {
    expect(shortLabel({ name: 'Buffalo', address: { city: 'Buffalo' } })).toBe('Buffalo');
  });

  it('falls back to display_name parts when there is no structured address', () => {
    expect(shortLabel({ display_name: 'Foo Road, Bar, NY, USA' })).toBe('Foo Road, Bar');
  });
});

describe('geocode', () => {
  it('returns [] for an empty query without calling fetch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await geocode('   ')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('parses Nominatim rows into GeoResult[] and biases to the WNY viewbox', async () => {
    let calledUrl = '';
    mockFetch((url) => {
      calledUrl = url;
      return {
        json: [
          { lat: '42.277', lon: '-78.673', display_name: 'Ellicottville, NY, USA', name: 'Ellicottville', class: 'place', address: { village: 'Ellicottville', county: 'Cattaraugus County' } },
        ],
      };
    });
    const out = await geocode('ellicottville');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ lat: 42.277, lon: -78.673, label: 'Ellicottville, Cattaraugus County', kind: 'place' });
    expect(toLatLng(out[0])).toEqual([42.277, -78.673]);
    expect(calledUrl).toContain('/search?');
    expect(calledUrl).toContain('viewbox=');
    expect(calledUrl).toContain('countrycodes=us%2Cca');
  });

  it('drops rows with non-finite coordinates', async () => {
    mockFetch(() => ({ json: [{ lat: 'NaN', lon: '-78', display_name: 'broken' }] }));
    expect(await geocode('x')).toEqual([]);
  });

  it('throws GeocodeError on an HTTP error', async () => {
    mockFetch(() => ({ ok: false, json: {} }));
    await expect(geocode('x')).rejects.toBeInstanceOf(GeocodeError);
  });

  it('maps an abort into a timeout GeocodeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }));
    await expect(geocode('x')).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('reverseGeocode', () => {
  it('returns a labelled place for a coordinate', async () => {
    mockFetch(() => ({ json: { lat: '43.0', lon: '-78.7', display_name: 'Somewhere, NY', name: 'Somewhere', address: { town: 'Somewhere' } } }));
    const r = await reverseGeocode(43, -78.7);
    expect(r).toMatchObject({ lat: 43, lon: -78.7, label: 'Somewhere, NY' });
  });

  it('falls back to a dropped-pin label when Nominatim returns an error object', async () => {
    mockFetch(() => ({ json: { error: 'Unable to geocode' } }));
    const r = await reverseGeocode(43.1234, -78.5678);
    expect(r).toMatchObject({ lat: 43.1234, lon: -78.5678, fullLabel: 'Dropped pin' });
  });
});
