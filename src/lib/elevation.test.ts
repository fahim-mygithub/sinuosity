import { describe, it, expect, vi, afterEach } from 'vitest';
import { gradeMetrics, gradeDrama10, sampleAlong, fetchElevations, buildElevationProfile } from './elevation';
import { pathLength, type LatLng } from './geometry';

// Build a roughly straight N–S line with a controllable elevation profile.
function line(n: number, stepKm = 0.1): LatLng[] {
  const out: LatLng[] = [];
  const dLat = stepKm / 111; // ~111 km per degree latitude
  for (let i = 0; i < n; i++) out.push([42 + i * dLat, -78]);
  return out;
}

describe('buildElevationProfile', () => {
  it('returns null for fewer than two usable samples', () => {
    expect(buildElevationProfile([], [], 100, 40)).toBeNull();
    expect(buildElevationProfile(line(1), [10], 100, 40)).toBeNull();
  });

  it('fits the profile to the box: one point per sample, baseline-anchored area, true metrics', () => {
    const pts = line(5, 0.2); // 5 samples, ~0.8 km total
    const elev = [100, 120, 140, 160, 180]; // steady climb, 80 m relief
    const W = 200, H = 50, PAD = 4;
    const p = buildElevationProfile(pts, elev, W, H, PAD)!;
    expect(p).not.toBeNull();
    expect(p.line.split(' ')).toHaveLength(5); // one x,y per sample
    expect(p.minM).toBe(100);
    expect(p.maxM).toBe(180);
    expect(p.metrics.reliefM).toBe(80);
    expect(p.metrics.totalAscentM).toBe(80);
    // The highest point sits at the top inset; the lowest at the baseline.
    const ys = p.line.split(' ').map((s) => +s.split(',')[1]);
    expect(Math.min(...ys)).toBeCloseTo(PAD, 1); // peak (180 m) → top
    expect(Math.max(...ys)).toBeCloseTo(H - PAD, 1); // valley (100 m) → baseline
    // The filled area is a closed path that starts on the baseline (y = H − PAD) and ends with Z.
    expect(p.area.startsWith('M')).toBe(true);
    const firstY = +p.area.split(' ')[0].split(',')[1];
    expect(firstY).toBeCloseTo(H - PAD, 1);
    expect(p.area.endsWith('Z')).toBe(true);
  });

  it('handles a flat profile without dividing by zero', () => {
    const p = buildElevationProfile(line(4, 0.25), [200, 200, 200, 200], 120, 40)!;
    expect(p).not.toBeNull();
    expect(p.minM).toBe(200);
    expect(p.maxM).toBe(200);
    expect(p.metrics.reliefM).toBe(0);
    expect(p.line.split(' ').every((s) => Number.isFinite(+s.split(',')[1]))).toBe(true);
  });
});

describe('gradeMetrics', () => {
  it('measures relief, total ascent and max grade from a profile', () => {
    const pts = line(5, 0.1); // 100 m segments
    const elev = [100, 110, 105, 130, 130]; // +10, -5, +25, 0
    const m = gradeMetrics(pts, elev);
    expect(m.reliefM).toBe(30); // 130 - 100
    expect(m.totalAscentM).toBe(35); // 10 + 25
    // steepest pitch is +25 m over ~100 m = ~25%
    expect(m.maxGradePct).toBeGreaterThan(20);
    expect(m.maxGradePct).toBeLessThan(30);
  });

  it('ignores grade over sub-30 m noise segments', () => {
    // 5 m apart horizontally but a big elevation jump → must NOT count as a huge grade
    const pts: LatLng[] = [[42, -78], [42.000045, -78]]; // ~5 m
    const m = gradeMetrics(pts, [100, 150]);
    expect(m.maxGradePct).toBe(0);
    expect(m.reliefM).toBe(50); // relief still measured
  });

  it('is safe on degenerate input', () => {
    expect(gradeMetrics([], [])).toEqual({ reliefM: 0, totalAscentM: 0, maxGradePct: 0 });
    expect(gradeMetrics([[42, -78]], [100])).toEqual({ reliefM: 0, totalAscentM: 0, maxGradePct: 0 });
  });
});

describe('gradeDrama10', () => {
  it('rates a real gorge road (Zoar-like) high', () => {
    const score = gradeDrama10({ reliefM: 194, totalAscentM: 370, maxGradePct: 19.3 }, 24);
    expect(score).toBeGreaterThanOrEqual(8);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('rates a flat backroad near zero', () => {
    const score = gradeDrama10({ reliefM: 8, totalAscentM: 12, maxGradePct: 1.5 }, 10);
    expect(score).toBeLessThan(1.5);
  });

  it('is monotonic in steepness and bounded 0–10', () => {
    const mild = gradeDrama10({ reliefM: 50, totalAscentM: 80, maxGradePct: 5 }, 10);
    const steep = gradeDrama10({ reliefM: 180, totalAscentM: 300, maxGradePct: 14 }, 10);
    expect(steep).toBeGreaterThan(mild);
    const huge = gradeDrama10({ reliefM: 9999, totalAscentM: 9999, maxGradePct: 99 }, 5);
    expect(huge).toBeLessThanOrEqual(10);
    expect(gradeDrama10({ reliefM: 100, totalAscentM: 100, maxGradePct: 10 }, 0)).toBe(0);
  });
});

describe('sampleAlong', () => {
  it('returns evenly distance-spaced points within the requested bounds', () => {
    const coords = line(200, 0.05); // ~10 km of dense vertices
    const s = sampleAlong(coords, { spacingKm: 1, minN: 6, maxN: 30 });
    expect(s.length).toBeGreaterThanOrEqual(6);
    expect(s.length).toBeLessThanOrEqual(30);
    expect(s[0]).toEqual(coords[0]);
    expect(s[s.length - 1]).toEqual(coords[coords.length - 1]);
    // spacing should be ~1 km, far coarser than the 0.05 km raw vertices
    expect(pathLength([s[0], s[1]])).toBeGreaterThan(0.5);
  });

  it('passes through tiny inputs unchanged', () => {
    expect(sampleAlong([[42, -78], [42.1, -78]])).toHaveLength(2);
  });
});

describe('fetchElevations', () => {
  afterEach(() => vi.restoreAllMocks());

  it('batches ≤100 points and returns aligned elevations', async () => {
    const pts: LatLng[] = Array.from({ length: 150 }, (_, i) => [42 + i * 0.001, -78] as LatLng);
    const fetchMock = vi.fn(async (url: string) => {
      const count = (url.match(/latitude=([^&]+)/)![1].split(',')).length;
      return { ok: true, json: async () => ({ elevation: Array(count).fill(123) }) } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const elev = await fetchElevations(pts);
    expect(elev).toHaveLength(150);
    expect(fetchMock.mock.calls.length).toBe(2); // 100 + 50
  });

  it('returns null on a non-OK response (graceful degradation)', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }) as unknown as Response) as typeof fetch;
    expect(await fetchElevations([[42, -78]])).toBeNull();
  });

  it('returns null on a malformed/short payload', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ elevation: [1] }) }) as unknown as Response) as typeof fetch;
    expect(await fetchElevations([[42, -78], [42.1, -78]])).toBeNull();
  });

  it('never throws — a rejected fetch yields null', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    expect(await fetchElevations([[42, -78]])).toBeNull();
  });
});
