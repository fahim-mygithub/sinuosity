import { describe, it, expect } from 'vitest';
import {
  hasGoogleKey,
  streetViewStaticUrl,
  staticRouteSatelliteUrl,
  streetViewDeepLink,
} from './scenicImagery';

// The test environment has no VITE_GOOGLE_MAPS_KEY, so this suite pins the keyless
// fallback contract: signed-image builders return null, deep-links always work.
describe('scenicImagery without a key', () => {
  it('reports no key configured', () => {
    expect(hasGoogleKey()).toBe(false);
  });

  it('returns null for Street View Static and satellite builders (no key)', () => {
    expect(streetViewStaticUrl(42.5, -78.9, 180)).toBeNull();
    expect(staticRouteSatelliteUrl([[42.5, -78.9], [42.6, -78.8]])).toBeNull();
  });
});

describe('streetViewDeepLink (always keyless)', () => {
  it('builds a Google Maps pano deep-link with viewpoint and heading', () => {
    const url = streetViewDeepLink(42.446, -78.918, 200);
    expect(url).toContain('https://www.google.com/maps/@?');
    expect(url).toContain('map_action=pano');
    expect(url).toContain('viewpoint=42.446%2C-78.918');
    expect(url).toContain('heading=200');
  });

  it('rounds the heading', () => {
    expect(streetViewDeepLink(0, 0, 199.7)).toContain('heading=200');
  });
});
