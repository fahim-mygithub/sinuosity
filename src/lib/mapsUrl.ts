import type { LatLng } from './geometry';
import { sharpestTurnIndices } from './geometry';

const HOME: LatLng = [42.9808, -78.7441];
const MOBILE_WAYPOINT_CAP = 3; // Google Maps URLs API caps mobile browsers at 3 waypoints

const isValid = (p: LatLng): boolean =>
  Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

const fmt = (p: LatLng) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;

/**
 * Pick up to `max` route-defining waypoints. Strategy 'sharp' picks the sharpest
 * turns (keeps you on the twisty road); 'even' samples at equal intervals.
 */
export function pickWaypoints(
  coords: LatLng[],
  max = MOBILE_WAYPOINT_CAP,
  strategy: 'sharp' | 'even' = 'sharp',
): LatLng[] {
  const mids = coords.slice(1, -1);
  if (!mids.length) return [];

  if (strategy === 'sharp') {
    // sharpestTurnIndices works on the full coords array; offset by -1 not needed
    // because we pass full coords and filter to interior points.
    const idxs = sharpestTurnIndices(coords, max).filter((i) => i > 0 && i < coords.length - 1);
    return idxs.map((i) => coords[i]);
  }

  const wp: LatLng[] = [];
  const step = Math.max(1, Math.floor(mids.length / max));
  for (let i = 0; i < mids.length && wp.length < max; i += step) wp.push(mids[i]);
  return wp;
}

/** Google Maps directions URL using the documented Maps URLs API (api=1). */
export function googleMapsUrl(
  coords: LatLng[],
  opts: { origin?: LatLng; strategy?: 'sharp' | 'even' } = {},
): string {
  const valid = coords.filter(isValid);
  const origin = opts.origin && isValid(opts.origin) ? opts.origin : HOME;
  const dest = valid[valid.length - 1] ?? origin;
  const wp = pickWaypoints(valid, MOBILE_WAYPOINT_CAP, opts.strategy ?? 'sharp');

  const params = new URLSearchParams({
    api: '1',
    origin: fmt(origin),
    destination: fmt(dest),
    travelmode: 'driving',
  });
  let url = `https://www.google.com/maps/dir/?${params.toString()}`;
  if (wp.length) url += `&waypoints=${wp.map(fmt).join('|')}`;
  return url;
}

/** Apple Maps directions URL (origin/destination only — mid-waypoints unreliable via URL). */
export function appleMapsUrl(coords: LatLng[], origin: LatLng = HOME): string {
  const start = isValid(origin) ? origin : HOME;
  const valid = coords.filter(isValid);
  const dest = valid[valid.length - 1] ?? start;
  return `https://maps.apple.com/?saddr=${fmt(start)}&daddr=${fmt(dest)}&dirflg=d`;
}

export { HOME };
