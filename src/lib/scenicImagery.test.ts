import { describe, it, expect } from 'vitest';
import {
  hasGoogleKey,
  streetViewStaticUrl,
  staticRouteSatelliteUrl,
  streetViewDeepLink,
} from './scenicImagery';

// The key may or may not be present depending on the environment (.env.local locally,
// no key in CI's test step), so the key-dependent builders are tested against both states.
describe('scenicImagery key-dependent builders', () => {
  it('returns a signed URL when a key is configured, else null', () => {
    const sv = streetViewStaticUrl(42.5, -78.9, 180);
    const sat = staticRouteSatelliteUrl([[42.5, -78.9], [42.6, -78.8]]);
    if (hasGoogleKey()) {
      expect(sv).toContain('maps/api/streetview');
      expect(sv).toContain('key=');
      expect(sat).toContain('maps/api/staticmap');
    } else {
      expect(sv).toBeNull();
      expect(sat).toBeNull();
    }
  });

  it('returns null for non-finite coordinates regardless of key', () => {
    expect(streetViewStaticUrl(NaN, -78.9, 180)).toBeNull();
    expect(staticRouteSatelliteUrl([[NaN, NaN]])).toBeNull();
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
