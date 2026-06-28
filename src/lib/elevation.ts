import { haversine, cumulativeKm, type LatLng } from './geometry';

/**
 * Elevation / grade awareness for the Live scan. The road network is 2D, so a road famous for
 * its CLIMB or DESCENT — a gorge run, a mountain pass — gets no credit from curvature or nearby
 * scenery alone (the Zoar Valley Rd miss). This module fetches a terrain profile for a road and
 * turns it into a 0–10 `gradeDrama` rubric dimension, MEASURED the same honest way the rest of the
 * rubric is.
 *
 * The fetch is strictly additive and degrades silently: {@link fetchElevations} returns `null` on
 * any failure, in which case the scan simply carries no elevation signal (every other dimension is
 * unaffected). No API key — the free Open-Meteo elevation API is CORS-friendly and keyless.
 */

/** Per-road terrain numbers measured from an elevation profile. */
export interface GradeMetrics {
  /** Top-to-bottom relief over the road (m). */
  reliefM: number;
  /** Sum of all uphill deltas along the road (m) — total climbing. */
  totalAscentM: number;
  /** Steepest sustained pitch (%), ignoring sub-{@link MIN_SEG_M} segments (elevation noise). */
  maxGradePct: number;
}

/** Grade over a horizontal run shorter than this (m) is elevation noise, not a real pitch. */
const MIN_SEG_M = 30;

/**
 * Measure {@link GradeMetrics} from a sampled polyline and its aligned elevations (same order; the
 * shorter length governs). Relief and total ascent come from the elevation sequence; max grade is
 * the steepest pitch over a real (≥ {@link MIN_SEG_M}) horizontal segment.
 */
export function gradeMetrics(points: LatLng[], elevations: number[]): GradeMetrics {
  const n = Math.min(points.length, elevations.length);
  if (n < 2) return { reliefM: 0, totalAscentM: 0, maxGradePct: 0 };

  let min = elevations[0];
  let max = elevations[0];
  let ascent = 0;
  let maxGrade = 0;
  for (let i = 1; i < n; i++) {
    const e = elevations[i];
    if (e < min) min = e;
    if (e > max) max = e;
    const delta = e - elevations[i - 1];
    if (delta > 0) ascent += delta;
    const distM = haversine(points[i - 1], points[i]) * 1000;
    if (distM >= MIN_SEG_M) {
      const grade = (Math.abs(delta) / distM) * 100;
      if (grade > maxGrade) maxGrade = grade;
    }
  }
  return {
    reliefM: max - min,
    totalAscentM: ascent,
    maxGradePct: maxGrade,
  };
}

// Full-marks reference points: a 15% pitch, 200 m of relief, 30 m of climb per km each saturate
// their term. Tuned so a real gorge road (Zoar: ~19% / 194 m / ~15 m·km⁻¹) lands ≈ 8–9 and a
// flat backroad lands near 0.
const FULL_GRADE_PCT = 15;
const FULL_RELIEF_M = 200;
const FULL_CLIMB_PER_KM = 30;
const W_GRADE = 0.4;
const W_RELIEF = 0.35;
const W_CLIMB = 0.25;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Map {@link GradeMetrics} onto the 0–10 rubric scale (one decimal), blending the steepest pitch,
 * the total relief, and how much climbing there is per km. Returns 0 for a non-positive length.
 */
export function gradeDrama10(m: GradeMetrics, lengthKm: number): number {
  if (!(lengthKm > 0)) return 0;
  const grade = clamp01(m.maxGradePct / FULL_GRADE_PCT);
  const relief = clamp01(m.reliefM / FULL_RELIEF_M);
  const climb = clamp01(m.totalAscentM / lengthKm / FULL_CLIMB_PER_KM);
  const raw = W_GRADE * grade + W_RELIEF * relief + W_CLIMB * climb;
  return Math.round(clamp01(raw) * 10 * 10) / 10;
}

export interface SampleOpts {
  /** Target ground spacing between samples (km). */
  spacingKm?: number;
  /** Floor / ceiling on the number of samples (keeps tiny roads sampled and huge roads bounded). */
  minN?: number;
  maxN?: number;
}

/**
 * Evenly sample a polyline by GROUND distance (not by raw vertex index, which clusters samples
 * where OSM digitized densely). Returns ~`spacingKm`-spaced points, between `minN` and `maxN` of
 * them. Used to keep the elevation lookup small while still resolving real pitches.
 */
export function sampleAlong(coords: LatLng[], opts: SampleOpts = {}): LatLng[] {
  const spacingKm = opts.spacingKm ?? 0.4;
  const minN = opts.minN ?? 6;
  const maxN = opts.maxN ?? 30;
  if (coords.length <= 2) return [...coords];
  const cum = cumulativeKm(coords);
  const total = cum[cum.length - 1];
  if (!(total > 0)) return [coords[0]];
  const n = Math.max(minN, Math.min(maxN, Math.round(total / spacingKm) + 1));
  const out: LatLng[] = [];
  let from = 0;
  for (let k = 0; k < n; k++) {
    const targetKm = (total * k) / (n - 1);
    // advance the cursor to the first vertex at/after the target distance
    while (from < cum.length - 1 && cum[from] < targetKm) from++;
    out.push(coords[Math.min(from, coords.length - 1)]);
  }
  return out;
}

const OPEN_METEO_ELEVATION = 'https://api.open-meteo.com/v1/elevation';
/** Open-Meteo accepts up to 100 coordinates per request. */
const MAX_PER_REQUEST = 100;
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/**
 * Fetch ground elevations (m) for each point via the free, keyless Open-Meteo elevation API,
 * batched ≤100 per request and run in parallel. Returns elevations aligned to `points`, or `null`
 * if anything goes wrong (network, non-OK, malformed/short payload, abort) — callers treat `null`
 * as "no elevation signal" and proceed. Never throws.
 */
export async function fetchElevations(points: LatLng[], signal?: AbortSignal): Promise<number[] | null> {
  if (!points.length) return [];
  try {
    const batches: LatLng[][] = [];
    for (let i = 0; i < points.length; i += MAX_PER_REQUEST) {
      batches.push(points.slice(i, i + MAX_PER_REQUEST));
    }
    const results = await Promise.all(
      batches.map(async (batch) => {
        const lat = batch.map((p) => round5(p[0])).join(',');
        const lon = batch.map((p) => round5(p[1])).join(',');
        const res = await fetch(`${OPEN_METEO_ELEVATION}?latitude=${lat}&longitude=${lon}`, { signal });
        if (!res.ok) return null;
        const data = (await res.json()) as { elevation?: number[] };
        const elev = data.elevation;
        if (!Array.isArray(elev) || elev.length !== batch.length) return null;
        if (!elev.every((e) => Number.isFinite(e))) return null;
        return elev;
      }),
    );
    if (results.some((r) => r === null)) return null;
    return results.flat() as number[];
  } catch {
    return null;
  }
}
