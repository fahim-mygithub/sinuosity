import type { LatLng } from './geometry';

/**
 * Google Maps Platform imagery helpers. The API key is read from the client env
 * (`VITE_GOOGLE_MAPS_KEY`) at runtime and is NEVER baked into the committed dataset —
 * routes store only coordinates + headings, and the signed image URLs are constructed
 * here in the browser. Restrict the key to your Pages domain via HTTP-referrer
 * restrictions in the Google Cloud console.
 *
 * Every builder returns `null` when no key is configured so the UI can fall back to a
 * labelled placeholder plus the keyless "Open in Street View" deep-link (which always works).
 */

const KEY = (import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined)?.trim() || '';

export function hasGoogleKey(): boolean {
  return KEY.length > 0;
}

/** Street View Static thumbnail facing `heading`. Returns null without a key. */
export function streetViewStaticUrl(
  lat: number,
  lon: number,
  heading: number,
  opts: { size?: string; fov?: number; pitch?: number } = {},
): string | null {
  if (!KEY) return null;
  if (![lat, lon, heading].every(Number.isFinite)) return null;
  const params = new URLSearchParams({
    size: opts.size ?? '640x360',
    location: `${lat},${lon}`,
    heading: String(Math.round(heading)),
    pitch: String(opts.pitch ?? 2),
    fov: String(opts.fov ?? 82),
    source: 'outdoor',
    key: KEY,
  });
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}

/** Evenly downsample a polyline to at most `max` points (keeps URLs short). */
function downsample(coords: LatLng[], max: number): LatLng[] {
  if (coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1);
  const out: LatLng[] = [];
  for (let i = 0; i < max; i++) out.push(coords[Math.round(i * step)]);
  return out;
}

/**
 * Static satellite hero image with the route drawn as an emerald path overlay.
 * Returns null without a key.
 */
export function staticRouteSatelliteUrl(
  coords: LatLng[],
  opts: { size?: string; maptype?: 'satellite' | 'hybrid' | 'terrain' } = {},
): string | null {
  if (!KEY) return null;
  const valid = coords.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (valid.length === 0) return null;
  const pts = downsample(valid, 60);
  const path = 'weight:4|color:0x34d399ff|' + pts.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join('|');
  const params = new URLSearchParams({
    size: opts.size ?? '640x360',
    maptype: opts.maptype ?? 'hybrid',
    scale: '2',
    key: KEY,
  });
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}&path=${encodeURIComponent(path)}`;
}

/**
 * Keyless deep-link that opens Google Maps Street View at a point + heading.
 * Always works (no key required) — used as the primary CTA and the no-key fallback.
 */
export function streetViewDeepLink(lat: number, lon: number, heading: number): string {
  const params = new URLSearchParams({
    api: '1',
    map_action: 'pano',
    viewpoint: `${lat},${lon}`,
    heading: String(Number.isFinite(heading) ? Math.round(heading) : 0),
    pitch: '0',
  });
  return `https://www.google.com/maps/@?${params.toString()}`;
}
