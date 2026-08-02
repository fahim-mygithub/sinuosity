import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  ROTATE_STEP_DEG,
  backdropHeading,
  cleanDriver,
  cleanProxyNote,
  coarseLength,
  compassName,
  landformScaleLabel,
  noBackdropPhrase,
  normalizeBearing,
  offsetLabel,
  proxyValue,
  rideDirectionPhrase,
  rotateOffset,
  shortlistBadge,
  signedOffset,
  terrainClause,
  terrainRead,
  viewRelativeToTravel,
} from './ShootCard';
import {
  FULL_JUNCTION_DENSITY,
  FULL_JUNCTION_PER_KM,
  PROBE_DISTANCES_M,
  type CleanReading,
} from '../lib/reelTypes';

// These check the card's DIRECTIONAL geometry against a rider standing on a map, not against what
// the implementation happens to return. Direction of travel is half of everything the Reel category
// outputs, and the Street View heading is the one claim on the card that can be independently wrong
// in a way the rider would never notice — a frame of the opposite verge looks exactly as plausible
// as a frame of the right one. So the facts asserted here are the ones anybody can rederive: face
// north and your right hand points east; ride east and the road you came from lies west.

describe('normalizeBearing', () => {
  it('folds a full turn either way onto the same bearing', () => {
    expect(normalizeBearing(0)).toBe(0);
    expect(normalizeBearing(360)).toBe(0);
    expect(normalizeBearing(-360)).toBe(0);
    expect(normalizeBearing(450)).toBe(90);
    expect(normalizeBearing(-90)).toBe(270);
    expect(normalizeBearing(-450)).toBe(270);
  });
});

describe('compassName', () => {
  it('names the four cardinals at their exact bearings', () => {
    expect(compassName(0)).toBe('north');
    expect(compassName(90)).toBe('east');
    expect(compassName(180)).toBe('south');
    expect(compassName(270)).toBe('west');
  });

  it('names the intercardinals at their exact bearings', () => {
    expect(compassName(45)).toBe('north-east');
    expect(compassName(135)).toBe('south-east');
    expect(compassName(225)).toBe('south-west');
    expect(compassName(315)).toBe('north-west');
  });

  it('wraps past 360 and below 0 rather than falling off the table', () => {
    // A `reverse` mark's bearing is computed as forward + 180, so 359 + 180 is a bearing this
    // function really does receive.
    expect(compassName(360)).toBe('north');
    expect(compassName(359)).toBe('north');
    expect(compassName(539)).toBe('south'); // 359 + 180
    expect(compassName(-90)).toBe('west');
  });

  it('splits each 45-degree sector at its midpoint', () => {
    // Sector boundaries sit at 22.5 deg. Below it is still north; at or above it is north-east.
    expect(compassName(22.4)).toBe('north');
    expect(compassName(22.5)).toBe('north-east');
    expect(compassName(67.4)).toBe('north-east');
    expect(compassName(67.5)).toBe('east');
  });
});

describe('rideDirectionPhrase', () => {
  it('reads as the two ends of the road, in the order they are ridden', () => {
    expect(rideDirectionPhrase(90)).toBe('west to east');
    expect(rideDirectionPhrase(0)).toBe('south to north');
    expect(rideDirectionPhrase(180)).toBe('north to south');
    expect(rideDirectionPhrase(270)).toBe('east to west');
    expect(rideDirectionPhrase(45)).toBe('south-west to north-east');
  });

  it('always starts from the antipode of the heading', () => {
    // The end you start from is the opposite end of the road, by definition. Swept at 15 deg so
    // sector midpoints and boundaries are both crossed.
    for (let b = 0; b < 360; b += 15) {
      const [from, to] = rideDirectionPhrase(b).split(' to ');
      expect(to).toBe(compassName(b));
      expect(from).toBe(compassName(b + 180));
      expect(from).not.toBe(to);
    }
  });

  it('describes the two directions of one road as exact mirrors', () => {
    // A window ridden the other way is a different mark, and its phrase must be this one reversed.
    const forward = rideDirectionPhrase(112);
    const reverse = rideDirectionPhrase(112 + 180);
    expect(reverse.split(' to ').reverse().join(' to ')).toBe(forward);
  });
});

describe('backdropHeading', () => {
  it('puts the right side to the east when riding north', () => {
    // Face north, and your right hand points east. Everything else in this suite is that fact
    // rotated, so getting this one backwards is the whole bug.
    expect(backdropHeading(0, 'right')).toBe(90);
    expect(backdropHeading(0, 'left')).toBe(270);
  });

  it('puts the right side to the south when riding east', () => {
    expect(backdropHeading(90, 'right')).toBe(180);
    expect(backdropHeading(90, 'left')).toBe(0);
  });

  it('stays inside [0, 360) when the perpendicular crosses north', () => {
    // travel - 90 goes negative for any easterly heading, and travel + 90 passes 360 for any
    // westerly one. Both are ordinary marks, not edge cases.
    expect(backdropHeading(10, 'left')).toBe(280);
    expect(backdropHeading(350, 'right')).toBe(80);
    expect(backdropHeading(0.5, 'left')).toBeCloseTo(270.5, 6);
  });

  it('is exactly 90 degrees off the direction of travel, in the correct sense, at every bearing', () => {
    for (let b = 0; b < 360; b += 7) {
      const right = backdropHeading(b, 'right');
      const left = backdropHeading(b, 'left');
      // Turning right from travel is +90; turning left is -90, i.e. +270 once folded.
      expect(normalizeBearing(right - b)).toBeCloseTo(90, 6);
      expect(normalizeBearing(left - b)).toBeCloseTo(270, 6);
      // And the two verges face each other.
      expect(normalizeBearing(right - left)).toBeCloseTo(180, 6);
    }
  });

  it('aims at the right-hand boom when neither side scored a backdrop', () => {
    // `backdropSide` is null when no side cleared BACKDROP_MIN. The camera is still on the right,
    // so that is still the frame worth showing.
    expect(backdropHeading(0, null)).toBe(backdropHeading(0, 'right'));
    expect(backdropHeading(217, null)).toBe(backdropHeading(217, 'right'));
  });
});

// Panning the preview off that aim. Same standard as above: the facts asserted are the ones anybody
// can rederive standing on a road. Turning right raises your bearing; four taps of 45 is half a turn
// whichever way you went; and a rider who has panned is owed the small angle, not the reflex one.

describe('signedOffset', () => {
  it('leaves the short way round alone', () => {
    expect(signedOffset(0)).toBe(0);
    expect(signedOffset(45)).toBe(45);
    expect(signedOffset(-45)).toBe(-45);
    expect(signedOffset(179)).toBe(179);
  });

  it('takes the reflex angle the short way, keeping the sense', () => {
    // 270 to the right and 90 to the left leave the camera on the same scene.
    expect(signedOffset(270)).toBe(-90);
    expect(signedOffset(-270)).toBe(90);
    expect(signedOffset(315)).toBe(-45);
  });

  it('gives half a turn one canonical form, from either direction', () => {
    expect(signedOffset(180)).toBe(180);
    expect(signedOffset(-180)).toBe(180);
  });

  it('folds whole turns away', () => {
    expect(signedOffset(360)).toBe(0);
    expect(signedOffset(405)).toBe(45);
    expect(signedOffset(-405)).toBe(-45);
  });
});

describe('rotateOffset', () => {
  it('steps right by ROTATE_STEP_DEG and left by the same', () => {
    expect(rotateOffset(0, 1)).toBe(ROTATE_STEP_DEG);
    expect(rotateOffset(0, -1)).toBe(-ROTATE_STEP_DEG);
  });

  it('closes the circle in 8 steps and never dead-ends', () => {
    // The control has no clamp, so holding one button must keep producing new scene rather than
    // sticking at half a turn.
    let o = 0;
    const seen = new Set<number>();
    for (let i = 0; i < 8; i++) {
      o = rotateOffset(o, 1);
      seen.add(o);
    }
    expect(seen.size).toBe(8);
    expect(o).toBe(0);
  });

  it('reaches half a turn from either side, and agrees with itself there', () => {
    expect(rotateOffset(0, 4)).toBe(180);
    expect(rotateOffset(0, -4)).toBe(180);
  });

  it('only ever produces multiples of the step, so a location can only mint 8 image URLs', () => {
    // This is the billing claim in ROTATE_STEP_DEG's comment: 8 distinct headings per location,
    // every repeat served from the browser cache.
    let o = 0;
    const seen = new Set<number>();
    for (const steps of [1, 1, -1, 3, -5, 2, 7, -11, 4]) {
      o = rotateOffset(o, steps);
      expect(Number.isInteger(o / ROTATE_STEP_DEG)).toBe(true);
      seen.add(o);
    }
    expect(seen.size).toBeLessThanOrEqual(8);
  });
});

describe('viewRelativeToTravel', () => {
  it('names the four square-on directions against the ride', () => {
    // Riding north: the aim (east) is square right, and the road ahead is north.
    expect(viewRelativeToTravel(0, 0)).toBe('up the road ahead');
    expect(viewRelativeToTravel(90, 0)).toBe('square right');
    expect(viewRelativeToTravel(180, 0)).toBe('back down the road');
    expect(viewRelativeToTravel(270, 0)).toBe('square left');
  });

  it('names the diagonals', () => {
    expect(viewRelativeToTravel(45, 0)).toBe('ahead and to your right');
    expect(viewRelativeToTravel(135, 0)).toBe('behind and to your right');
    expect(viewRelativeToTravel(225, 0)).toBe('behind and to your left');
    expect(viewRelativeToTravel(315, 0)).toBe('ahead and to your left');
  });

  it('is about the ride, not the compass — the same phrase at every bearing', () => {
    for (let travel = 0; travel < 360; travel += 13) {
      expect(viewRelativeToTravel(travel, travel)).toBe('up the road ahead');
      expect(viewRelativeToTravel(travel + 90, travel)).toBe('square right');
      expect(viewRelativeToTravel(travel - 90, travel)).toBe('square left');
    }
  });

  it('describes every position the rotate control can reach, from either verge', () => {
    // The aim is +90 for a right backdrop and -90 for a left one, and both are pannable. Nothing
    // reachable may fall off the table.
    for (const side of ['right', 'left'] as const) {
      for (let travel = 0; travel < 360; travel += 29) {
        for (let steps = -8; steps <= 8; steps++) {
          const view = normalizeBearing(backdropHeading(travel, side) + rotateOffset(0, steps));
          expect(viewRelativeToTravel(view, travel)).toBeTypeOf('string');
        }
      }
    }
  });

  it('agrees with the aim: on the aim, a right backdrop reads square right', () => {
    for (let travel = 0; travel < 360; travel += 11) {
      expect(viewRelativeToTravel(backdropHeading(travel, 'right'), travel)).toBe('square right');
      expect(viewRelativeToTravel(backdropHeading(travel, 'left'), travel)).toBe('square left');
      // A null side aims right, so it must read as the right-hand boom too.
      expect(viewRelativeToTravel(backdropHeading(travel, null), travel)).toBe('square right');
    }
  });
});

describe('offsetLabel', () => {
  it('says nothing at all while the frame is still on the aim', () => {
    // The unpanned caption is a different sentence entirely; a "0° right" would be noise on it.
    expect(offsetLabel(0)).toBeNull();
    expect(offsetLabel(360)).toBeNull();
  });

  it('names the size and the side of the pan', () => {
    expect(offsetLabel(45)).toBe('45° right of the boom’s aim');
    expect(offsetLabel(-90)).toBe('90° left of the boom’s aim');
  });

  it('reports the short way round rather than the reflex angle', () => {
    // Three taps left is 135 left, never 225 right.
    expect(offsetLabel(rotateOffset(0, -3))).toBe('135° left of the boom’s aim');
    expect(offsetLabel(225)).toBe('135° left of the boom’s aim');
  });

  it('claims no side at half a turn, which is reachable both ways', () => {
    expect(offsetLabel(180)).toBe('turned right round from the boom’s aim');
    expect(offsetLabel(-180)).toBe(offsetLabel(180));
    expect(offsetLabel(rotateOffset(0, 4))).toBe(offsetLabel(rotateOffset(0, -4)));
  });
});

// The rest of this file covers what the card CLAIMS rather than where it points. Two different ways
// of claiming more than the data supports are pinned here: telling a rider a lookup is still coming
// when it has already failed, and rendering a four-valued probe distance to the foot.

const FALL = { fallM: 12.3, atM: 400, riseM: 4.1 };

describe('terrainRead', () => {
  it('reads a present LateralFall as read, whatever the refinement is doing', () => {
    expect(terrainRead(FALL, true)).toBe('read');
    expect(terrainRead(FALL, false)).toBe('read');
  });

  it('reads a flat-but-measured window as read, not as missing', () => {
    // `readFall` returns an all-zero LateralFall for genuinely flat ground. That is an answer, and
    // conflating it with "no answer" would be the mirror of the bug below.
    expect(terrainRead({ fallM: 0, atM: 0, riseM: 0 }, false)).toBe('read');
  });

  it('separates a lookup still running from one that has already failed', () => {
    // THE BUG. `enrichMarks` re-scores with `fall = null` in BOTH cases and the mark carries nothing
    // that tells them apart, so the card said "not read YET" forever after a dead DEM — a promise it
    // could not keep, over the dimension carrying 0.40 of the composite. The refinement flag is the
    // missing bit, and it is honest about exactly this.
    expect(terrainRead(null, true)).toBe('reading');
    expect(terrainRead(null, false)).toBe('unavailable');
  });
});

describe('terrainClause', () => {
  it('adds nothing to the backdrop line when there is a real reading to show', () => {
    expect(terrainClause('read')).toBeNull();
  });

  it('promises a reading only while one is actually coming', () => {
    expect(terrainClause('reading')).toMatch(/still being read/);
    // The failed state must not say "yet", "still", or anything else that implies a later arrival.
    const failed = terrainClause('unavailable')!;
    expect(failed).toMatch(/could not be read/);
    expect(failed).not.toMatch(/\byet\b|\bstill\b/);
  });
});

describe('noBackdropPhrase', () => {
  it('claims nothing is there only when both mechanisms actually looked', () => {
    expect(noBackdropPhrase('read')).toMatch(/nothing here reads as an open view/);
  });

  it('does not claim nothing is there when the DEM never answered', () => {
    // A silent gap reads to the rider as "we checked everywhere and found nothing", which is a
    // different and much worse claim than "we did not look" — and with the DEM dead, backdrop was
    // decided on open water alone, which is exactly the test a gorge road with no lake fails.
    const failed = noBackdropPhrase('unavailable');
    expect(failed).not.toMatch(/nothing here reads as an open view/);
    expect(failed).toMatch(/did not land/);
    expect(failed).toMatch(/water/);

    const pending = noBackdropPhrase('reading');
    expect(pending).not.toMatch(/nothing here reads as an open view/);
    expect(pending).toMatch(/still coming in/);
  });
});

describe('landformScaleLabel', () => {
  it('names every probe distance approximately, in both unit systems', () => {
    // `atM` is one of exactly four values and means the SCALE of the landform, so each one has to
    // land on something a rider says out loud. Two of the four are exact by luck: a quarter mile is
    // 402 m and a half mile is 804 m.
    expect(landformScaleLabel(200, 'km')).toBe('about 200 m');
    expect(landformScaleLabel(400, 'km')).toBe('about 400 m');
    expect(landformScaleLabel(800, 'km')).toBe('about 800 m');
    expect(landformScaleLabel(1500, 'km')).toBe('about 1.5 km');
    expect(landformScaleLabel(200, 'mi')).toBe('about 200 yards');
    expect(landformScaleLabel(400, 'mi')).toBe('about a quarter mile');
    expect(landformScaleLabel(800, 'mi')).toBe('about half a mile');
    expect(landformScaleLabel(1500, 'mi')).toBe('about a mile');
  });

  it('covers exactly the probe distances the DEM actually uses', () => {
    // Pinned against reelTypes rather than against a copy of the list, so adding a fifth probe
    // distance fails here instead of silently rendering nothing at that scale.
    for (const d of PROBE_DISTANCES_M) expect(landformScaleLabel(d, 'km')).not.toBeNull();
  });

  it('never renders a foot-precise distance', () => {
    // THE BUG. This used to go through the same metres-to-feet converter as a measured length, so
    // 1500 m — one of four sentinel probe distances, on a DEM whose measured cell is ~69 m — was
    // painted as "4921 ft". Four significant figures for a quantity with four possible values.
    for (const d of PROBE_DISTANCES_M) {
      for (const units of ['mi', 'km'] as const) {
        const label = landformScaleLabel(d, units)!;
        expect(label).toMatch(/^about /);
        expect(label).not.toMatch(/ft/);
        expect(label).not.toMatch(/\d{4}/);
      }
    }
  });

  it('refuses to name a scale that was never measured', () => {
    // `readFall` uses atM = 0 for "no distance produced a fall". It is not a member of
    // PROBE_DISTANCES_M precisely so it cannot be confused with a 200 m landform, and a label here
    // would undo that.
    expect(landformScaleLabel(0, 'km')).toBeNull();
    expect(landformScaleLabel(0, 'mi')).toBeNull();
    expect(landformScaleLabel(1000, 'km')).toBeNull();
  });
});

describe('shortlistBadge', () => {
  it('states a position and the size of the list it is a position in', () => {
    // "#3" alone sounds like a podium; "#3 of 40" says what it actually is.
    expect(shortlistBadge(3, 40)).toBe('#3 of 40');
    expect(shortlistBadge(1, 1)).toBe('#1 of 1');
  });

  it('is never a bare number that could be read as a score out of 100', () => {
    // The badge it replaces was `mark.score`, a 0-100 composite in the Scan tab's emerald mono
    // badge — while reelScore.ts is explicit that a window score and a ride score must never be read
    // on one scale, and this module's own header forbids showing a match %.
    for (const [rank, total] of [[1, 40], [17, 40], [40, 40], [7, 0]] as const) {
      expect(shortlistBadge(rank, total)).not.toMatch(/^\d+$/);
      expect(shortlistBadge(rank, total).startsWith('#')).toBe(true);
    }
  });
});

describe('the card does not render a score', () => {
  it('has no interpolation of the mark composite', () => {
    // A source assertion, deliberately: the finding is about what is PAINTED and there is no DOM in
    // this test environment. Measured over ten (instant x aim) combinations a shortlist's composites
    // span 11-20 points somewhere between 64 and 94 — under weights that are invented rather than
    // measured, over a ground truth at kappa = 0.53 — so two digits out of a hundred implied a
    // precision nothing here can carry.
    const src = readFileSync(new URL('./ShootCard.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\{\s*mark\.score\s*\}/);
  });

  it('does not justify that with the 87-100 spread, which no measurement produced', () => {
    // FIX 4. The conclusion (drop the badge) is right and stays; the number that supported it was
    // invented. Measured across ten combos the spans are 70-85, 65-77, 71-85, 74-90, 64-75, 74-94 —
    // never 87-100, and never even reaching 87 at the bottom end.
    const src = readFileSync(new URL('./ShootCard.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/87-100/);
    expect(src).toMatch(/64 and 94/);
  });
});

// --- FIX 2: the emitted side is always `right` --------------------------------------------------

describe('the card carries no path for a left-hand backdrop', () => {
  // Measured across all 1,417 windows x 10 (instant x aim) combinations of the real corpus: zero
  // marks with `backdropSide === 'left'`, including the 221 windows whose forward-order LEFT verge
  // is the better one — `pickDirection` emits those as `reverse`, which puts the same backdrop on
  // the right. The card used to colour that impossible state amber and apologise for it in prose.
  const src = readFileSync(new URL('./ShootCard.tsx', import.meta.url), 'utf8');

  it('no longer apologises that the boom is on the other verge', () => {
    expect(src).not.toMatch(/reframe out of the 360/);
    expect(src).not.toMatch(/text-amber-400\/90 font-bold/);
  });

  it('states the invariant where the branch used to be, so it is not restored', () => {
    expect(src).toMatch(/backdropSide === 'left'/);
    expect(src).toMatch(/pickDirection/);
  });

  it('keeps `backdropHeading` general, because a verge really does have two sides', () => {
    // The one thing NOT deleted. `PerSide` readings are genuinely two-sided and this is a geometric
    // utility over them; it is the SELECTED side of a mark that is invariably right.
    expect(backdropHeading(0, 'left')).toBe(270);
    expect(backdropHeading(0, 'right')).toBe(90);
  });
});

// --- FIX 3: name the term that actually bound cleanliness ---------------------------------------

const clean = (over: Partial<CleanReading> = {}): CleanReading => ({
  score10: 5,
  builtDensity: null,
  junctionsPerKm: 0,
  junctionDensity: 0,
  uglyFrac: 0,
  provisional: true,
  ...over,
});

describe('cleanDriver', () => {
  it('names the density term when it is the one that saturates first', () => {
    // The measured majority case: 74.6% of 1,417 windows, 24 of a top-40 shortlist. `junctionsPerKm`
    // is quantised to 2.5/km over a 400 m window and is zero on 73.9% of them, so the along-window
    // count is usually not the reason for anything.
    expect(cleanDriver(clean({ junctionsPerKm: 0, junctionDensity: 4 }))).toBe('junctionDensity');
    expect(cleanDriver(clean({ junctionsPerKm: 2.5, junctionDensity: 9.4 }))).toBe('junctionDensity');
  });

  it('names the along-window count when THAT is the one that saturates first', () => {
    // 9.2% of windows, 3 of a top-40. A lone strip of driveways tees into the road constantly while
    // the disc around it stays empty — the case `junctionDensity` cannot see.
    expect(cleanDriver(clean({ junctionsPerKm: 5, junctionDensity: 0 }))).toBe('junctionsPerKm');
    expect(cleanDriver(clean({ junctionsPerKm: 5, junctionDensity: 3 }))).toBe('junctionsPerKm');
  });

  it('compares the two NORMALISED, exactly as scoreClean does', () => {
    // The readings are in different units (junctions per km ALONG vs nodes per km² AROUND) against
    // different saturation constants, so comparing the raw numbers would name the bigger one rather
    // than the binding one. Half-saturated along against 56%-saturated around: the along count is
    // the larger NUMBER and the density is the larger SHARE, and the share is what scoreClean's
    // `Math.max` sees.
    const along = FULL_JUNCTION_PER_KM * 0.5;
    const around = FULL_JUNCTION_DENSITY * 0.56;
    expect(along).toBeGreaterThan(around);
    expect(cleanDriver(clean({ junctionsPerKm: along, junctionDensity: around }))).toBe('junctionDensity');
    // And the mirror: saturated along against 95%-saturated around.
    expect(cleanDriver(clean({ junctionsPerKm: FULL_JUNCTION_PER_KM, junctionDensity: FULL_JUNCTION_DENSITY * 0.95 })))
      .toBe('junctionsPerKm');
  });

  it('gives an exact tie to the density half', () => {
    // A judgement call, recorded: the two normalise equal only when both are zero, and density is
    // the continuous half and the one that binds eight times more often.
    expect(cleanDriver(clean({ junctionsPerKm: FULL_JUNCTION_PER_KM, junctionDensity: FULL_JUNCTION_DENSITY })))
      .toBe('junctionDensity');
  });

  it('names the ugly-area scaling when no junction term took anything off', () => {
    // `uglyFrac` scales multiplicatively AFTER the penalty, so it can be the whole reason for a
    // mid-range score on a window nothing tees into. Naming a junction term there is the same
    // contradiction one term over.
    expect(cleanDriver(clean({ uglyFrac: 0.3 }))).toBe('ugly');
  });

  it('says nothing bound it when nothing did', () => {
    expect(cleanDriver(clean())).toBe('none');
  });
});

describe('cleanProxyNote', () => {
  it('does not blame junctions per km when junctions per km is zero', () => {
    // THE BUG. The card printed "Clean is still the free junction proxy (0.0 junctions per km)" as
    // the stated reason for a cleanliness of 5 or 7 — on 74.6% of windows, where the term that
    // actually bound the penalty was `junctionDensity`, which appeared nowhere in the UI. A rider
    // reading "0.0 junctions per km" beside a 5/10 is reading a flat contradiction.
    const note = cleanProxyNote(clean({ junctionsPerKm: 0, junctionDensity: 4 }));
    expect(note).not.toMatch(/junctions per km/);
    expect(note).not.toMatch(/\b0(\.0)? junctions/);
    expect(note).toMatch(/road ends per km²/);
    expect(note).toMatch(/\b4\b/);
  });

  it('does blame junctions per km when they are what bound it', () => {
    const note = cleanProxyNote(clean({ junctionsPerKm: 5, junctionDensity: 0 }));
    expect(note).toMatch(/5 junctions per km/);
    expect(note).not.toMatch(/road ends per km²/);
  });

  it('names the ugly-land share rather than a junction count', () => {
    const note = cleanProxyNote(clean({ uglyFrac: 0.3 }));
    expect(note).toMatch(/30%/);
    expect(note).not.toMatch(/junctions per km/);
    expect(note).not.toMatch(/road ends per km²/);
  });

  it('never quotes a number as the reason when no term took anything off', () => {
    const note = cleanProxyNote(clean());
    expect(note).not.toMatch(/\d/);
    expect(note).toMatch(/takes nothing off/);
  });

  it('never renders a proxy to a tenth', () => {
    // FIX 4. Both readings land on a 0.5 quantum — 2.5/km per junction over a fixed 400 m window,
    // 0.50/km² per node over a fixed 800 m disc — so `toFixed(1)` was inventing a digit, and the
    // digit it invented most often was the ".0" of "0.0".
    for (const c of [
      clean({ junctionsPerKm: 2.5 }),
      clean({ junctionsPerKm: 5 }),
      clean({ junctionDensity: 4 }),
      clean({ junctionDensity: 13.4 }),
      clean({ junctionDensity: 0.5 }),
    ]) {
      expect(cleanProxyNote(c)).not.toMatch(/\d+\.0\b/);
    }
  });

  it('is what the card renders — the inline toFixed is gone', () => {
    const src = readFileSync(new URL('./ShootCard.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/junctionsPerKm\.toFixed/);
    expect(src).toMatch(/cleanProxyNote\(mark\.clean\)/);
  });
});

describe('proxyValue', () => {
  it('prints the 0.5 quantum and nothing finer', () => {
    expect(proxyValue(0)).toBe('0');
    expect(proxyValue(2.5)).toBe('2.5');
    expect(proxyValue(5)).toBe('5');
    expect(proxyValue(13.4)).toBe('13.5');
  });

  it('never emits a trailing .0, which is where the false precision showed', () => {
    for (let n = 0; n <= 60; n += 0.1) expect(proxyValue(n)).not.toMatch(/\.0$/);
  });
});

// --- FIX 4: distances rendered at what the DEM and the tiles support -----------------------------

describe('coarseLength', () => {
  it('renders a lateral fall at 10 m, not to the foot', () => {
    // THE BUG. 130.3 m — Letchworth Park Rd's measured mean lateral fall — used to render as
    // "427 ft" from a GLO-90 DEM with a ~69 m cell and a measured 3.6x horizon-angle UNDERESTIMATE
    // in exactly the gorges this feature exists to find. Four significant figures over a documented
    // bias larger than most of the values the quantity takes.
    expect(coarseLength(130.3, 'mi')).not.toBe('427 ft');
    expect(coarseLength(130.3, 'mi')).toBe('430 ft');
    expect(coarseLength(130.3, 'km')).toBe('130 m');
  });

  it('rounds in metres and converts the rounded value, so imperial is never the finer column', () => {
    // Converting first and rounding to the foot would put ~3x more resolution in the imperial
    // column than in the metric one, for the same reading.
    for (let m = 0; m <= 400; m += 7) {
      const ft = coarseLength(m, 'mi');
      if (ft.startsWith('under')) continue;
      expect(+ft.replace(' ft', '') % 10).toBe(0);
      expect(+coarseLength(m, 'km').replace(' m', '') % 10).toBe(0);
    }
  });

  it('says "under" rather than zero for anything inside half a quantum', () => {
    // The line this feeds only renders when the fall is positive, so "0 m of fall" would be a
    // contradiction rather than a measurement — and `waterM` at 4 m is a real reading, not an
    // absence.
    expect(coarseLength(4, 'km')).toBe('under 10 m');
    expect(coarseLength(4, 'mi')).toBe('under 30 ft');
    expect(coarseLength(0, 'km')).toBe('under 10 m');
  });

  it('keeps the distinction the water reading exists for', () => {
    // Measured spread of open-water hits inside BACKDROP_WATER_M: p25 = 84 m, p50 = 154 m,
    // p75 = 252 m. A lake at 80 m fills a 9:16 frame and the same lake at 340 m is a smudge, so the
    // quantum has to stay well under a band width (100 m).
    expect(coarseLength(84, 'km')).toBe('80 m');
    expect(coarseLength(154, 'km')).toBe('150 m');
    expect(coarseLength(252, 'km')).toBe('250 m');
    expect(coarseLength(337, 'km')).toBe('340 m');
  });

  it('is what the card renders — no bare metres-to-feet on a measured distance', () => {
    const src = readFileSync(new URL('./ShootCard.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Math\.round\(feet \? m \* M_TO_FT : m\)/);
    expect(src).toMatch(/const len = \(m: number\) => coarseLength\(m, units\)/);
  });
});
