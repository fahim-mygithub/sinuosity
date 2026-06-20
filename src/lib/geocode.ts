import type { LatLng } from './geometry';

/**
 * Keyless forward/reverse geocoding via OpenStreetMap's Nominatim service — consistent with
 * the rest of the stack (Overpass for roads, OSRM for snapping), so the address search works
 * on localhost AND the deployed Pages domain without a Google key or referrer restriction.
 *
 * Nominatim's usage policy asks for ≤1 request/second and no bulk use; the search box only
 * queries on submit (not per keystroke), which keeps us well inside that. Results are biased
 * toward the WNY/Ontario riding region but not restricted to it — you can scan anywhere.
 */

export interface GeoResult {
  /** Short, human label for the list row (e.g. "Ellicottville, Cattaraugus County"). */
  label: string;
  /** Full Nominatim display string, used as the title/tooltip. */
  fullLabel: string;
  lat: number;
  lon: number;
  /** OSM feature class (e.g. "place", "highway") — for an optional icon. */
  kind?: string;
}

export class GeocodeError extends Error {
  constructor(message: string, public kind: 'network' | 'http' | 'empty' | 'timeout') {
    super(message);
    this.name = 'GeocodeError';
  }
}

const NOMINATIM = 'https://nominatim.openstreetmap.org';
// WNY + Niagara/Ontario bias box (min_lon, min_lat, max_lon, max_lat) — matches the project's
// scenic belt. `bounded=0` makes this a preference, not a hard filter.
const VIEWBOX = '-79.85,41.99,-77.25,43.40';

/** Build a concise label from Nominatim's address parts, falling back to the display string. */
export function shortLabel(el: {
  display_name?: string;
  name?: string;
  address?: Record<string, string>;
}): string {
  const a = el.address ?? {};
  const dnParts = (el.display_name ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const primary =
    el.name || a.road || a.hamlet || a.village || a.town || a.city || a.county || dnParts[0] || '';
  // First structured locality that isn't just a repeat of the primary name…
  const structured = [a.city, a.town, a.village, a.hamlet, a.county, a.state].find(
    (l) => l && l !== primary,
  );
  // …otherwise borrow the next meaningful part of the display string (skip country / postcodes).
  const locality =
    structured ||
    dnParts.find(
      (p) => p !== primary && p !== 'United States' && p !== 'USA' && p !== 'Canada' && !/^\d{3,}/.test(p),
    );
  if (primary && locality) return `${primary}, ${locality}`;
  return primary || el.display_name || 'Unknown place';
}

interface NominatimRow {
  lat: string;
  lon: string;
  display_name?: string;
  name?: string;
  class?: string;
  address?: Record<string, string>;
}

function toResult(row: NominatimRow): GeoResult | null {
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    label: shortLabel(row),
    fullLabel: row.display_name ?? shortLabel(row),
    lat,
    lon,
    kind: row.class,
  };
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal,
      headers: { Accept: 'application/json', 'Accept-Language': 'en' },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new GeocodeError('Search timed out', 'timeout');
    throw new GeocodeError('Network request failed', 'network');
  }
  if (!res.ok) throw new GeocodeError(`Geocoder returned ${res.status}`, 'http');
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) throw new GeocodeError('Geocoder returned a non-JSON response', 'http');
  return res.json();
}

/**
 * Forward-geocode a free-text place/address to ranked candidates (best first). Throws a
 * {@link GeocodeError} on transport failure; returns `[]` for a valid-but-empty result.
 */
export async function geocode(query: string, signal?: AbortSignal, limit = 5): Promise<GeoResult[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    addressdetails: '1',
    limit: String(limit),
    countrycodes: 'us,ca',
    viewbox: VIEWBOX,
    bounded: '0',
  });
  const data = await getJson(`${NOMINATIM}/search?${params.toString()}`, signal);
  if (!Array.isArray(data)) return [];
  return (data as NominatimRow[]).map(toResult).filter((r): r is GeoResult => r !== null);
}

/** Reverse-geocode a coordinate to a single labelled place (e.g. for "use my location"). */
export async function reverseGeocode(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<GeoResult | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: 'jsonv2',
    addressdetails: '1',
    zoom: '14',
  });
  const data = await getJson(`${NOMINATIM}/reverse?${params.toString()}`, signal);
  if (!data || typeof data !== 'object' || 'error' in (data as object)) {
    // Reverse lookups can legitimately find nothing (mid-lake, etc.) — return the raw coord.
    return { label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, fullLabel: 'Dropped pin', lat, lon };
  }
  return toResult(data as NominatimRow);
}

/** Convenience: a GeoResult's coordinate as the app's [lat, lon] tuple. */
export const toLatLng = (r: GeoResult): LatLng => [r.lat, r.lon];
