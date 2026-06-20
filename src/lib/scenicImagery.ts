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

/**
 * Street View Static thumbnail facing `heading`. Returns null without a key.
 *
 * `return_error_code=true` makes a missing-pano location return HTTP 404 instead of a
 * silent gray "no imagery" tile (HTTP 200) — so the caller's <img> onError fires and the
 * designed kind-icon fallback shows, instead of a broken gray box in a shared screenshot.
 * `scale=2` matches the satellite hero's resolution so stop frames are crisp on retina.
 */
export function streetViewStaticUrl(
  lat: number,
  lon: number,
  heading: number,
  opts: { size?: string; fov?: number; pitch?: number } = {},
): string | null {
  if (!KEY) return null;
  if (![lat, lon, heading].every(Number.isFinite)) return null;
  const params = new URLSearchParams({
    size: opts.size ?? '640x400',
    location: `${lat},${lon}`,
    heading: String(Math.round(heading)),
    pitch: String(opts.pitch ?? 4),
    fov: String(opts.fov ?? 78),
    source: 'outdoor',
    scale: '2',
    return_error_code: 'true',
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

/** Encode a polyline with Google's algorithm so we can afford a casing path + markers. */
function encodePolyline(coords: LatLng[]): string {
  let lastLat = 0;
  let lastLon = 0;
  let out = '';
  const enc = (curr: number, prev: number): string => {
    let v = Math.round(curr * 1e5) - Math.round(prev * 1e5);
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    s += String.fromCharCode(v + 63);
    return s;
  };
  for (const [lat, lon] of coords) {
    out += enc(lat, lastLat) + enc(lon, lastLon);
    lastLat = lat;
    lastLon = lon;
  }
  return out;
}

/**
 * Static satellite hero with the route drawn as a bright emerald path over a dark casing
 * (so it stays legible against both water and forest, instead of a 1–2px hairline), plus
 * numbered markers for each scenic stop so the image tells the ride's story. Returns null
 * without a key.
 */
export function staticRouteSatelliteUrl(
  coords: LatLng[],
  opts: { size?: string; maptype?: 'satellite' | 'hybrid' | 'terrain'; stops?: LatLng[] } = {},
): string | null {
  if (!KEY) return null;
  const valid = coords.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (valid.length === 0) return null;
  const enc = encodePolyline(downsample(valid, 90));

  const params = new URLSearchParams({
    size: opts.size ?? '640x400',
    maptype: opts.maptype ?? 'hybrid',
    scale: '2',
    key: KEY,
  });
  // Casing first (drawn underneath), bright route on top — both as encoded polylines.
  const casing = `weight:8|color:0x0b3d2eff|enc:${enc}`;
  const route = `weight:5|color:0x34d399ff|enc:${enc}`;

  let markers = '';
  const stops = (opts.stops ?? []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).slice(0, 9);
  stops.forEach((p, i) => {
    markers += `&markers=${encodeURIComponent(`size:small|color:0x059669|label:${i + 1}|${p[0].toFixed(5)},${p[1].toFixed(5)}`)}`;
  });

  return (
    `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}` +
    `&path=${encodeURIComponent(casing)}&path=${encodeURIComponent(route)}${markers}`
  );
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
