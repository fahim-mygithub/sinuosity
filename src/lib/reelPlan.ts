// The shoot-time planner: WHEN to be on the road, and WHICH WAY to ride it.
//
// These are the Reel category's two deliverables, because they are the only two things the rider
// can actually change. A road's bearing is fixed and the sun's position at a given instant is
// fixed; what is left is the hour you leave and the end you start from. Everything here is a thin
// layer over sun.ts, which owns all of the solar geometry and is validated by execution against
// NREL SPA (0.013 deg elevation over a year at Buffalo) and USNO. Nothing solar is recomputed here.
//
// TIMEZONE DISCIPLINE. sun.ts is deliberately timezone-free and takes absolute instants; this
// module keeps that property, accepting and returning `Date` and never a wall-clock string.
// Turning a rider's "Saturday evening" into an instant belongs in the UI layer. Doing it here would
// import a DST bug into tested code, and DST bugs are exactly the kind that pass every test written
// in July.

import type { LatLng } from './geometry';
import {
  directionalLight10,
  goldenWindow,
  lightQuality10,
  localSolarNoon,
  segmentLight,
  sideLight10,
  solarPosition,
  type LightWindow,
} from './sun';
import type { CameraAim, LightReading } from './reelTypes';

// ------------------------------------------------------------------------------------------------
// Tuning
// ------------------------------------------------------------------------------------------------

/**
 * The `lightQuality10` floor that defines the usable shooting stretch.
 *
 * The window is anchored on `goldenWindow` but is NOT gated on it, and that is a refutation rather
 * than a preference. The reference footage — the only footage with human verdicts attached — was
 * shot between +20.9 and +15.5 deg of solar elevation; its own five `golden-hour`-tagged marks sit
 * at 18.4-20.4 deg; and the [-4, +6] band does not open until 54 minutes AFTER that footage ends.
 * A hard gate scores 100% of the available ground truth at zero, which is not a tuning problem.
 *
 * So the floor comes from that footage instead of from the photographic convention. The footage's
 * WORST instant is its highest sun, +20.9 deg, which `lightQuality10` scores 5.6. A floor of 5.5
 * puts all of it inside the window with a tenth of a point to spare rather than balanced on the
 * boundary. The golden band still sits inside the window and is reported separately as the peak,
 * because it is a genuine optimum and a terrible threshold.
 *
 * The resulting window is long, and that is the honest answer rather than a bug: measured at 42.9N
 * it is 120 min at the equinox against the golden band's 54.4, and 189 min in December, when the
 * sun never climbs past 24.6 deg and the light is low and warm all afternoon.
 */
export const SHOOT_QUALITY_MIN = 5.5;

/**
 * Planning speed (km/h) for turning minutes of light into kilometres of road. 45 mph, the same
 * figure `WINDOW_M` is derived from in reelTypes.ts, so the two agree about what a minute of riding
 * is worth.
 *
 * The conversion is spelled out because it has been got wrong twice in this project's own design
 * doc, in the same way both times. Revision 1 read "40 min at 45 mph" as 30 km: 45 mph for 40 min
 * is 30 MILES, which is 48 km. Revision 2 then wrote the corrected golden-hour budget as "~45 km",
 * which is 45 miles wearing a kilometre label — 60 minutes at 45 mph is 72.4 km. The ~60-minute
 * golden band at 42.9N is therefore a ~72 km budget, not ~30 and not ~45.
 */
export const PLANNING_SPEED_KMH = 45 * 1.609344;

/**
 * A score gap this small (points out of 10) does not choose a direction of travel.
 *
 * One full reporting quantum, since `LightReading.score10` is rounded to one decimal. Two things
 * justify treating a difference that only exists in the last reported decimal as no difference at
 * all. Structurally it is not real: the two directions of one road differ by off-axis angle x and
 * 180 - x, and both aim functions are symmetric about 90 deg, so the underlying scores are
 * identical and any gap is a rounding artifact of the final `Math.round`. Empirically it could not
 * matter anyway — the ground truth for this whole feature is kappa = 0.53, a human who does not
 * agree with themselves to better than about 78%, so a tenth of a point is far below the noise
 * floor of anything that could ever validate it.
 */
const SCORE_TIE_TOL = 0.1;

/**
 * Float guard (deg) for "the sun is exactly abeam", not a physical tolerance.
 *
 * The two directions' off-axis angles are computed as x and 180 - x from the same subtraction, so
 * when the road is exactly perpendicular to the sun they agree to machine precision and the last
 * bit decides. This makes that case fall through to the documented final tiebreak instead. A wider,
 * physically-motivated tolerance would not remove the knife edge, only move it somewhere less
 * obvious, so no physical number is invented here.
 */
const ABEAM_EPS_DEG = 1e-9;

/**
 * Step (minutes) of the coarse scan that brackets the shoot window's edges.
 *
 * A scan rather than a direct crossing search because `lightQuality10` is UNIMODAL in elevation
 * with a flat top, not monotone, so a bisection over a whole half-day has no single sign change to
 * latch onto — `crossing` in sun.ts works only because elevation itself is monotone there. Scanning
 * treats the quality curve as a black box, which means this keeps working if that curve is ever
 * re-shaped, and re-shaping it is likely: it is calibrated against 32 human verdicts.
 *
 * One minute is fine enough not to miss a real edge. The sun's hour angle moves 0.25 deg/min, and
 * elevation moves more slowly still, so no stretch of usable light shorter than a minute exists at
 * any latitude where a window exists at all. Each edge is then refined by bisection inside its
 * bracketing minute, so the reported `minutes` is not quantised to 60 s.
 */
const SCAN_STEP_MIN = 1;

/** Minutes from solar noon to solar midnight — the span of one 'evening' or one 'morning'. */
const HALF_DAY_MIN = 720;

// ------------------------------------------------------------------------------------------------
// When to be there
// ------------------------------------------------------------------------------------------------

/**
 * The usable shooting stretch for one date, one place and one end of the day.
 *
 * Wider than the golden band on purpose (see {@link SHOOT_QUALITY_MIN}) with the golden band
 * reported inside it as the peak, so the UI can show a rider the whole stretch they can shoot in
 * and the part of it worth planning around, without the planner having to pretend that one of the
 * two is the only real answer.
 */
export interface ShootWindow {
  /** First usable instant. Absolute — see the timezone note at the top of this file. */
  start: Date;
  /** Last usable instant. */
  end: Date;
  /** Length of the window (min). */
  minutes: number;
  /** Road that fits inside `minutes` at {@link PLANNING_SPEED_KMH} (km) — the ride-length budget. */
  rideKm: number;
  /** The golden band, always inside [`start`, `end`], or null where the band is never crossed.
   *  Null is a real case rather than a failure: at 63N the sun does not reach -4 deg in June nor
   *  +6 deg in December, and there are still usable evenings at both. */
  golden: LightWindow | null;
  kind: 'evening' | 'morning';
  /** False when the sun never clears {@link SHOOT_QUALITY_MIN} at all — polar night, and anywhere
   *  the sun stays below the horizon all day. `start` and `end` are then both pinned to solar noon,
   *  which is the day's best light even when its best is nothing. */
  usable: boolean;
}

/**
 * Instants where `lightQuality10` is at or above {@link SHOOT_QUALITY_MIN}, within one half-day
 * measured outward from solar noon. Returns chronological bounds, or null if the floor is never
 * cleared.
 *
 * Searching outward from solar noon rather than from a clock time is inherited from sun.ts for the
 * same reason: solar noon is the one instant guaranteed to be inside the day's daylight when there
 * is any, so the search cannot latch onto the wrong side of midnight.
 */
function qualityStretch(
  noonMs: number,
  lat: number,
  lon: number,
  sign: 1 | -1,
): { start: number; end: number } | null {
  const q = (ms: number) => lightQuality10(solarPosition(new Date(ms), lat, lon).elevationDeg);

  let nearM = -1; // minutes from noon to the edge CLOSEST to noon
  let farM = -1; // …and to the edge furthest from it
  for (let m = 0; m <= HALF_DAY_MIN; m += SCAN_STEP_MIN) {
    if (q(noonMs + sign * m * 60000) >= SHOOT_QUALITY_MIN) {
      if (nearM < 0) nearM = m;
      farM = m;
    }
  }
  if (nearM < 0) return null;

  // Refine an edge inside the one minute that brackets it. `outM` is below the floor and `inM` is
  // above it, so the crossing is between them and 20 halvings put it within 60/2^20 s.
  const refine = (outM: number, inM: number) => {
    let out = noonMs + sign * outM * 60000;
    let inside = noonMs + sign * inM * 60000;
    for (let i = 0; i < 20; i++) {
      const mid = (out + inside) / 2;
      if (q(mid) >= SHOOT_QUALITY_MIN) inside = mid;
      else out = mid;
    }
    return inside;
  };

  // An edge sitting ON an endpoint of the half-day is a real boundary, not a crossing, and must not
  // be refined past it. Solar noon bounds evening from morning by definition; solar midnight is
  // where a polar-day window genuinely runs out of half-day rather than out of light.
  const near = nearM > 0 ? refine(nearM - SCAN_STEP_MIN, nearM) : noonMs;
  const far =
    farM < HALF_DAY_MIN ? refine(farM + SCAN_STEP_MIN, farM) : noonMs + sign * HALF_DAY_MIN * 60000;
  return sign > 0 ? { start: near, end: far } : { start: far, end: near };
}

/**
 * When to be out, on `date`, at `at`.
 *
 * The window is the union of the {@link SHOOT_QUALITY_MIN} stretch and the golden band, so the
 * golden band is contained by construction rather than by luck. The union is genuinely needed in
 * both directions: the quality floor opens the window ~66 min earlier than the band does at 42.9N
 * (the sun is still at ~21 deg), and the band closes it ~15 min later than the floor does (the
 * floor gives out at ~+0.2 deg of elevation while the band runs to -4).
 *
 * `date` selects the UTC day, exactly as `localSolarNoon` and `goldenWindow` use it; the time of
 * day within `date` is ignored. That is a deliberate consequence of staying timezone-free — this
 * function answers "which evening", and a caller near the date line must pick the UTC day they mean.
 *
 * Never returns null. A caller planning a shoot needs an anchor instant to show even when the
 * answer is "there is no light today", `goldenWindow` already returns null for the band, and making
 * every caller write the same two-branch check twice buys nothing; `usable` carries that fact.
 */
export function shootWindow(
  date: Date,
  at: LatLng,
  kind: 'evening' | 'morning' = 'evening',
): ShootWindow {
  const [lat, lon] = at;
  const noon = localSolarNoon(date, lon);
  const stretch = qualityStretch(noon.getTime(), lat, lon, kind === 'evening' ? 1 : -1);
  const golden = goldenWindow(date, lat, lon, kind);

  const starts: number[] = [];
  const ends: number[] = [];
  if (stretch) {
    starts.push(stretch.start);
    ends.push(stretch.end);
  }
  if (golden) {
    starts.push(golden.start.getTime());
    ends.push(golden.end.getTime());
  }
  if (!starts.length) {
    return { start: noon, end: noon, minutes: 0, rideKm: 0, golden: null, kind, usable: false };
  }

  const startMs = Math.min(...starts);
  const endMs = Math.max(...ends);
  const minutes = (endMs - startMs) / 60000;
  return {
    start: new Date(startMs),
    end: new Date(endMs),
    minutes,
    rideKm: (minutes / 60) * PLANNING_SPEED_KMH,
    golden,
    kind,
    usable: true,
  };
}

// ------------------------------------------------------------------------------------------------
// How it will be lit
// ------------------------------------------------------------------------------------------------

/** 0-10 aim alignment for the selected virtual camera. The two are |cos| and |sin| of the same
 *  angle and peak in opposite places on purpose — see `sideLight10` in sun.ts, which explains at
 *  length why that is not a sign error. */
function aimAlignment10(offAxisDeg: number, aim: CameraAim): number {
  return aim === 'forward' ? directionalLight10(offAxisDeg) : sideLight10(offAxisDeg);
}

/**
 * How one direction of travel is lit at one instant.
 *
 * `score10` is quality x aim, as `ReelMetrics.light` in reelTypes.ts specifies. A product rather
 * than a blend because quality is a CEILING and not a contribution: no amount of good geometry
 * rescues a road with no light on it, and the same instant's quality is near-constant across a
 * whole scan area, so it sets how good the evening can be while aim is what ranks marks against
 * each other. The weighting between the two is not measured — nothing in the ground truth could
 * separate them — so a product is used rather than an invented pair of coefficients.
 *
 * The failure mode this buys is named rather than hidden: a mark in perfect golden light with the
 * sun exactly on the travel axis scores ZERO under the `side` aim, because a side-on subject lit
 * axially is flat. That is the intended reading, not an oversight — but it is also the reason
 * `quality10` and `aim10` are both reported, so a UI can show that the light was fine and only the
 * geometry was wrong, which is a fact the rider can act on by riding a different road.
 */
export function lightAt(
  instant: Date,
  at: LatLng,
  travelBearingDeg: number,
  aim: CameraAim,
): LightReading {
  const [lat, lon] = at;
  const sun = solarPosition(instant, lat, lon);
  const seg = segmentLight(travelBearingDeg, sun.azimuthDeg, sun.elevationDeg);
  const quality10 = lightQuality10(sun.elevationDeg);
  const aim10 = aimAlignment10(seg.offAxisDeg, aim);
  return {
    quality10,
    aim10,
    // (quality10 * aim10 / 10) to one decimal; the /10 keeps the product on the same 0-10 scale.
    score10: Math.round(quality10 * aim10) / 10,
    offAxisDeg: seg.offAxisDeg,
    sunSide: seg.sunSide,
    sunElevationDeg: sun.elevationDeg,
    sunAzimuthDeg: sun.azimuthDeg,
  };
}

/**
 * Which way to ride a road at a given instant. Half the product.
 *
 * A rider cannot change a road's bearing, so this — plus {@link shootWindow} — is the whole of what
 * the category can actually hand them.
 *
 * ON THE TIEBREAK, which is not a corner case here but the entire mechanism. Riding a road the
 * other way turns an off-axis angle of x into 180 - x, and BOTH aim functions are symmetric about
 * 90 deg (|cos| by construction so backlit and frontlit score alike; |sin| by construction so
 * sun-on-the-left and sun-on-the-right score alike). The elevation term is the same instant at the
 * same place. So the two directions do not merely tie often — under the aim functions that exist
 * today they tie ALWAYS, exactly, and a naive "return the higher score" would return whichever the
 * comparison happened to see first and flicker between "ride it east" and "ride it west" on
 * re-render. The score comparison is kept first anyway, because it is what the function claims to
 * do and it is the branch that starts firing the day an asymmetric aim function is added.
 *
 * The tiebreak that decides it in practice is: put the sun BEHIND the rider, i.e. prefer the larger
 * off-axis angle. This is INVENTED, not measured — the reference footage is one direction of one
 * ride, so nothing in the ground truth separates the two — but it is the same argument sun.ts
 * already makes for refusing to REWARD backlit, applied where it costs nothing. The plate already
 * clips ~2.7% of its pixels white; riding into the disc puts it in the capture sphere so every
 * virtual angle inherits the clipping, and silhouettes the rider and engine, which are the subject.
 * With the scores equal there is nothing to trade away by avoiding that. Note it is applied even
 * after sunset, when `sunSide` is `none`: the afterglow is still brightest in the sun's azimuth,
 * so the argument survives the disc going down even though the classification does not.
 *
 * When even that ties — the road exactly abeam of the sun, so both directions are 90 deg off — the
 * answer is `forward`, the road's stored vertex order. Arbitrary, and deliberately arbitrary: it
 * is a fixed function of the input, which is the only property that matters once the two options
 * are genuinely indistinguishable.
 */
export function bestDirection(
  instant: Date,
  at: LatLng,
  bearingDeg: number,
  aim: CameraAim,
): { direction: 'forward' | 'reverse'; travelBearingDeg: number; light: LightReading } {
  const fwdBearing = ((bearingDeg % 360) + 360) % 360;
  const revBearing = (fwdBearing + 180) % 360;
  const fwd = lightAt(instant, at, fwdBearing, aim);
  const rev = lightAt(instant, at, revBearing, aim);

  const takeReverse =
    rev.score10 - fwd.score10 > SCORE_TIE_TOL
      ? true
      : fwd.score10 - rev.score10 > SCORE_TIE_TOL
        ? false
        : rev.offAxisDeg - fwd.offAxisDeg > ABEAM_EPS_DEG;

  return takeReverse
    ? { direction: 'reverse', travelBearingDeg: revBearing, light: rev }
    : { direction: 'forward', travelBearingDeg: fwdBearing, light: fwd };
}
