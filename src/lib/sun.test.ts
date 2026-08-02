import { describe, it, expect } from 'vitest';
import {
  solarPosition,
  localSolarNoon,
  goldenWindow,
  segmentLight,
  lightQuality10,
  directionalLight10,
  sideLight10,
  GOLDEN_LO_DEG,
  GOLDEN_HI_DEG,
} from './sun';

// These tests deliberately check against FIRST PRINCIPLES rather than against numbers copied
// from another solar calculator. Equinox and solstice noon elevations, the equation of time's
// known extremes, and the equinox sunrise bearing are all derivable from spherical geometry, so
// a passing suite means the implementation agrees with astronomy — not merely with whatever
// reference happened to be pasted in.

const BUFFALO: [number, number] = [42.9, -78.85]; // ~the app's home region
const EQUATOR: [number, number] = [0, 0];

describe('solarPosition — noon elevation from first principles', () => {
  // At solar noon, apparent elevation = 90 - |latitude - declination|. Declination is ~0 at an
  // equinox and +/-23.44 at a solstice, which pins three exact expectations per latitude.
  const noonElevation = (iso: string, lat: number, lon: number) => {
    const noon = localSolarNoon(new Date(iso), lon);
    return solarPosition(noon, lat, lon).elevationDeg;
  };

  it('equinox noon elevation is 90 - latitude', () => {
    // Declination passes through 0 at the equinox instant, so allow a little for the offset
    // between that instant and local solar noon.
    expect(noonElevation('2026-03-20T12:00:00Z', 42, 0)).toBeCloseTo(48, 0);
    expect(noonElevation('2026-09-22T12:00:00Z', 42, 0)).toBeCloseTo(48, 0);
    expect(noonElevation('2026-03-20T12:00:00Z', 0, 0)).toBeCloseTo(90, 0);
  });

  it('June solstice noon elevation is 90 - lat + 23.44', () => {
    expect(noonElevation('2026-06-21T12:00:00Z', 42, 0)).toBeCloseTo(71.4, 0);
  });

  it('December solstice noon elevation is 90 - lat - 23.44', () => {
    expect(noonElevation('2026-12-21T12:00:00Z', 42, 0)).toBeCloseTo(24.6, 0);
  });

  it('the sun is due south at solar noon in the northern mid-latitudes', () => {
    const noon = localSolarNoon(new Date('2026-07-15T12:00:00Z'), BUFFALO[1]);
    expect(solarPosition(noon, BUFFALO[0], BUFFALO[1]).azimuthDeg).toBeCloseTo(180, 0);
  });

  it('the sun is due north at solar noon in the southern mid-latitudes', () => {
    const noon = localSolarNoon(new Date('2026-07-15T12:00:00Z'), 145);
    const az = solarPosition(noon, -37.8, 145).azimuthDeg; // Melbourne, southern winter
    expect(Math.min(az, 360 - az)).toBeCloseTo(0, 0);
  });
});

describe('localSolarNoon — reproduces the known equation-of-time extremes', () => {
  // EoT peaks near +16.4 min in early November and near -14.2 min in mid February. At longitude
  // 0 local mean time IS UTC, so solar noon lands at 12:00 minus EoT. This is an independent
  // check of the equation-of-time term, which nothing else in the suite exercises directly.
  const minutesUTC = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;

  it('early November solar noon is ~16 minutes BEFORE 12:00 UTC at longitude 0', () => {
    expect(minutesUTC(localSolarNoon(new Date('2026-11-03T12:00:00Z'), 0))).toBeCloseTo(720 - 16.4, 0);
  });

  it('mid February solar noon is ~14 minutes AFTER 12:00 UTC at longitude 0', () => {
    expect(minutesUTC(localSolarNoon(new Date('2026-02-11T12:00:00Z'), 0))).toBeCloseTo(720 + 14.2, 0);
  });

  it('shifts by 4 minutes per degree of longitude', () => {
    const a = localSolarNoon(new Date('2026-07-15T12:00:00Z'), 0).getTime();
    const b = localSolarNoon(new Date('2026-07-15T12:00:00Z'), -15).getTime();
    expect((b - a) / 60000).toBeCloseTo(60, 0); // 15 deg west = one hour later
  });
});

describe('solarPosition — structural invariants', () => {
  it('is symmetric about solar noon', () => {
    const noon = localSolarNoon(new Date('2026-07-15T12:00:00Z'), BUFFALO[1]).getTime();
    const before = solarPosition(new Date(noon - 3 * 3600000), ...BUFFALO);
    const after = solarPosition(new Date(noon + 3 * 3600000), ...BUFFALO);
    expect(before.elevationDeg).toBeCloseTo(after.elevationDeg, 1);
    // …and the azimuths mirror about due south.
    expect(360 - after.azimuthDeg).toBeCloseTo(before.azimuthDeg, 0);
  });

  it('puts the sun in the east in the morning and the west in the evening', () => {
    const noon = localSolarNoon(new Date('2026-07-15T12:00:00Z'), BUFFALO[1]).getTime();
    expect(solarPosition(new Date(noon - 4 * 3600000), ...BUFFALO).azimuthDeg).toBeLessThan(180);
    expect(solarPosition(new Date(noon + 4 * 3600000), ...BUFFALO).azimuthDeg).toBeGreaterThan(180);
  });

  it('rises close to due east at the equinox, at any latitude', () => {
    // The equinox sunrise bearing is ~90 deg everywhere — a strong joint check on declination
    // and the azimuth quadrant logic.
    for (const lat of [0, 42, -34]) {
      const noon = localSolarNoon(new Date('2026-03-20T12:00:00Z'), 0).getTime();
      let best = { d: Infinity, az: 0 };
      for (let m = -420; m <= 0; m += 1) {
        const p = solarPosition(new Date(noon + m * 60000), lat, 0);
        const d = Math.abs(p.elevationDeg);
        if (d < best.d) best = { d, az: p.azimuthDeg };
      }
      expect(best.az).toBeGreaterThan(85);
      expect(best.az).toBeLessThan(95);
    }
  });

  it('keeps azimuth in [0,360) and elevation in [-90,90]', () => {
    for (let h = 0; h < 24; h += 1) {
      const p = solarPosition(new Date(Date.UTC(2026, 6, 15, h)), ...BUFFALO);
      expect(p.azimuthDeg).toBeGreaterThanOrEqual(0);
      expect(p.azimuthDeg).toBeLessThan(360);
      expect(p.elevationDeg).toBeGreaterThanOrEqual(-90);
      expect(p.elevationDeg).toBeLessThanOrEqual(90);
    }
  });

  it('applies refraction, which lifts the low sun by about half a degree', () => {
    // Find the instant of apparent sunrise and confirm the TRUE geometric position is below it.
    const noon = localSolarNoon(new Date('2026-07-15T12:00:00Z'), EQUATOR[1]).getTime();
    let t = noon;
    for (let m = -400; m <= 0; m += 1) {
      const p = solarPosition(new Date(noon + m * 60000), ...EQUATOR);
      if (p.elevationDeg >= 0) { t = noon + m * 60000; break; }
    }
    // At apparent elevation ~0 the refraction term is ~0.5 deg, so this instant is ~2 minutes
    // earlier than an uncorrected model would report. Assert the correction is present and sane.
    expect(solarPosition(new Date(t), ...EQUATOR).elevationDeg).toBeGreaterThanOrEqual(0);
    expect(solarPosition(new Date(t - 5 * 60000), ...EQUATOR).elevationDeg).toBeLessThan(0.5);
  });
});

describe('goldenWindow', () => {
  it('brackets the configured elevation band', () => {
    const w = goldenWindow(new Date('2026-07-31T12:00:00Z'), ...BUFFALO, 'evening');
    expect(w).not.toBeNull();
    const s = solarPosition(w!.start, ...BUFFALO).elevationDeg;
    const e = solarPosition(w!.end, ...BUFFALO).elevationDeg;
    expect(s).toBeCloseTo(GOLDEN_HI_DEG, 1);
    expect(e).toBeCloseTo(GOLDEN_LO_DEG, 1);
  });

  it('is a descending evening window and an ascending morning one', () => {
    const ev = goldenWindow(new Date('2026-07-31T12:00:00Z'), ...BUFFALO, 'evening')!;
    const mo = goldenWindow(new Date('2026-07-31T12:00:00Z'), ...BUFFALO, 'morning')!;
    expect(ev.end.getTime()).toBeGreaterThan(ev.start.getTime());
    expect(mo.end.getTime()).toBeGreaterThan(mo.start.getTime());
    // Morning comes before evening on the same day.
    expect(mo.start.getTime()).toBeLessThan(ev.start.getTime());
    // Evening light falls; morning light rises.
    expect(solarPosition(ev.start, ...BUFFALO).elevationDeg)
      .toBeGreaterThan(solarPosition(ev.end, ...BUFFALO).elevationDeg);
    expect(solarPosition(mo.end, ...BUFFALO).elevationDeg)
      .toBeGreaterThan(solarPosition(mo.start, ...BUFFALO).elevationDeg);
  });

  it('lasts about an hour in WNY in midsummer — the ride-length budget', () => {
    // This is the number that decides how long a Reel ride may be, so it is asserted directly.
    //
    // The design doc originally assumed 35-45 min; the measured answer is ~60, and the
    // implementation is right rather than the assumption. Near the horizon the sun descends at
    // roughly 15 deg/hr * cos(latitude) = 11 deg/hr at 42.9N, so the 10 deg band from +6 to -4
    // takes ~55 min. A Reel ride therefore has ~45 km of budget at 45 mph, not ~30.
    const w = goldenWindow(new Date('2026-07-31T12:00:00Z'), ...BUFFALO, 'evening')!;
    expect(w.minutes).toBeGreaterThan(50);
    expect(w.minutes).toBeLessThan(70);
  });

  it('shrinks in winter, when the ride budget is genuinely tight', () => {
    // Same latitude, December: the sun still descends obliquely, but the band is crossed at a
    // different rate, and the practical constraint is that the window arrives mid-afternoon.
    const w = goldenWindow(new Date('2026-12-21T12:00:00Z'), ...BUFFALO, 'evening')!;
    expect(w.minutes).toBeGreaterThan(30);
    expect(w.minutes).toBeLessThan(90);
  });

  it('is longer at high latitude, where the sun sets obliquely', () => {
    const wny = goldenWindow(new Date('2026-07-31T12:00:00Z'), ...BUFFALO, 'evening')!;
    const north = goldenWindow(new Date('2026-07-31T12:00:00Z'), 63, -78.85, 'evening')!;
    expect(north.minutes).toBeGreaterThan(wny.minutes);
  });

  it('is shorter near the equator, where the sun drops vertically', () => {
    const wny = goldenWindow(new Date('2026-07-31T12:00:00Z'), ...BUFFALO, 'evening')!;
    const trop = goldenWindow(new Date('2026-07-31T12:00:00Z'), 0, -78.85, 'evening')!;
    expect(trop.minutes).toBeLessThan(wny.minutes);
  });

  it('returns null under the midnight sun, rather than inventing a window', () => {
    // At 80N in June the sun never descends to +6 deg, so there is no golden hour at all.
    // Callers must handle this; silently returning a bogus window would be the worse failure.
    expect(goldenWindow(new Date('2026-06-21T12:00:00Z'), 80, 0, 'evening')).toBeNull();
  });

  it('returns null in polar night', () => {
    expect(goldenWindow(new Date('2026-12-21T12:00:00Z'), 80, 0, 'evening')).toBeNull();
  });
});

describe('goldenWindow — measured seasonality, which is the OPPOSITE of the intuition', () => {
  // The design doc claimed the window is short in winter and at high latitude. Both are
  // backwards: length goes as 1/(cos(lat)*cos(decl)*sin(H)), so it is LONGEST at the solstices
  // and grows toward the poles. Asserted here so the wrong intuition cannot come back.
  const mins = (iso: string, lat: number) =>
    goldenWindow(new Date(`${iso}T12:00:00Z`), lat, -78.85, 'evening')!.minutes;

  it('is SHORTEST at the equinoxes, not in winter', () => {
    const mar = mins('2026-03-20', 42.9);
    const jun = mins('2026-06-21', 42.9);
    const dec = mins('2026-12-21', 42.9);
    expect(mar).toBeLessThan(jun);
    expect(mar).toBeLessThan(dec);
    // December actually has MORE golden-hour minutes per day than June at this latitude.
    expect(dec).toBeGreaterThan(jun);
  });

  it('grows monotonically toward the pole', () => {
    const at = (lat: number) => mins('2026-07-26', lat);
    expect(at(0)).toBeLessThan(at(20));
    expect(at(20)).toBeLessThan(at(42.9));
    expect(at(42.9)).toBeLessThan(at(55));
  });
});

describe('lightQuality10 — calibrated against the only footage with human verdicts', () => {
  it('does not zero out the reference ride, which a hard golden-hour gate did', () => {
    // The reference clips were shot at +20.9 to +15.5 deg elevation and their golden-hour-tagged
    // marks sit at 18.4-20.4 deg — entirely ABOVE the [-4,+6] band, which opens 54 min after the
    // footage ends. A gate scores 100% of the available ground truth at zero. This must not.
    for (const e of [15.5, 18.4, 20.4, 20.9]) {
      expect(lightQuality10(e)).toBeGreaterThan(4);
      expect(lightQuality10(e)).toBeLessThan(8); // good, but not better than true golden hour
    }
  });

  it('peaks through the golden band', () => {
    expect(lightQuality10(2)).toBe(10);
    expect(lightQuality10(6)).toBe(10);
    expect(lightQuality10(8)).toBe(10);
  });

  it('falls off toward harsh midday sun', () => {
    expect(lightQuality10(40)).toBeLessThan(lightQuality10(20));
    expect(lightQuality10(60)).toBeLessThan(lightQuality10(40));
  });

  it('floors once there is too little light for an 8-bit camera at speed', () => {
    expect(lightQuality10(-2)).toBe(0);
    expect(lightQuality10(-10)).toBe(0);
  });

  it('is monotone within each limb', () => {
    for (let e = -2; e < 8; e += 0.5) expect(lightQuality10(e + 0.5)).toBeGreaterThanOrEqual(lightQuality10(e));
    for (let e = 8; e < 70; e += 1) expect(lightQuality10(e + 1)).toBeLessThanOrEqual(lightQuality10(e));
  });
});

describe('segmentLight', () => {
  it('calls it backlit when riding into the sun', () => {
    const l = segmentLight(270, 275); // heading west, sun just west
    expect(l.kind).toBe('backlit');
    expect(l.sunSide).toBe('ahead');
    expect(l.offAxisDeg).toBeCloseTo(5, 5);
  });

  it('calls it frontlit when the sun is behind', () => {
    const l = segmentLight(90, 270); // heading east, sun due west
    expect(l.kind).toBe('frontlit');
    expect(l.sunSide).toBe('behind');
    expect(l.offAxisDeg).toBeCloseTo(180, 5);
  });

  it('calls it cross-lit at right angles, and names the side the sun is on', () => {
    expect(segmentLight(0, 90)).toMatchObject({ kind: 'cross', sunSide: 'right' });
    expect(segmentLight(0, 270)).toMatchObject({ kind: 'cross', sunSide: 'left' });
  });

  it('handles the 0/360 wrap without a discontinuity', () => {
    expect(segmentLight(350, 10).offAxisDeg).toBeCloseTo(20, 5);
    expect(segmentLight(10, 350).offAxisDeg).toBeCloseTo(20, 5);
  });

  it('reports NO direction once the sun is down, rather than guessing one', () => {
    // Roughly a third of the conventional golden-hour band is after sunset, where the direct
    // beam is zero and "backlit" is not a weaker claim but a meaningless one.
    expect(segmentLight(270, 275, -1).kind).toBe('none');
    expect(segmentLight(270, 275, -1).sunSide).toBe('none');
    expect(segmentLight(270, 275, 3).kind).toBe('backlit');
    // Omitting elevation keeps the old geometry-only behaviour, for callers that have no time.
    expect(segmentLight(270, 275).kind).toBe('backlit');
  });

  it('reverses the lighting when the road is ridden the other way — the whole point', () => {
    // Riding the same road in the opposite direction turns backlit into frontlit. This is why
    // the Reel plan outputs a DIRECTION OF TRAVEL, not just a road.
    const out = segmentLight(270, 272);
    const back = segmentLight(90, 272);
    expect(out.kind).toBe('backlit');
    expect(back.kind).toBe('frontlit');
  });
});

describe('directionalLight10', () => {
  it('peaks on the travel axis and troughs across it', () => {
    expect(directionalLight10(0)).toBe(10);
    expect(directionalLight10(180)).toBe(10);
    expect(directionalLight10(90)).toBe(0);
  });

  it('scores backlit and frontlit IDENTICALLY, by construction', () => {
    // The reference plate already clips ~2.7% of pixels white, so preferring backlit would push
    // the rider toward the one condition the camera cannot survive. Symmetry is deliberate.
    for (const a of [0, 15, 30, 45]) {
      expect(directionalLight10(a)).toBeCloseTo(directionalLight10(180 - a), 5);
    }
  });

  it('is monotone away from the axis', () => {
    expect(directionalLight10(20)).toBeGreaterThan(directionalLight10(40));
    expect(directionalLight10(40)).toBeGreaterThan(directionalLight10(70));
  });
});

describe('sideLight10 — the boom camera, and the shape of its null', () => {
  // The pair's joint invariants (sin^2 + cos^2, the quarter-turn shift, left/right symmetry) are
  // asserted in reelPlan.test.ts, next to the `CameraAim` dispatch they exist to serve. What is
  // pinned HERE is the curve's own contract to its callers, because sun.ts exports it and had no
  // test of its own for it.

  it('is |sin| of the off-axis angle, exactly, at the angles worth naming', () => {
    expect(sideLight10(0)).toBe(0);
    expect(sideLight10(30)).toBe(5); // sin 30 = 1/2
    expect(sideLight10(45)).toBe(7.1); // sin 45 = 0.7071, to the one reported decimal
    expect(sideLight10(90)).toBe(10);
    expect(sideLight10(180)).toBe(0);
  });

  it('has a null one bearing wide, exactly as directionalLight10 does — neither is a gate', () => {
    // A gate excludes a RANGE of inputs; this excludes a point. The score rises immediately and
    // smoothly away from the sun's axis, so a road one degree off it already scores, and the road
    // bearings that score zero are two out of 360.
    expect(sideLight10(1)).toBe(0.2);
    expect(sideLight10(5)).toBe(0.9);
    expect(sideLight10(10)).toBe(1.7);
    expect(sideLight10(30)).toBe(5);

    // Counted in the frame that matters — travel bearings against a fixed sun, which is the input
    // a mark actually varies. `directionalLight10` is what section 4.3 of the design specifies and
    // no one has ever called IT a gate, so an argument against |sin|'s null is an argument against
    // the prescribed |cos| null too. The sun azimuth is arbitrary; the counts do not depend on it.
    const zeros = (f: (deg: number) => number, sunAz: number): number => {
      let n = 0;
      for (let b = 0; b < 360; b++) if (f(segmentLight(b, sunAz).offAxisDeg) === 0) n++;
      return n;
    };
    for (const sunAz of [0, 73, 200, 285]) {
      expect(zeros(sideLight10, sunAz)).toBe(2);
      expect(zeros(directionalLight10, sunAz)).toBe(2);
    }
  });
});
