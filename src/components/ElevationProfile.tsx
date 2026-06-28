import { useEffect, useState } from 'react';
import {
  sampleAlong,
  fetchElevations,
  buildElevationProfile,
  type ElevationProfile as Profile,
} from '../lib/elevation';
import { distanceValue, distanceLabel } from '../lib/units';
import type { Units } from '../lib/preferences';
import type { LatLng } from '../lib/geometry';

const W = 320;
const H = 96;
const PAD = 6;
const M_TO_FT = 3.28084;

/**
 * Per-ride elevation profile for the cruise page. Fetches a terrain profile for the ride's line
 * (keyless Open-Meteo, one batched request) on open and draws it as a filled SVG area chart with
 * total climb / relief / max grade. Strictly additive and graceful: if the lookup is unavailable
 * the whole section renders nothing (it never blocks the page). Makes the grade-drama signal the
 * scan already measures actually visible.
 */
export function ElevationProfile({ coords, units }: { coords: LatLng[]; units: Units }) {
  const [state, setState] = useState<'loading' | 'ready' | 'none'>('loading');
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const pts = sampleAlong(coords, { spacingKm: 0.5, minN: 8, maxN: 90 }); // ≤100 = one request
    if (pts.length < 2) {
      setState('none');
      return;
    }
    setState('loading');
    fetchElevations(pts, ctrl.signal).then((elev) => {
      if (cancelled) return;
      const p = elev ? buildElevationProfile(pts, elev, W, H, PAD) : null;
      if (!p) {
        setState('none');
        return;
      }
      setProfile(p);
      setState('ready');
    });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [coords]);

  if (state === 'none') return null;

  const toFeet = units === 'mi';
  const conv = (m: number) => Math.round(toFeet ? m * M_TO_FT : m);
  const eUnit = toFeet ? 'ft' : 'm';

  return (
    <section className="mt-10">
      <h2 className="text-xs uppercase tracking-[0.2em] text-emerald-400 after:block after:h-px after:bg-white/10 after:mt-3">
        Elevation
      </h2>
      <div className="mt-6 bg-slate-900/60 ring-1 ring-white/5 rounded-2xl p-5">
        {state === 'loading' || !profile ? (
          <div className="h-24 grid place-items-center text-[11px] text-slate-500">
            <span className="motion-safe:animate-pulse">Reading terrain…</span>
          </div>
        ) : (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24" preserveAspectRatio="none" aria-hidden>
              <defs>
                <linearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path d={profile.area} fill="url(#elevFill)" />
              <polyline
                points={profile.line}
                fill="none"
                stroke="#34d399"
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <dl className="mt-4 grid grid-cols-3 divide-x divide-white/10 text-center">
              <div className="px-2">
                <dd className="font-mono text-lg font-black text-slate-100">+{conv(profile.metrics.totalAscentM)} {eUnit}</dd>
                <dt className="text-[10px] uppercase tracking-wider text-slate-400 mt-0.5">total climb</dt>
              </div>
              <div className="px-2">
                <dd className="font-mono text-lg font-black text-slate-100">{conv(profile.metrics.reliefM)} {eUnit}</dd>
                <dt className="text-[10px] uppercase tracking-wider text-slate-400 mt-0.5">relief</dt>
              </div>
              <div className="px-2">
                <dd className="font-mono text-lg font-black text-slate-100">{profile.metrics.maxGradePct.toFixed(0)}%</dd>
                <dt className="text-[10px] uppercase tracking-wider text-slate-400 mt-0.5">max grade</dt>
              </div>
            </dl>
            <p className="mt-3 text-[10px] text-slate-500 text-center">
              Terrain sampled from Open-Meteo over {distanceValue(profile.lengthKm, units)} {distanceLabel(units)}.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
