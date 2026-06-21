import type { LatLng } from './geometry';
import { haversine } from './geometry';

const HOME: LatLng = [42.9808, -78.7441];

// Google's Maps URLs API (api=1) honors at most 3 waypoints when the link opens in a MOBILE
// browser, and up to 9 on desktop:
// https://developers.google.com/maps/documentation/urls/get-started
// We pack as many as the platform allows so Google can't "optimize" a long gap between sparse
// waypoints onto a parallel expressway (the Letchworth-rim → I-390 leak).
const MOBILE_WAYPOINT_CAP = 3;
const DESKTOP_WAYPOINT_CAP = 9;

const isValid = (p: LatLng): boolean =>
  Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

const fmt = (p: LatLng) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;

/** True when running in a mobile browser (where Google caps the deep-link at 3 waypoints). */
export function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}

/**
 * Up to `max` interior waypoints spaced evenly by ARC LENGTH along the route. Even spacing is
 * deliberate: it bounds the LARGEST gap between consecutive stops, and a small max-gap is what
 * stops Google re-routing a gap onto a faster parallel road. Picking the N *sharpest* turns
 * instead can cluster them on one bend and leave a 6 km+ gap elsewhere — exactly how the
 * Letchworth Gorge Rim route leaked onto the I-390 expressway between waypoints.
 */
export function pickWaypoints(coords: LatLng[], max: number): LatLng[] {
  const interior = coords.length - 2;
  if (max <= 0 || interior <= 0) return [];
  const n = Math.min(max, interior);

  // cumulative arc length at each vertex
  const cum: number[] = new Array(coords.length);
  cum[0] = 0;
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + haversine(coords[i - 1], coords[i]);
  const total = cum[coords.length - 1];
  if (!(total > 0)) return [];

  const picked: number[] = [];
  const seen = new Set<number>();
  for (let k = 1; k <= n; k++) {
    const target = (total * k) / (n + 1); // even fractions of the route's length
    let best = 1;
    let bestD = Infinity;
    for (let i = 1; i <= coords.length - 2; i++) {
      const d = Math.abs(cum[i] - target);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (!seen.has(best)) {
      seen.add(best);
      picked.push(best);
    }
  }
  picked.sort((a, b) => a - b); // keep route order
  return picked.map((i) => coords[i]);
}

/**
 * Google Maps directions URL using the documented Maps URLs API (api=1). The waypoint cap is
 * platform-aware (mobile 3 / desktop 9) unless `maxWaypoints` is given. More, evenly-spaced
 * waypoints keep Google on the actual scenic geometry instead of shortcutting to an expressway.
 */
export function googleMapsUrl(
  coords: LatLng[],
  opts: { origin?: LatLng; maxWaypoints?: number } = {},
): string {
  const valid = coords.filter(isValid);
  const origin = opts.origin && isValid(opts.origin) ? opts.origin : HOME;
  const dest = valid[valid.length - 1] ?? origin;
  const cap = opts.maxWaypoints ?? (isMobileBrowser() ? MOBILE_WAYPOINT_CAP : DESKTOP_WAYPOINT_CAP);
  const wp = pickWaypoints(valid, cap);

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
