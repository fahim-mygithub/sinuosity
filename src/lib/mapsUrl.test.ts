import { describe, it, expect } from 'vitest';
import { googleMapsUrl, appleMapsUrl, pickWaypoints, HOME } from './mapsUrl';
import type { LatLng } from './geometry';

const SAMPLE: LatLng[] = [
  [42.748, -78.742], [42.731, -78.729], [42.715, -78.718], [42.692, -78.701],
  [42.668, -78.688], [42.645, -78.674], [42.621, -78.653], [42.592, -78.641], [42.564, -78.632],
];

describe('pickWaypoints', () => {
  it('never exceeds the mobile cap of 3', () => {
    expect(pickWaypoints(SAMPLE, 3).length).toBeLessThanOrEqual(3);
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

  it('caps waypoints at 3 (pipe-separated)', () => {
    const m = url.match(/waypoints=([^&]+)/);
    expect(m).toBeTruthy();
    const count = decodeURIComponent(m![1]).split('|').length;
    expect(count).toBeLessThanOrEqual(3);
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
