import { describe, it, expect } from 'vitest';
import { parseMaxspeedMph, isPaved, UNPAVED, cumulativeKm, pathLength, type LatLng } from './geometry';

describe('parseMaxspeedMph', () => {
  it('returns null for empty / undefined', () => {
    expect(parseMaxspeedMph(undefined)).toBeNull();
    expect(parseMaxspeedMph('')).toBeNull();
    expect(parseMaxspeedMph('   ')).toBeNull();
  });

  it('maps the German autobahn sentinel "none" to 70', () => {
    expect(parseMaxspeedMph('none')).toBe(70);
    expect(parseMaxspeedMph('NONE')).toBe(70);
  });

  it('maps "walk" to 3', () => {
    expect(parseMaxspeedMph('walk')).toBe(3);
  });

  it('returns null for signals / variable / country codes', () => {
    expect(parseMaxspeedMph('signals')).toBeNull();
    expect(parseMaxspeedMph('variable')).toBeNull();
    expect(parseMaxspeedMph('ru:rural')).toBeNull();
    expect(parseMaxspeedMph('de:urban')).toBeNull();
  });

  it('rejects knots units', () => {
    expect(parseMaxspeedMph('5 knots')).toBeNull();
    expect(parseMaxspeedMph('5 kn')).toBeNull();
  });

  it('reads an explicit mph value', () => {
    expect(parseMaxspeedMph('50 mph')).toBe(50);
  });

  it('treats a bare number as km/h per OSM and converts to mph', () => {
    expect(parseMaxspeedMph('50')).toBe(31); // 50 * 0.621 = 31.05 -> 31
  });

  it('converts explicit km/h units to mph', () => {
    expect(parseMaxspeedMph('80 km/h')).toBe(50); // 80 * 0.621 = 49.68 -> 50
    expect(parseMaxspeedMph('80 kmh')).toBe(50);
    expect(parseMaxspeedMph('80 kph')).toBe(50);
  });

  it('splits on ; and takes the minimum documented numeric value', () => {
    // "30 mph;50" -> 30 mph and bare 50 (=31 mph) -> min 30
    expect(parseMaxspeedMph('30 mph;50')).toBe(30);
  });
});

describe('isPaved / UNPAVED', () => {
  it('treats unknown / undefined surface as paved', () => {
    expect(isPaved(undefined)).toBe(true);
    expect(isPaved('')).toBe(true);
    expect(isPaved('something_unmapped')).toBe(true);
  });

  it('reports known unpaved surfaces as not paved', () => {
    for (const s of UNPAVED) expect(isPaved(s)).toBe(false);
  });

  it('reports a paved surface as paved', () => {
    expect(isPaved('asphalt')).toBe(true);
    expect(isPaved('paved')).toBe(true);
    expect(isPaved('concrete')).toBe(true);
  });

  it('is case-insensitive on the surface value', () => {
    expect(isPaved('GRAVEL')).toBe(false);
  });
});

describe('cumulativeKm', () => {
  const coords: LatLng[] = [[42.0, -78.0], [42.1, -78.0], [42.2, -78.0], [42.3, -78.0]];

  it('starts at 0', () => {
    expect(cumulativeKm(coords)[0]).toBe(0);
  });

  it('has one entry per coordinate', () => {
    expect(cumulativeKm(coords)).toHaveLength(coords.length);
  });

  it('final entry equals pathLength', () => {
    const cum = cumulativeKm(coords);
    expect(cum[cum.length - 1]).toBeCloseTo(pathLength(coords), 9);
  });

  it('any sub-arc i->j length matches pathLength of the slice', () => {
    const cum = cumulativeKm(coords);
    const arc = cum[3] - cum[1];
    expect(arc).toBeCloseTo(pathLength(coords.slice(1, 4)), 9);
  });

  it('returns [0] for a single point and [] for empty', () => {
    expect(cumulativeKm([[42.0, -78.0]])).toEqual([0]);
    expect(cumulativeKm([])).toEqual([]);
  });
});
