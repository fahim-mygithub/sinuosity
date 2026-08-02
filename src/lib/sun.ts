// Solar geometry for the Reel category — where the sun will be, and which way a road faces
// relative to it, at the moment the rider is actually there.
//
// This is what makes Reel a different question from Scan: Scan asks "is this road good?", Reel
// asks "is this road good AT 20:15 ON THE 15th, ridden WEST-to-EAST?". A rider cannot change a
// road's bearing, but they can change the direction they ride it and the time they start, so
// those two are the actual deliverables (see lightPlan in reelPlan.ts).
//
// Implementation is the NOAA Solar Calculator formulation (itself after Meeus, "Astronomical
// Algorithms" 2nd ed. ch. 25). Pure, no network, no dependency. Accuracy is ~0.01 deg for
// modern dates, which is far beyond what this needs — the deliverable is "be there around
// 20:15", so even a degree of error is invisible. The reason to use the real algorithm rather
// than a crude approximation is not precision, it is that the CHEAP approximations break near
// the horizon, and near the horizon is the entire subject here.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Sun position as seen from the ground. Azimuth is compass-convention (0 = N, clockwise),
 *  matching {@link import('./geometry').bearing} so the two can be differenced directly. */
export interface SolarPosition {
  /** APPARENT elevation above the horizon (deg), refraction-corrected — what you actually see. */
  elevationDeg: number;
  /** Compass azimuth of the sun (deg, 0 = N, 90 = E). */
  azimuthDeg: number;
}

/**
 * Atmospheric refraction correction (deg) for a true elevation, per the NOAA calculator.
 *
 * Not a nicety here: refraction is ~0.5 deg at the horizon — about one solar diameter — and
 * golden hour is DEFINED between -4 and +6 deg, so ignoring it would shift the window's start
 * by minutes. It is negligible high in the sky and the piecewise form reflects that.
 */
function refractionDeg(trueElevDeg: number): number {
  if (trueElevDeg > 85) return 0;
  const t = Math.tan(trueElevDeg * D2R);
  let arcsec: number;
  if (trueElevDeg > 5) {
    arcsec = 58.1 / t - 0.07 / t ** 3 + 0.000086 / t ** 5;
  } else if (trueElevDeg > -0.575) {
    const e = trueElevDeg;
    arcsec = 1735 + e * (-518.2 + e * (103.4 + e * (-12.79 + e * 0.711)));
  } else {
    arcsec = -20.772 / t;
  }
  return arcsec / 3600;
}

/** Julian Day for an instant. 2440587.5 is the JD of the Unix epoch. */
function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Solar elevation + azimuth for an instant at a location.
 *
 * `date` is an absolute instant (a JS Date is UTC internally), so this function is entirely
 * timezone-free — no DST trap can reach it. Converting a rider's "Saturday evening" into an
 * instant is the caller's job; see {@link localSolarNoon} for the anchor that makes it easy.
 */
export function solarPosition(date: Date, lat: number, lon: number): SolarPosition {
  const jd = julianDay(date);
  const T = (jd - 2451545) / 36525; // Julian centuries since J2000.0

  // Geometric mean longitude and anomaly of the Sun.
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  // Equation of centre → true longitude → apparent longitude (nutation + aberration).
  const C =
    Math.sin(M * D2R) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * D2R) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * D2R) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * D2R);

  // Obliquity of the ecliptic, with the nutation correction.
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * D2R);

  const decl = Math.asin(Math.sin(eps * D2R) * Math.sin(lambda * D2R)) * R2D;

  // Equation of time (minutes) — the difference between clock time and true solar time.
  const y = Math.tan((eps / 2) * D2R) ** 2;
  const eqTime =
    4 *
    R2D *
    (y * Math.sin(2 * L0 * D2R) -
      2 * e * Math.sin(M * D2R) +
      4 * e * y * Math.sin(M * D2R) * Math.cos(2 * L0 * D2R) -
      0.5 * y * y * Math.sin(4 * L0 * D2R) -
      1.25 * e * e * Math.sin(2 * M * D2R));

  // True solar time (minutes past local solar midnight) → hour angle.
  const utcMinutes = (date.getTime() / 60000) % 1440;
  const trueSolarMin = (utcMinutes + eqTime + 4 * lon + 1440) % 1440;
  const hourAngle = trueSolarMin / 4 - 180;

  const latR = lat * D2R;
  const declR = decl * D2R;
  const haR = hourAngle * D2R;

  const cosZenith =
    Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(haR);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)));
  const trueElev = 90 - zenith * R2D;

  // Azimuth, NOAA formulation: measured clockwise from north.
  const denom = Math.cos(latR) * Math.sin(zenith);
  let azimuth: number;
  if (Math.abs(denom) < 1e-9) {
    // Sun directly overhead / at a pole — azimuth is undefined; 180 is the conventional pick.
    azimuth = 180;
  } else {
    const c = Math.max(-1, Math.min(1, (Math.sin(latR) * Math.cos(zenith) - Math.sin(declR)) / denom));
    azimuth = hourAngle > 0 ? (Math.acos(c) * R2D + 180) % 360 : (540 - Math.acos(c) * R2D) % 360;
  }

  return { elevationDeg: trueElev + refractionDeg(trueElev), azimuthDeg: (azimuth + 360) % 360 };
}

/**
 * The instant of local solar noon on the UTC day containing `date`, at `lon`.
 *
 * This is the anchor the window search needs: solar noon is the one moment guaranteed to be
 * inside the day's daylight (when there is any), so searching outward from it cannot latch onto
 * the wrong side of midnight the way a fixed-clock-time start can.
 */
export function localSolarNoon(date: Date, lon: number): Date {
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  // Solar noon is when the hour angle is 0; approximate, then refine once against the actual
  // equation of time. One refinement is plenty — EoT changes by seconds per day.
  let guess = dayStart + (12 - lon / 15) * 3600000;
  for (let i = 0; i < 2; i++) {
    const d = new Date(guess);
    const jd = julianDay(d);
    const T = (jd - 2451545) / 36525;
    const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const ecc = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos((125.04 - 1934.136 * T) * D2R);
    const y = Math.tan((eps / 2) * D2R) ** 2;
    const eqTime =
      4 * R2D *
      (y * Math.sin(2 * L0 * D2R) - 2 * ecc * Math.sin(M * D2R) +
        4 * ecc * y * Math.sin(M * D2R) * Math.cos(2 * L0 * D2R) -
        0.5 * y * y * Math.sin(4 * L0 * D2R) - 1.25 * ecc * ecc * Math.sin(2 * M * D2R));
    guess = dayStart + (12 - lon / 15) * 3600000 - eqTime * 60000;
  }
  return new Date(guess);
}

/**
 * Golden-hour elevation band.
 *
 * These are a PHOTOGRAPHIC CONVENTION, not a physical constant — there is no natural boundary
 * at which light stops being golden, and published definitions vary (some use 0 to +6). -4 to
 * +6 is the widely used band (PhotoPills, SunCalc and others agree on the +6 top). Treated as a
 * tuning constant, exported so it is adjustable rather than buried.
 */
export const GOLDEN_LO_DEG = -4;
export const GOLDEN_HI_DEG = 6;

/** A usable stretch of light, as absolute instants. */
export interface LightWindow {
  start: Date;
  end: Date;
  /** Minutes of usable light — how much ride actually fits inside it. */
  minutes: number;
  kind: 'evening' | 'morning';
}

/**
 * Find the instant between `from` and `to` where apparent elevation crosses `targetDeg`.
 *
 * Bisection rather than an analytic inverse: elevation is monotone between solar noon and
 * midnight, which is exactly the interval every caller uses, and bisection is immune to the
 * quadrant bookkeeping that makes closed-form sunrise equations error-prone near the poles.
 * Returns null when the target is not crossed in the interval (polar day/night, or a target
 * the sun never reaches at this latitude and date).
 */
function crossing(from: Date, to: Date, lat: number, lon: number, targetDeg: number): Date | null {
  let lo = from.getTime();
  let hi = to.getTime();
  const fLo = solarPosition(new Date(lo), lat, lon).elevationDeg - targetDeg;
  const fHi = solarPosition(new Date(hi), lat, lon).elevationDeg - targetDeg;
  if (fLo === 0) return new Date(lo);
  if (fHi === 0) return new Date(hi);
  if (fLo > 0 === fHi > 0) return null; // no sign change ⇒ never crosses in this interval
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const fMid = solarPosition(new Date(mid), lat, lon).elevationDeg - targetDeg;
    if (fLo > 0 === fMid > 0) lo = mid;
    else hi = mid;
  }
  return new Date((lo + hi) / 2);
}

/**
 * The golden-hour window on the day containing `date`.
 *
 * Searches outward from solar noon so it cannot latch onto the wrong side of midnight. Returns
 * null where the band is never crossed — a real case at high latitude, and the reason callers
 * must handle "no usable window today" rather than assuming one exists.
 */
export function goldenWindow(
  date: Date,
  lat: number,
  lon: number,
  kind: 'evening' | 'morning' = 'evening',
): LightWindow | null {
  const noon = localSolarNoon(date, lon);
  const HALF_DAY = 12 * 3600000;
  const edge = new Date(noon.getTime() + (kind === 'evening' ? HALF_DAY : -HALF_DAY));
  const [a, b] = kind === 'evening' ? [noon, edge] : [edge, noon];

  const hi = crossing(a, b, lat, lon, GOLDEN_HI_DEG);
  const lo = crossing(a, b, lat, lon, GOLDEN_LO_DEG);
  if (!hi || !lo) return null;

  const start = kind === 'evening' ? hi : lo;
  const end = kind === 'evening' ? lo : hi;
  const minutes = (end.getTime() - start.getTime()) / 60000;
  if (!(minutes > 0)) return null;
  return { start, end, minutes, kind };
}

/**
 * 0–10 light quality from the sun's ELEVATION alone (direction is scored separately by
 * {@link directionalLight10}).
 *
 * This exists because gating on {@link goldenWindow} was measurably wrong. The reference ride
 * — the only footage with human verdicts attached — was shot between **+20.9° and +15.5°**,
 * and its five `golden-hour`-tagged marks sit at **18.4°–20.4°**. The golden band opens at
 * 20:02 local, *54 minutes after that footage ended*. So a hard [-4,+6] gate scores 100% of
 * the available ground truth at zero, which is a refutation, not a tuning problem.
 *
 * The honest reading is that the photographic golden hour is a genuine optimum but a terrible
 * THRESHOLD: usable, warm, directional light extends far above +6°, and a rider filming from a
 * moving bike needs light to expose by, not just light to admire. So this is a smooth
 * preference, calibrated so the reference footage lands around 5.5–7.3 ("good, not peak")
 * rather than at zero, and true golden hour still peaks at 10.
 *
 * Below about -2° there is not enough light for an 8-bit action camera at speed, so it floors.
 */
export function lightQuality10(elevationDeg: number): number {
  if (elevationDeg < -2) return 0;
  // Ramp up out of dusk, then decay as the sun climbs and the light flattens and cools.
  const dusk = 10 * Math.min(1, Math.max(0, (elevationDeg + 2) / 4));
  const high = 10 * Math.exp(-Math.max(0, elevationDeg - 8) / 22);
  return Math.round(Math.min(dusk, high) * 10) / 10;
}

/**
 * How a segment is lit, relative to the direction of travel. `none` means there is no direct
 * beam to have a direction — see {@link segmentLight}.
 */
export type LightKind = 'backlit' | 'frontlit' | 'cross' | 'none';

export interface SegmentLight {
  kind: LightKind;
  /** Absolute angle between the direction of travel and the sun, 0-180. 0 = straight into it. */
  offAxisDeg: number;
  /** Which side of the rider the sun is on — the lit side, and so the shadowed one. */
  sunSide: 'left' | 'right' | 'ahead' | 'behind' | 'none';
}

/** Directional-light band: within this many degrees of the travel axis reads as into/behind. */
const AXIAL_DEG = 45;

/**
 * Elevation below which there is no usable direct beam, so "which way is the sun" stops being a
 * meaningful question. Uses the geometric horizon rather than a lower twilight bound because
 * direct sunlight is what casts the shadows and flare the classification is about; once the disc
 * is down, the scene is lit by sky alone and is directionally flat.
 */
export const DIRECT_BEAM_MIN_DEG = 0;

/**
 * Classify how a segment is lit, given the direction of travel and the sun's azimuth.
 *
 * Deliberately does NOT rank the three lit cases. All three appear among the highest-scoring
 * marks in the reference footage, and the plate has ~2.7% of pixels already clipped white, so
 * scoring backlit highest would push the rider toward the one condition the camera cannot
 * survive. The score rewards DIRECTIONAL light over flat side-on light; the flavour is the
 * rider's call.
 *
 * `sunElevationDeg` is optional but should be passed: below the horizon the direct beam is zero,
 * so backlit/frontlit/cross is undefined rather than merely uncertain. Roughly a third of the
 * conventional golden-hour band sits after sunset, which is enough of the window to matter.
 *
 * NOTE this is the FLAT-EARTH horizon. In the gorges this feature is built to find, the sun
 * disappears behind the valley wall well before it reaches elevation 0 — measured horizon angles
 * of 2.0 deg at Zoar Valley and 3.1 deg at Letchworth, costing 42% and 59% of the direct-sun
 * window respectively, against 0 deg on the Genesee plain. A terrain horizon belongs here; until
 * it exists, treat low-elevation results in steep country as optimistic.
 */
export function segmentLight(
  travelBearingDeg: number,
  sunAzimuthDeg: number,
  sunElevationDeg?: number,
): SegmentLight {
  const signed = ((sunAzimuthDeg - travelBearingDeg + 540) % 360) - 180; // -180..180, +ve = sun to the right
  const offAxisDeg = Math.abs(signed);
  if (sunElevationDeg != null && sunElevationDeg < DIRECT_BEAM_MIN_DEG) {
    return { kind: 'none', offAxisDeg, sunSide: 'none' };
  }
  const kind: LightKind =
    offAxisDeg <= AXIAL_DEG ? 'backlit' : offAxisDeg >= 180 - AXIAL_DEG ? 'frontlit' : 'cross';
  const sunSide =
    kind === 'backlit' ? 'ahead' : kind === 'frontlit' ? 'behind' : signed > 0 ? 'right' : 'left';
  return { kind, offAxisDeg, sunSide };
}

/**
 * 0-10 "directional light" score for a segment.
 *
 * Peaks when the sun is near the travel AXIS (either into it or behind it) and troughs at 90
 * deg, where light rakes flatly across the road. Uses |cos| of the off-axis angle, which is
 * symmetric by construction — the design decision not to prefer backlit over frontlit is
 * expressed in the maths rather than left to a comment that a later edit could contradict.
 */
export function directionalLight10(offAxisDeg: number): number {
  return Math.round(Math.abs(Math.cos(offAxisDeg * D2R)) * 10 * 10) / 10;
}

/**
 * 0-10 "cross light" score for a segment, for the boom camera.
 *
 * This is |sin| where its immediate neighbour {@link directionalLight10} is |cos|, so the two peak
 * and trough in exactly opposite places. That is deliberate and is not a sign error — assume it is
 * one and you will "fix" the wrong camera. They serve two virtual angles with opposite needs. The
 * forward and rear angles look ALONG the road, so they want the sun near the travel axis, and |cos|
 * is right for them. The rig actually mounted here is an Insta360 on a boom out to the RIGHT,
 * filming a side profile of rider and engine across the road, and a subject viewed side-on is
 * SCULPTED by cross light and rendered FLAT by axial light. So the side camera peaks at 90 deg
 * off-axis, precisely where the forward camera troughs. Both scores are reported; the caller
 * chooses with `CameraAim` rather than one of them being silently preferred here.
 *
 * |sin| is symmetric about 90 deg in the same way |cos| is symmetric about 90, so sun-on-the-left
 * (a rim-lit silhouette against the backdrop) and sun-on-the-right (the camera side lit) score
 * IDENTICALLY by construction, and {@link segmentLight}'s `sunSide` tells the rider which of the
 * two they are getting. That is the same stance {@link directionalLight10} already takes on backlit
 * versus frontlit, and it is taken for the same reason: the reference plate already clips ~2.7% of
 * its pixels white, so steering the rider toward the prettier of the two would steer them into the
 * one condition the camera cannot survive.
 */
export function sideLight10(offAxisDeg: number): number {
  return Math.round(Math.abs(Math.sin(offAxisDeg * D2R)) * 10 * 10) / 10;
}
