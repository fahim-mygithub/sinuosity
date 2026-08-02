import { describe, it, expect } from 'vitest';
import {
  directionalLight10,
  goldenWindow,
  lightQuality10,
  localSolarNoon,
  sideLight10,
  solarPosition,
  GOLDEN_HI_DEG,
  GOLDEN_LO_DEG,
} from './sun';
import {
  bestDirection,
  lightAt,
  shootWindow,
  PLANNING_SPEED_KMH,
  SHOOT_QUALITY_MIN,
} from './reelPlan';
import { reelComposite } from './reelScore';
import { REEL_WEIGHTS, type ReelMetrics } from './reelTypes';

// Like sun.test.ts, these check FIRST PRINCIPLES rather than the implementation's own output.
// The solar geometry itself is already validated there against NREL SPA and USNO, so what is left
// to prove here is the planner's arithmetic and its editorial decisions: that the window is not
// secretly a golden-hour gate, that its length moves with latitude and season in the direction
// measurement says it does (revision 1 of the design doc had both backwards), that the two aim
// functions are wired to the two cameras the right way round, and that a direction of travel comes
// out the same way twice.
//
// `sideLight10` lives in sun.ts but is exercised here because it exists only to serve the `side`
// camera aim that this module dispatches on, and because its relationship to `directionalLight10`
// is the thing most likely to be "corrected" by someone who assumes one of them is a typo.

const BUF: [number, number] = [42.9, -78.85]; // the app's home region
const LON = BUF[1];
const D2R = Math.PI / 180;

const noonMs = (iso: string, lon = LON) => localSolarNoon(new Date(`${iso}T12:00:00Z`), lon).getTime();
const at = (iso: string, minutesFromNoon: number) => new Date(noonMs(iso) + minutesFromNoon * 60000);

/**
 * How many minutes the sun needs to fall through the golden band, FROM SPHERICAL ASTRONOMY.
 *
 * Differentiate the altitude equation at fixed declination,
 *
 *     sin h = sin(phi) sin(dec) + cos(phi) cos(dec) cos(H),   H advancing at 15 deg/hour,
 *
 * and substitute the azimuth identity cos(h) sin(A) = -cos(dec) sin(H). Declination, hour angle
 * and altitude all cancel, leaving
 *
 *     |dh/dt| = 15 * cos(phi) * |sin(A)|   deg/hour,
 *
 * so the descent rate depends only on the observer's latitude and the sun's azimuth. It is fastest
 * when the sun sets due west and slows as the set point swings north or south — which is the SAME
 * FACT as all three orderings asserted below: shortest at the equinoxes (A ~ 270), longest at the
 * solstices (A ~ 302 in June, ~237 in December), growing toward the poles (cos phi shrinks and a
 * summer A swings further north at the same time).
 *
 * The envelope arithmetic a reader can check without running anything: at 42.9N with the sun near
 * due west, 15 * cos(42.9) = 11.0 deg/hour, so 10 deg of band is 10/11.0 h = 55 min.
 */
function bandMinutesFromAstronomy(latDeg: number, sunAzimuthDeg: number): number {
  const degPerHour = 15 * Math.cos(latDeg * D2R) * Math.abs(Math.sin(sunAzimuthDeg * D2R));
  return (60 * (GOLDEN_HI_DEG - GOLDEN_LO_DEG)) / degPerHour;
}

/** The sun's azimuth as it passes `elevDeg` on the evening of `iso` — scanned straight off
 *  `solarPosition`, which is validated against NREL SPA, so the prediction below owes nothing to
 *  `goldenWindow`'s own output. */
function eveningAzimuthAt(iso: string, lat: number, elevDeg: number): number {
  const noon = noonMs(iso);
  for (let s = 0; s <= 20 * 3600; s += 20) {
    const p = solarPosition(new Date(noon + s * 1000), lat, LON);
    if (p.elevationDeg <= elevDeg) return p.azimuthDeg;
  }
  throw new Error(`the sun never descends to ${elevDeg} deg at ${lat}N on ${iso}`);
}

/** Predicted band length for one evening, taking the azimuth at the MIDDLE of the band (+1 deg)
 *  as the single representative A. */
const predictedBandMin = (iso: string, lat: number): number =>
  bandMinutesFromAstronomy(lat, eveningAzimuthAt(iso, lat, (GOLDEN_LO_DEG + GOLDEN_HI_DEG) / 2));

/**
 * How far `goldenWindow` may sit from that prediction.
 *
 * The derivation is EXACT for a fixed declination and a fixed azimuth. What it drops is (a)
 * refraction, which narrows the true-elevation band behind the apparent one by ~0.8% — apparent
 * +6 is true +5.85 and apparent -4 is true -4.07 — (b) the azimuth swinging across the band rather
 * than holding its mid-band value (+-5 deg at 42.9N, +-14 deg at 63N), and (c) declination drifting
 * during the hour.
 *
 * Measured residual over the six evenings asserted here is -0.7% to +1.9%, so 10% is several times
 * the largest neglected term while still being far tighter than the ~20% a mis-stated band width
 * would produce. It is a bound on the physics that was left out, not a fit to the residual: the
 * assertion has to be able to reject a wrong implementation, and a 25% tolerance would accept a
 * [-6,+6] band as readily as the [-4,+6] one that is specified.
 */
const BAND_TOL = 0.1;

/** Assert a measured band length against the astronomy rather than against a previous run. */
function expectMatchesAstronomy(actualMin: number, iso: string, lat: number): void {
  const ratio = actualMin / predictedBandMin(iso, lat);
  expect(ratio).toBeGreaterThan(1 - BAND_TOL);
  expect(ratio).toBeLessThan(1 + BAND_TOL);
}

/** The instant, on a given evening, when the sun is closest to due west. */
function dueWestInstant(iso: string): Date {
  const noon = noonMs(iso);
  let best = { d: Infinity, t: noon };
  for (let s = 0; s <= 600 * 60; s += 10) {
    const t = noon + s * 1000;
    const d = Math.abs(solarPosition(new Date(t), ...BUF).azimuthDeg - 270);
    if (d < best.d) best = { d, t };
  }
  return new Date(best.t);
}

describe('sideLight10 — the boom camera, and why it is the mirror of its neighbour', () => {
  it('peaks abeam and troughs on the axis — exactly where directionalLight10 does the opposite', () => {
    // A subject viewed side-on is sculpted by cross light and rendered flat by axial light, so the
    // side camera must peak at 90 deg. Asserted against directionalLight10 in the same expectation
    // so the two cannot silently drift apart, and so that anyone who "fixes" one has to look at
    // both.
    expect(sideLight10(90)).toBe(10);
    expect(directionalLight10(90)).toBe(0);
    expect(sideLight10(0)).toBe(0);
    expect(directionalLight10(0)).toBe(10);
    expect(sideLight10(180)).toBe(0);
    expect(directionalLight10(180)).toBe(10);
  });

  it('is the trigonometric complement of directionalLight10 at every angle', () => {
    // sin^2 + cos^2 = 1 is the reason the pair can be trusted to cover the sphere of aims between
    // them. Both are reported to one decimal, so each sits within 0.05 of its true value and the
    // sum of squares sits within ~1 of 100 — the tolerance is the reporting quantum, not slack.
    for (let a = 0; a <= 180; a += 3) {
      const s = sideLight10(a);
      const d = directionalLight10(a);
      expect(s * s + d * d).toBeGreaterThan(99);
      expect(s * s + d * d).toBeLessThan(101);
      // …and the two are the same curve shifted by a quarter turn.
      expect(Math.abs(s - directionalLight10(90 - a))).toBeLessThanOrEqual(0.1);
    }
  });

  it('moves in the opposite direction to directionalLight10 across the first quadrant', () => {
    for (let a = 0; a < 90; a += 5) {
      expect(sideLight10(a + 5)).toBeGreaterThanOrEqual(sideLight10(a));
      expect(directionalLight10(a + 5)).toBeLessThanOrEqual(directionalLight10(a));
    }
  });

  it('scores sun-on-the-left and sun-on-the-right identically, by construction', () => {
    // |sin| is symmetric about 90 exactly as |cos| is, so a rim-lit silhouette and a lit camera
    // side score the same and `segmentLight().sunSide` is what tells the rider which they get.
    // Preferring the prettier one would steer toward the condition that clips, which is the same
    // reason directionalLight10 refuses to prefer backlit over frontlit.
    for (let a = 0; a <= 90; a += 5) {
      expect(sideLight10(90 - a)).toBeCloseTo(sideLight10(90 + a), 1);
    }
  });
});

describe('shootWindow — anchored on the golden band, never gated by it', () => {
  it('contains the golden window, morning and evening, at every season', () => {
    for (const iso of ['2026-03-20', '2026-06-21', '2026-09-22', '2026-12-21', '2026-07-31']) {
      for (const kind of ['evening', 'morning'] as const) {
        const w = shootWindow(new Date(`${iso}T12:00:00Z`), BUF, kind);
        expect(w.usable).toBe(true);
        expect(w.golden).not.toBeNull();
        expect(w.start.getTime()).toBeLessThanOrEqual(w.golden!.start.getTime());
        expect(w.end.getTime()).toBeGreaterThanOrEqual(w.golden!.end.getTime());
        expect(w.minutes).toBeGreaterThan(w.golden!.minutes);
      }
    }
  });

  it('does NOT zero out the reference footage, which a hard [-4,+6] gate did', () => {
    // The refutation this whole design rests on. The only footage with human verdicts attached was
    // shot between +20.9 and +15.5 deg of solar elevation. On a Buffalo evening that stretch sits
    // entirely INSIDE the shoot window and entirely BEFORE the golden band opens — the design doc
    // measured that gap at 54 minutes on the footage's own date. A gate scores all of it at zero.
    const w = shootWindow(new Date('2026-07-31T12:00:00Z'), BUF, 'evening');
    const elevReaches = (target: number) => {
      const noon = noonMs('2026-07-31');
      for (let s = 0; s <= 600 * 60; s += 5) {
        const t = noon + s * 1000;
        if (solarPosition(new Date(t), ...BUF).elevationDeg <= target) return t;
      }
      throw new Error('never descends that far');
    };
    const footageStart = elevReaches(20.9);
    const footageEnd = elevReaches(15.5);

    expect(footageStart).toBeGreaterThanOrEqual(w.start.getTime());
    expect(footageEnd).toBeLessThanOrEqual(w.end.getTime());
    // …and all of it precedes the golden band, by roughly the measured 54 minutes.
    expect(footageEnd).toBeLessThan(w.golden!.start.getTime());
    const gapMin = (w.golden!.start.getTime() - footageEnd) / 60000;
    expect(gapMin).toBeGreaterThan(50);
    expect(gapMin).toBeLessThan(58);
  });

  it('holds the quality floor everywhere it is not covered by the golden band', () => {
    // The window is a union of two things, so this is what stops it from being padded with light
    // that belongs to neither: every interior instant is either above the floor or inside the band.
    const w = shootWindow(new Date('2026-07-31T12:00:00Z'), BUF, 'evening');
    for (let f = 0.02; f < 1; f += 0.02) {
      const t = w.start.getTime() + f * (w.end.getTime() - w.start.getTime());
      const inBand = t >= w.golden!.start.getTime() && t <= w.golden!.end.getTime();
      const q = lightQuality10(solarPosition(new Date(t), ...BUF).elevationDeg);
      expect(inBand || q >= SHOOT_QUALITY_MIN).toBe(true);
    }
    // …and the instants just outside it satisfy neither, so the edges are real crossings.
    for (const t of [w.start.getTime() - 120000, w.end.getTime() + 120000]) {
      const inBand = t >= w.golden!.start.getTime() && t <= w.golden!.end.getTime();
      const q = lightQuality10(solarPosition(new Date(t), ...BUF).elevationDeg);
      expect(inBand || q >= SHOOT_QUALITY_MIN).toBe(false);
    }
  });
});

describe('shootWindow — the measured seasonality, which revision 1 had backwards three ways', () => {
  // All three of these were stated the wrong way round in revision 1 of the design doc: it claimed
  // a 35-40 min window at 42.9N, short in winter, and shrinking toward the poles. Measurement says
  // ~60 min, LONGEST at the solstices, and GROWING toward the poles. Asserted on both the golden
  // band and the shoot window so neither can regress on its own.
  const win = (iso: string, lat: number) => shootWindow(new Date(`${iso}T12:00:00Z`), [lat, LON]);

  it('runs ~60 golden minutes at 42.9N, not 35-40', () => {
    const w = win('2026-07-31', 42.9);
    // The envelope check first, because it is the one a reader can do on paper: a 10 deg band at
    // 15 * cos(42.9) = 11.0 deg/hour is 55 minutes. Since |sin A| <= 1 that is the FASTEST the sun
    // can ever cross the band at this latitude, so it is the short end of the answer and any real
    // evening is at least that long. 35-40 min is not merely low; it is below the floor the
    // geometry allows, which is why no amount of re-measuring was going to rescue revision 1.
    //
    // The 5% of slack under it is refraction, which is the one thing that can push a measured
    // evening below the bound: the apparent [-4,+6] band spans only 9.92 deg of TRUE elevation
    // (apparent +6 is true +5.85, apparent -4 is true -4.07), and the equinox evening does land
    // 0.4% short of 54.6 for exactly that reason. The 1.3 above it is the year's whole obliquity
    // range at this latitude — 1/|sin A| peaks at 1.20 in December and 1.18 in June — plus margin.
    const dueWest = bandMinutesFromAstronomy(42.9, 270);
    expect(dueWest).toBeCloseTo(54.6, 1); // the arithmetic itself, so a typo in it cannot hide
    expect(w.golden!.minutes).toBeGreaterThan(dueWest * 0.95);
    expect(w.golden!.minutes).toBeLessThan(dueWest * 1.3);
    // …then the same value against the full prediction, with the July azimuth rather than due west.
    expectMatchesAstronomy(w.golden!.minutes, '2026-07-31', 42.9);
    // …and a loose absolute sanity band on top, which is what the headline claim actually says.
    expect(w.golden!.minutes).toBeGreaterThan(50);
    expect(w.golden!.minutes).toBeLessThan(70);
  });

  it('is SHORTEST at the equinoxes and LONGEST at the solstices', () => {
    const mar = win('2026-03-20', 42.9);
    const sep = win('2026-09-22', 42.9);
    const jun = win('2026-06-21', 42.9);
    const dec = win('2026-12-21', 42.9);

    // Each band length against the astronomy rather than against a previous run of this code.
    // Four evenings at one latitude differ ONLY through |sin A|, so this is also a check that the
    // seasonal spread has the right SIZE and not just the right sign: the mid-band azimuth is
    // ~269.7 at the March equinox, ~302.2 in June and ~236.5 in December, and 1/|sin A| of those
    // is 1.00 / 1.18 / 1.20 — which is the whole of the ~54 vs ~64 vs ~66 minute spread.
    expectMatchesAstronomy(mar.golden!.minutes, '2026-03-20', 42.9);
    expectMatchesAstronomy(sep.golden!.minutes, '2026-09-22', 42.9);
    expectMatchesAstronomy(jun.golden!.minutes, '2026-06-21', 42.9);
    expectMatchesAstronomy(dec.golden!.minutes, '2026-12-21', 42.9);

    // The ordering matters more than the values, because the ordering is what was got backwards.
    for (const eq of [mar, sep]) {
      expect(eq.golden!.minutes).toBeLessThan(jun.golden!.minutes);
      expect(eq.golden!.minutes).toBeLessThan(dec.golden!.minutes);
      expect(eq.minutes).toBeLessThan(jun.minutes);
      expect(eq.minutes).toBeLessThan(dec.minutes);
    }
    // December has MORE usable light per evening than June at this latitude — the low winter sun
    // spends the whole afternoon in the good part of the curve.
    expect(dec.golden!.minutes).toBeGreaterThan(jun.golden!.minutes);
    expect(dec.minutes).toBeGreaterThan(jun.minutes);
  });

  it('GROWS toward the pole, by the amount the astronomy says and not merely in sign', () => {
    const lats = [0, 20, 42.9, 55, 63];
    const mins = lats.map((lat) => win('2026-07-26', lat));
    for (let i = 1; i < lats.length; i++) {
      expect(mins[i].golden!.minutes).toBeGreaterThan(mins[i - 1].golden!.minutes);
      expect(mins[i].minutes).toBeGreaterThan(mins[i - 1].minutes);
      // The PREDICTION grows too, for a reason that has nothing to do with this module: both
      // factors of 15*cos(phi)*|sin A| shrink going north — cos(phi) directly, and |sin A| because
      // a July sun sets further round toward the north the further north you stand.
      expectMatchesAstronomy(mins[i].golden!.minutes, '2026-07-26', lats[i]);
      expect(predictedBandMin('2026-07-26', lats[i])).toBeGreaterThan(
        predictedBandMin('2026-07-26', lats[i - 1]),
      );
    }
    // The size of the effect, independently. The ratio of the two descent rates is
    //   [cos(0) * |sin 289.3|] / [cos(63) * |sin 314.9|] = 0.944 / (0.454 * 0.708) = 2.9,
    // using each latitude's own mid-band azimuth, so 63N should run about three times the
    // equatorial band. A factor of three is not something rounding or an off-by-one manufactures.
    // This is what the removed `toBeCloseTo(126.8, 1)` was standing in for.
    const north = mins[lats.indexOf(63)].golden!.minutes;
    expect(north / mins[0].golden!.minutes).toBeGreaterThan(2.5);
    expect(north / mins[0].golden!.minutes).toBeLessThan(3.5);
  });
});

describe('shootWindow — the degenerate latitudes, which must not throw', () => {
  it('still finds usable light under the midnight sun, where there is no golden band at all', () => {
    // At 80N in June the sun never descends to +6, so `goldenWindow` correctly returns null. The
    // light still gets materially better as the sun swings down toward 13 deg, and a rider standing
    // there has an evening worth shooting; refusing to report one would be the worse failure.
    const w = shootWindow(new Date('2026-06-21T12:00:00Z'), [80, 0], 'evening');
    expect(w.golden).toBeNull();
    expect(w.usable).toBe(true);
    expect(w.minutes).toBeGreaterThan(0);
    expect(w.end.getTime()).toBeGreaterThan(w.start.getTime());
    expect(goldenWindow(new Date('2026-06-21T12:00:00Z'), 80, 0, 'evening')).toBeNull();
    // Every instant inside it really does clear the floor.
    const mid = new Date((w.start.getTime() + w.end.getTime()) / 2);
    expect(lightQuality10(solarPosition(mid, 80, 0).elevationDeg)).toBeGreaterThanOrEqual(SHOOT_QUALITY_MIN);
  });

  it('reports no window in polar night, without throwing and without inventing one', () => {
    const w = shootWindow(new Date('2026-12-21T12:00:00Z'), [80, 0], 'evening');
    expect(w.usable).toBe(false);
    expect(w.minutes).toBe(0);
    expect(w.rideKm).toBe(0);
    expect(w.golden).toBeNull();
    expect(w.start.getTime()).toBe(w.end.getTime());
    // The anchor is solar noon — the day's best light, even when its best is nothing.
    expect(w.start.getTime()).toBeCloseTo(noonMs('2026-12-21', 0), -3);
    // Both ends of the day, and the morning path, behave the same way.
    expect(shootWindow(new Date('2026-12-21T12:00:00Z'), [80, 0], 'morning').usable).toBe(false);
  });
});

describe('shootWindow — the ride-length budget, whose arithmetic has been wrong twice', () => {
  it('converts minutes of light to kilometres of road at 45 mph', () => {
    // 45 mph is 72.42 km/h. Revision 1 of the design doc read "40 min at 45 mph" as 30 km; 45 mph
    // for 40 min is 30 MILES, which is 48 km. Revision 2 then wrote the corrected hour-long budget
    // as "~45 km", which is 45 miles wearing a kilometre label. Both are asserted against here so
    // the slip cannot come back a third time.
    expect(PLANNING_SPEED_KMH).toBeCloseTo(72.42, 2);
    expect(PLANNING_SPEED_KMH).toBeCloseTo(60 * 1.2070, 2); // 60 min of it, in km
    expect((40 / 60) * PLANNING_SPEED_KMH).toBeCloseTo(48.3, 1);
    expect((40 / 60) * PLANNING_SPEED_KMH).not.toBeCloseTo(30, 0);
    expect((60 / 60) * PLANNING_SPEED_KMH).not.toBeCloseTo(45, 0);
  });

  it('reports the budget consistently with the window it came from', () => {
    for (const iso of ['2026-03-20', '2026-07-31', '2026-12-21']) {
      const w = shootWindow(new Date(`${iso}T12:00:00Z`), BUF);
      expect(w.rideKm).toBeCloseTo((w.minutes / 60) * PLANNING_SPEED_KMH, 6);
    }
  });
});

describe('lightAt — the two aims are wired to the two cameras', () => {
  // One instant proves both halves: on 25 March at Buffalo the sun passes due west while it is
  // still 3.3 deg up, so `lightQuality10` is at its maximum of 10 and nothing else can mask the
  // geometry. A road running north-south is then exactly abeam of the sun; a road running east-west
  // is exactly along it. Those are the two extremes, and the two aims must swap places between them.
  const t = dueWestInstant('2026-03-25');

  it('puts the sun due west at full light quality — the premise of the next two assertions', () => {
    const p = solarPosition(t, ...BUF);
    expect(p.azimuthDeg).toBeCloseTo(270, 1);
    expect(lightQuality10(p.elevationDeg)).toBe(10);
  });

  it('scores a north-south road at maximum for SIDE and at zero for FORWARD', () => {
    // Sun abeam: cross light sculpts the side profile of rider and engine, and does nothing at all
    // for an angle looking up the road.
    const side = lightAt(t, BUF, 0, 'side');
    const forward = lightAt(t, BUF, 0, 'forward');
    expect(side.offAxisDeg).toBeCloseTo(90, 1);
    expect(side.aim10).toBe(10);
    expect(side.score10).toBe(10);
    expect(forward.aim10).toBe(0);
    expect(forward.score10).toBe(0);
  });

  it('scores an east-west road at maximum for FORWARD and at zero for SIDE', () => {
    // The exact converse, at the same instant with the same light: sun on the travel axis.
    const side = lightAt(t, BUF, 270, 'side');
    const forward = lightAt(t, BUF, 270, 'forward');
    expect(forward.offAxisDeg).toBeCloseTo(0, 1);
    expect(forward.aim10).toBe(10);
    expect(forward.score10).toBe(10);
    expect(side.aim10).toBe(0);
    // The named failure mode: perfect light, wrong geometry, and the side camera scores it zero
    // rather than being rescued by a floor. If a floor is ever added this fires loudly.
    expect(side.quality10).toBe(10);
    expect(side.score10).toBe(0);
  });

  it('is the product of quality and aim, on the same 0-10 scale', () => {
    for (const b of [0, 37, 90, 143, 200, 271, 355]) {
      for (const aim of ['side', 'forward'] as const) {
        const l = lightAt(t, BUF, b, aim);
        expect(l.score10).toBeCloseTo((l.quality10 * l.aim10) / 10, 1);
        expect(l.score10).toBeLessThanOrEqual(l.quality10);
      }
    }
  });

  it('reports no sun side once the disc is down, and floors the quality there', () => {
    const late = at('2026-07-31', 480); // well after sunset
    const l = lightAt(late, BUF, 90, 'side');
    expect(l.sunElevationDeg).toBeLessThan(0);
    expect(l.sunSide).toBe('none');
    expect(l.quality10).toBe(0);
    expect(l.score10).toBe(0);
  });
});

describe('a zero on the side aim costs points, it does not eliminate — reviewed and kept', () => {
  // THE CHALLENGE, recorded because it will be raised again. `sideLight10` is |sin| of the
  // off-axis angle, so a mark whose road runs exactly along the sun's azimuth scores ZERO on
  // `light`. That is a hard zero produced by a per-mark rule, which has the shape of the gate
  // structure section 3 of the design doc refuted, and a review asked whether it is one.
  //
  // IT IS NOT, on three counts, and the tests below are the three counts.
  //
  //  1. `directionalLight10` has the identical structure a quarter turn away — |cos| is zero when
  //     the road is exactly abeam of the sun — and section 4.3 of the design SPECIFIES |cos|. An
  //     argument that condemns the |sin| null condemns the prescribed |cos| null with it. Neither
  //     has ever been called a gate, and sun.test.ts pins that the two nulls are the same width.
  //  2. What section 3 refuted was a gate on ELEVATION. Elevation is near-constant across a scan
  //     area at one instant, so a threshold on it moves every mark in the scan together — which is
  //     how the [-4,+6] gate managed to score 100% of the available ground truth at zero. Off-axis
  //     angle varies mark to mark by construction; a zero there is the dimension discriminating,
  //     which is the entire reason `aim` ranks and `quality` only sets the ceiling.
  //  3. A gate REMOVES a candidate regardless of its other merits. `light` carries 0.2 of the
  //     composite, so the zero withholds 20 points of 100 and the mark keeps the other 80 and
  //     stays in the ranking, ahead of plenty of marks that are lit perfectly well.
  //
  // So the maths is left alone and no floor is invented. There is nothing that could calibrate one
  // — kappa = 0.53 — and `quality10` and `aim10` are already reported separately so a UI can tell
  // the rider that the light is fine and the ROAD faces the wrong way, which is a fact they can
  // act on by riding a different road. A floor would replace that with a number that means nothing.
  const t = dueWestInstant('2026-03-25');
  const sunAz = solarPosition(t, ...BUF).azimuthDeg;
  const strong: ReelMetrics = { backdrop: 10, cleanliness: 10, light: 0, drama: 10 };
  const weightSum =
    REEL_WEIGHTS.backdrop + REEL_WEIGHTS.cleanliness + REEL_WEIGHTS.light + REEL_WEIGHTS.drama;

  it('really does zero the light dimension for a road along the sun azimuth', () => {
    // The premise. Without this the rest of the block is arguing about a case that never occurs.
    const l = lightAt(t, BUF, sunAz, 'side');
    expect(l.offAxisDeg).toBeCloseTo(0, 3);
    expect(l.aim10).toBe(0);
    expect(l.score10).toBe(0);
    // …and the light itself is perfect, which is exactly the diagnosis the rider is owed.
    expect(l.quality10).toBe(10);
  });

  it('still gives that mark a finite composite worth 80 of the 100 points', () => {
    const score = reelComposite({ ...strong, light: lightAt(t, BUF, sunAz, 'side').score10 });
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBe(80);
    // The 20 it lost is the light weight's share and nothing more — so the cost of the zero is
    // bounded by the weight, which is what makes it a term rather than a gate.
    expect(reelComposite({ ...strong, light: 10 })).toBe(100);
    expect(reelComposite({ ...strong, light: 10 }) - score).toBeCloseTo(
      (REEL_WEIGHTS.light / weightSum) * 100,
      6,
    );
  });

  it('ranks that mark ABOVE one that is merely adequate everywhere, light included', () => {
    const axisAligned = reelComposite(strong);
    const adequate = reelComposite({ backdrop: 7, cleanliness: 7, light: 7, drama: 7 });
    const litButEmpty = reelComposite({ backdrop: 2, cleanliness: 2, light: 10, drama: 2 });
    expect(axisAligned).toBeGreaterThan(adequate);
    expect(axisAligned).toBeGreaterThan(litButEmpty);
    // …and it is IN the ranking rather than filtered out of it, which is the operative difference
    // between a weighted term and a gate.
    expect([adequate, litButEmpty, axisAligned].sort((a, b) => b - a)[0]).toBe(axisAligned);
  });

  it('keeps discriminating among marks that ALL score zero on light', () => {
    // The property a gate destroys: with the whole light dimension zeroed, the remaining three
    // still separate the field, and none of the marks collapses to zero.
    const scores = [10, 8, 6, 4, 2].map((v) =>
      reelComposite({ backdrop: v, cleanliness: v, light: 0, drama: v }),
    );
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1]);
    expect(scores[scores.length - 1]).toBeGreaterThan(0);
  });

  it('cannot drive a mark below what its other three dimensions already earned, at any bearing', () => {
    // Swept over every road bearing and both aims: `light` is only ever additive. There is no
    // bearing anywhere that subtracts from the backdrop, cleanliness and drama a mark has banked.
    for (let b = 0; b < 360; b += 5) {
      for (const aim of ['side', 'forward'] as const) {
        const s = reelComposite({ ...strong, light: lightAt(t, BUF, b, aim).score10 });
        expect(Number.isFinite(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(80);
      }
    }
  });
});

describe('bestDirection — which way to ride it', () => {
  it('sends the rider away from the sun, so the answer flips between morning and evening', () => {
    // A road stored west-to-east (bearing 90). In the evening the sun is in the west, so riding
    // EAST puts it behind; in the morning it is in the east, so riding WEST does. Same road, same
    // rider, opposite answer — which is the entire reason this function exists.
    const evening = at('2026-07-31', 300);
    const morning = at('2026-07-31', -300);

    const ev = bestDirection(evening, BUF, 90, 'side');
    expect(ev.direction).toBe('forward');
    expect(ev.travelBearingDeg).toBe(90);
    expect(ev.light.offAxisDeg).toBeGreaterThan(90); // sun behind

    const mo = bestDirection(morning, BUF, 90, 'side');
    expect(mo.direction).toBe('reverse');
    expect(mo.travelBearingDeg).toBe(270);
    expect(mo.light.offAxisDeg).toBeGreaterThan(90);
  });

  it('flips exactly as often as the sun crosses the road\'s perpendicular, and never oscillates', () => {
    // The recommendation changes when the sun passes abeam, so the number of changes in a day is a
    // fact of spherical astronomy and not of this code. Three cases pin it down:
    //
    //  - An EAST-WEST road is abeam of the sun when the sun is on the meridian, which happens once
    //    a day by definition. One flip, at solar noon.
    //  - A NORTH-SOUTH road is abeam when the sun is due east or due west. In summer at 42.9N the
    //    sun rises north of east and sets north of west, so it crosses the prime vertical twice.
    //  - The same north-south road in December never sees the sun leave the southern sky at all
    //    (it rises ~121 and sets ~239), so the sun is behind a northbound rider all day and the
    //    answer never changes.
    const flips = (iso: string, bearing: number) => {
      let n = 0;
      let prev: string | null = null;
      for (let m = -360; m <= 360; m += 10) {
        const d = bestDirection(at(iso, m), BUF, bearing, 'side').direction;
        if (prev !== null && d !== prev) n++;
        prev = d;
      }
      return n;
    };
    expect(flips('2026-07-31', 90)).toBe(1);
    expect(flips('2026-07-31', 0)).toBe(2);
    expect(flips('2026-12-21', 0)).toBe(0);
    // …and in that last case the constant answer is the one that keeps the southern sun behind a
    // rider heading north, rather than an arbitrary default.
    for (const m of [-300, 0, 300]) {
      const r = bestDirection(at('2026-12-21', m), BUF, 0, 'side');
      expect(r.direction).toBe('forward');
      expect(r.light.offAxisDeg).toBeGreaterThan(90);
    }
  });

  it('gives the same answer every time it is asked — no flicker on re-render', () => {
    // The two directions of a road score IDENTICALLY under both aims (see the next test), so the
    // answer rests entirely on the tiebreak. An unstable one would make the UI alternate between
    // "ride it east" and "ride it west" as the component re-renders.
    const t = at('2026-07-31', 240);
    const first = bestDirection(t, BUF, 117, 'side');
    for (let i = 0; i < 50; i++) {
      const again = bestDirection(new Date(t.getTime()), BUF, 117, 'side');
      expect(again.direction).toBe(first.direction);
      expect(again.travelBearingDeg).toBe(first.travelBearingDeg);
      expect(again.light.score10).toBe(first.light.score10);
    }
  });

  it('faces a genuine tie: both directions of a road always score the same', () => {
    // Riding the other way turns an off-axis angle of x into 180 - x, and BOTH aim functions are
    // symmetric about 90 by construction — |cos| so that backlit and frontlit are equal, |sin| so
    // that sun-left and sun-right are. Elevation is the same instant either way. So the scores are
    // not merely close, they are equal, and the tiebreak is the whole of the decision. If an
    // asymmetric aim function is ever added this fails, which is the point: the score comparison
    // in bestDirection would start doing real work and would need re-reading.
    for (let m = -300; m <= 300; m += 60) {
      const t = at('2026-07-31', m);
      for (const b of [0, 37, 90, 143]) {
        for (const aim of ['side', 'forward'] as const) {
          expect(lightAt(t, BUF, b, aim).score10).toBe(lightAt(t, BUF, b + 180, aim).score10);
        }
      }
    }
  });

  it('picks the same direction under either aim, because the tiebreak is aim-independent', () => {
    // A consequence of the tie above, recorded so it is a decision rather than a surprise: the aim
    // changes how good the shot is, never which way to ride. Only the sun's position does that.
    for (let m = -300; m <= 300; m += 30) {
      const t = at('2026-07-31', m);
      for (const b of [0, 45, 90, 135]) {
        expect(bestDirection(t, BUF, b, 'side').direction).toBe(
          bestDirection(t, BUF, b, 'forward').direction,
        );
      }
    }
  });

  it('normalises the bearing it was handed, and returns the reading for the bearing it chose', () => {
    const t = at('2026-07-31', 300);
    expect(bestDirection(t, BUF, 450, 'side').travelBearingDeg).toBe(90);
    expect(bestDirection(t, BUF, -270, 'side').travelBearingDeg).toBe(90);
    for (const b of [0, 90, 180, 270]) {
      const r = bestDirection(t, BUF, b, 'side');
      expect(r.travelBearingDeg).toBe(r.direction === 'forward' ? b : (b + 180) % 360);
      expect(r.light).toEqual(lightAt(t, BUF, r.travelBearingDeg, 'side'));
    }
  });

  it('never returns the worse-lit direction when one exists', () => {
    // Belt and braces on the ordering the function claims to implement, over a full sweep.
    for (let m = -330; m <= 330; m += 30) {
      const t = at('2026-07-31', m);
      for (let b = 0; b < 360; b += 15) {
        for (const aim of ['side', 'forward'] as const) {
          const r = bestDirection(t, BUF, b, aim);
          const other = lightAt(t, BUF, (r.travelBearingDeg + 180) % 360, aim);
          expect(r.light.score10).toBeGreaterThanOrEqual(other.score10 - 0.1);
        }
      }
    }
  });
});
