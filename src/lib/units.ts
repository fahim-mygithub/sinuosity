import type { Units } from './preferences';

/** Kilometres per mile. */
const KM_PER_MI = 1.60934;

/** Convert a distance in km to the rider's chosen unit (numeric value only). */
export function toUnits(km: number, units: Units): number {
  return units === 'mi' ? km / KM_PER_MI : km;
}

/** Inverse of {@link toUnits}: take a value in the rider's unit and return km (the internal unit). */
export function fromUnits(value: number, units: Units): number {
  return units === 'mi' ? value * KM_PER_MI : value;
}

/**
 * Format a distance held in km for display, e.g. `formatDistance(37, 'mi') === '23 mi'`.
 * Rounds to a whole number (these are coarse ride lengths). Non-finite input → '—'.
 */
export function formatDistance(km: number, units: Units): string {
  if (!Number.isFinite(km)) return '—';
  return `${Math.round(toUnits(km, units))} ${units}`;
}

/** Just the rounded numeric part, for split value/label layouts (e.g. the stat strip). */
export function distanceValue(km: number, units: Units): number {
  return Number.isFinite(km) ? Math.round(toUnits(km, units)) : 0;
}

/** The unit label on its own ('mi' | 'km'), for split value/label layouts. */
export function distanceLabel(units: Units): string {
  return units;
}
