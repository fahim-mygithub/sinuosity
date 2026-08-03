import { describe, it, expect } from 'vitest';
import { dropNotes, outsideLight, rideDuration, rideLength, shapeNote, startNote } from './ShootRideView';
import { MAX_SHOTS, type ScheduledShot, type ShootRide } from '../lib/reelRoute';

// This view's whole job is to not overstate a ride. The tests below are about the three ways it
// could: calling a retrace a loop, printing a planning estimate to a precision it does not have, and
// showing four shots out of forty without saying where the other thirty-six went.

const ride = (over: Partial<ShootRide> = {}): ShootRide =>
  ({
    shots: [],
    legs: [],
    coords: [],
    km: 0,
    minutes: 0,
    shape: 'out-and-back',
    returnKind: null,
    depart: new Date(0),
    finish: new Date(0),
    start: [0, 0],
    startOffsetKm: 0,
    dropped: [],
    ...over,
  }) as ShootRide;

const shot = (light: ScheduledShot['light']): ScheduledShot =>
  ({ light }) as ScheduledShot;

describe('rideLength', () => {
  it('rounds to the whole unit, which is all a planning estimate carries', () => {
    expect(rideLength(41.5, 'km')).toBe('42 km');
    expect(rideLength(41.5, 'mi')).toBe('26 mi');
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
    const shots = [shot('in'), shot('late'), shot('in'), shot('early')];
    expect(outsideLight(shots)).toHaveLength(2);
    expect(outsideLight([shot('in')])).toHaveLength(0);
  });
});

describe('startNote', () => {
  it('says nothing when the ride starts where the rider was looking', () => {
    expect(startNote(0, 'km')).toBeNull();
    expect(startNote(1.9, 'km')).toBeNull();
  });

  it('names the distance when the ride starts somewhere else entirely', () => {
    // Measured at Ellicottville: the shots' island was 22.7 km from the pin.
    expect(startNote(22.7, 'km')).toContain('23 km');
    expect(startNote(22.7, 'mi')).toContain('14 mi');
  });
});

describe('dropNotes', () => {
  it('accounts for every mark that did not make the ride', () => {
    const notes = dropNotes(
      ride({
        dropped: [
          { reason: 'budget' },
          { reason: 'budget' },
          { reason: 'unreachable' },
          { reason: 'cap' },
        ],
      } as unknown as Partial<ShootRide>),
    );
    expect(notes).toHaveLength(3);
    expect(notes[0]).toBe('2 would not fit the distance');
    expect(notes[1]).toBe('1 no road route to them');
    expect(notes[2]).toContain(String(MAX_SHOTS));
  });

  it('says nothing when nothing was dropped', () => {
    expect(dropNotes(ride())).toEqual([]);
  });
});
