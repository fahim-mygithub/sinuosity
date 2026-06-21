import { describe, it, expect } from 'vitest';
import { googleMapsUrl, appleMapsUrl, pickWaypoints, HOME } from './mapsUrl';
import { haversine, type LatLng } from './geometry';

const SAMPLE: LatLng[] = [
  [42.748, -78.742], [42.731, -78.729], [42.715, -78.718], [42.692, -78.701],
  [42.668, -78.688], [42.645, -78.674], [42.621, -78.653], [42.592, -78.641], [42.564, -78.632],
];

describe('pickWaypoints', () => {
  it('never exceeds the requested cap', () => {
    expect(pickWaypoints(SAMPLE, 3).length).toBeLessThanOrEqual(3);
    expect(pickWaypoints(SAMPLE, 9).length).toBeLessThanOrEqual(9);
  });

  it('returns empty for a 2-point route', () => {
    expect(pickWaypoints([[42, -78], [43, -78]], 3)).toEqual([]);
  });

  it('only returns interior points (never origin or destination)', () => {
    const wp = pickWaypoints(SAMPLE, 3);
    wp.forEach((p) => {
      expect(p).not.toEqual(SAMPLE[0]);
      expect(p).not.toEqual(SAMPLE[SAMPLE.length - 1]);
    });
  });

  it('returns waypoints in route order, without duplicates', () => {
    const wp = pickWaypoints(SAMPLE, 9);
    const idxs = wp.map((p) => SAMPLE.findIndex((s) => s[0] === p[0] && s[1] === p[1]));
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it('spaces stops evenly so the largest gap stays small (anti-expressway)', () => {
    // A long, evenly-sampled corridor — the failure mode is a big gap Google can shortcut.
    const route: LatLng[] = Array.from({ length: 60 }, (_, i) => [42 + i * 0.01, -78] as LatLng);
    const wp = pickWaypoints(route, 9);
    expect(wp.length).toBe(9);
    const stops = [route[0], ...wp, route[route.length - 1]];
    let maxGap = 0;
    for (let i = 1; i < stops.length; i++) maxGap = Math.max(maxGap, haversine(stops[i - 1], stops[i]));
    const total = haversine(route[0], route[route.length - 1]);
    // Even spacing keeps every gap near total/(n+1); allow generous slack for vertex snapping.
    expect(maxGap).toBeLessThan((total / (wp.length + 1)) * 1.6);
  });
});

describe('googleMapsUrl', () => {
  const url = googleMapsUrl(SAMPLE);

  it('uses the Maps URLs API format (api=1)', () => {
    expect(url).toContain('https://www.google.com/maps/dir/?');
    expect(url).toContain('api=1');
  });

  it('sets origin to HOME and destination to the last coord', () => {
    expect(url).toContain(`origin=${HOME[0].toFixed(5)}`);
    expect(url).toContain(`destination=${SAMPLE[SAMPLE.length - 1][0].toFixed(5)}`);
  });

  it('includes travelmode driving', () => {
    expect(url).toContain('travelmode=driving');
  });

  it('honors an explicit desktop cap of 9 (pipe-separated)', () => {
    const m = googleMapsUrl(SAMPLE, { maxWaypoints: 9 }).match(/waypoints=([^&]+)/);
    expect(m).toBeTruthy();
    const count = decodeURIComponent(m![1]).split('|').length;
    expect(count).toBeGreaterThan(3); // SAMPLE has 7 interior points → more than the mobile cap
    expect(count).toBeLessThanOrEqual(9);
  });

  it('honors an explicit mobile cap of 3', () => {
    const m = googleMapsUrl(SAMPLE, { maxWaypoints: 3 }).match(/waypoints=([^&]+)/);
    expect(m).toBeTruthy();
    expect(decodeURIComponent(m![1]).split('|').length).toBeLessThanOrEqual(3);
  });

  it('keeps the URL well under the 2048-char limit at the desktop cap', () => {
    expect(googleMapsUrl(SAMPLE, { maxWaypoints: 9 }).length).toBeLessThan(2048);
  });
});

describe('appleMapsUrl', () => {
  it('builds a saddr/daddr URL with driving flag', () => {
    const url = appleMapsUrl(SAMPLE);
    expect(url).toContain('maps.apple.com');
    expect(url).toContain('saddr=');
    expect(url).toContain('daddr=');
    expect(url).toContain('dirflg=d');
  });
});
