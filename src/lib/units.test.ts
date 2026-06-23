import { describe, it, expect } from 'vitest';
import { toUnits, formatDistance, distanceValue, distanceLabel } from './units';

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

  it('distanceLabel echoes the unit', () => {
    expect(distanceLabel('mi')).toBe('mi');
    expect(distanceLabel('km')).toBe('km');
  });
});
