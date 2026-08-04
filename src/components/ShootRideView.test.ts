import { describe, it, expect } from 'vitest';
import {
  gapNote,
  hopLength,
  outsideLight,
  rideDuration,
  rideLength,
  shapeNote,
  startNote,
} from './ShootRideView';
import type { ScheduledShot, ShootRide } from '../lib/reelRoute';

// This view's whole job is to not overstate a ride. The tests below are about the ways it could:
// calling a retrace a loop, printing a planning estimate to a precision it does not have, and
// implying the rest of the shortlist is available to tap when parts of it are unreachable.

const ride = (over: Partial<ShootRide> = {}): ShootRide =>
  ({
    shots: [],
    legs: [],
    coords: [],
    km: 0,
    minutes: 0,
    returnKind: null,
    depart: new Date(0),
    finish: new Date(0),
    start: [0, 0],
    startOffsetKm: 0,
    ...over,
  }) as ShootRide;

const shot = (light: ScheduledShot['light']): ScheduledShot => ({ light }) as ScheduledShot;

describe('rideLength', () => {
  it('rounds to the whole unit, which is all a planning estimate carries', () => {
    expect(rideLength(41.5, 'km')).toBe('42 km');
    expect(rideLength(41.5, 'mi')).toBe('26 mi');
  });
});

describe('hopLength', () => {
  it('keeps a decimal on short hops, which whole units round away entirely', () => {
    // Two shots on adjoining roads are a few hundred metres apart. At whole units a list of hops
    // reads 0, 0, 3, 0 — which looks broken rather than close.
    expect(hopLength(0.4, 'km')).toBe('0.4 km');
    expect(hopLength(0.4, 'mi')).toBe('0.2 mi');
  });

  it('drops the decimal once the hop is long enough not to need it', () => {
    expect(hopLength(41.5, 'km')).toBe('42 km');
    expect(hopLength(16.1, 'mi')).toBe('10 mi');
  });
});

describe('rideDuration', () => {
  it('reads as hours and minutes past the hour', () => {
    expect(rideDuration(34)).toBe('34 min');
    expect(rideDuration(60)).toBe('1 h 0 min');
    expect(rideDuration(95)).toBe('1 h 35 min');
  });

  it('never shows a negative ride', () => {
    expect(rideDuration(-5)).toBe('0 min');
  });
});

describe('shapeNote', () => {
  it('calls a retrace a retrace rather than a loop', () => {
    // The rider asked to come home; riding back the way they came is a different evening from a
    // circuit, and they would otherwise find that out at the far end.
    expect(shapeNote(ride({ returnKind: 'circuit' }))).toContain('a different way');
    expect(shapeNote(ride({ returnKind: 'retrace' }))).toContain('back the way you came');
  });

  it('says so when the ride does not come home at all', () => {
    expect(shapeNote(ride())).toContain('point to point');
  });
});

describe('outsideLight', () => {
  it('counts only the shots that fall outside the usable window', () => {
    expect(outsideLight([shot('in'), shot('late'), shot('in'), shot('early')])).toHaveLength(2);
    expect(outsideLight([shot('in')])).toHaveLength(0);
  });
});

describe('startNote', () => {
  it('says nothing when the ride starts where the rider was looking', () => {
    expect(startNote(0, 'km')).toBeNull();
    expect(startNote(1.9, 'km')).toBeNull();
  });

  it('names the distance when the first shot is somewhere else entirely', () => {
    // Measured at Ellicottville: the shots' island was 22.7 km from the pin.
    expect(startNote(22.7, 'km')).toContain('23 km');
    expect(startNote(22.7, 'mi')).toContain('14 mi');
  });
});

describe('gapNote', () => {
  it('says nothing about a ride that is measured road all the way', () => {
    expect(gapNote({ count: 0, km: 0 }, 'mi')).toBeNull();
  });

  it('names how much of the total is a straight line rather than a road', () => {
    // The rider can chain any two shots, including two the scan cannot route between. Printing the
    // total without this would claim a measurement the ride does not have.
    const note = gapNote({ count: 2, km: 11.3 }, 'mi')!;
    expect(note).toContain('2 hops');
    expect(note).toContain('7 mi');
    expect(note).toContain('longer');
  });

  it('reads as English for a single hop', () => {
    const note = gapNote({ count: 1, km: 3.2 }, 'km')!;
    expect(note).toContain('One hop');
    expect(note).toContain('it is');
    expect(note).not.toContain('they are');
  });
});
