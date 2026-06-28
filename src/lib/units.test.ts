import { describe, it, expect } from 'vitest';
import { toUnits, fromUnits, formatDistance, distanceValue, distanceLabel } from './units';

describe('units', () => {
  it('keeps km unchanged in km mode', () => {
    expect(toUnits(40, 'km')).toBe(40);
    expect(formatDistance(40, 'km')).toBe('40 km');
  });

  it('converts km to miles in mi mode', () => {
    // 40 km ≈ 24.85 mi → rounds to 25
    expect(formatDistance(40, 'mi')).toBe('25 mi');
    expect(distanceValue(40, 'mi')).toBe(25);
  });

  it('rounds to whole numbers', () => {
    expect(formatDistance(37.4, 'km')).toBe('37 km');
  });

  it('handles non-finite input', () => {
    expect(formatDistance(NaN, 'mi')).toBe('—');
    expect(distanceValue(NaN, 'km')).toBe(0);
  });

  it('fromUnits inverts toUnits (km stays km, mi → km)', () => {
    expect(fromUnits(40, 'km')).toBe(40);
    expect(fromUnits(25, 'mi')).toBeCloseTo(40.23, 1);
    // round-trips: a km value survives there-and-back through the rider's unit
    expect(fromUnits(toUnits(12, 'mi'), 'mi')).toBeCloseTo(12, 5);
  });

  it('distanceLabel echoes the unit', () => {
    expect(distanceLabel('mi')).toBe('mi');
    expect(distanceLabel('km')).toBe('km');
  });
});
