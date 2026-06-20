import { useEffect, useRef, useState } from 'react';
import { googleMapsUrl, appleMapsUrl } from '../lib/mapsUrl';
import {
  hasGoogleKey,
  streetViewStaticUrl,
  staticRouteSatelliteUrl,
  streetViewDeepLink,
} from '../lib/scenicImagery';
import { KIND_ICON, RUBRIC_LABELS } from '../lib/scenicMeta';
import type { LatLng } from '../lib/geometry';
import type { ScenicRoute, ScenicStop, ScenicRubric } from '../data/types';

/**
 * Full-page, editorial "review" for a scenic ride — opened when a route is picked.
 * A tall satellite hero (with the route drawn in emerald) anchors the page; below it the
 * rider scrolls a single comfortable column through the stats, the "why ride" pull-quote,
 * the summary + rubric, and each scenic stop as a large Street View frame. Imagery is the
 * point — this replaces the cramped 384px side-panel preview.
 *
 * No second Leaflet map: the live map stays behind at z-0, untouched. "Locate on map"
 * closes the overlay and flies the existing map to the stop (route stays drawn).
 */
export function ScenicRouteReview({
  route,
  onBack,
  onLocate,
}: {
  route: ScenicRoute;
  onBack: () => void;
  onLocate: (index: number, lat: number, lon: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heroRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const [heroPassed, setHeroPassed] = useState(false);
  const [showHint, setShowHint] = useState(true);
  const [heroFailed, setHeroFailed] = useState(false);
  const [heroLoaded, setHeroLoaded] = useState(false);

  const hero = staticRouteSatelliteUrl(route.coords, {
    size: '640x400',
    maptype: 'hybrid',
    stops: route.stops.map((s) => [s.lat, s.lon] as [number, number]),
  });
  const gmaps = googleMapsUrl(route.coords);
  const amaps = appleMapsUrl(route.coords);

  // Focus the back button on open; Esc closes.
  useEffect(() => {
    backRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  // Reveal the sticky-bar title only once the big hero title scrolls out of view.
  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setHeroPassed(!e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={scrollRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Review: ${route.name}`}
      onScroll={(e) => setShowHint((e.target as HTMLElement).scrollTop < 40)}
      className="fixed inset-0 z-[1400] bg-slate-950 text-slate-100 overflow-y-auto custom-scrollbar overscroll-contain animate-fadeIn"
    >
      {/* Sticky header */}
      <header
        className="sticky top-0 z-30 min-h-14 bg-slate-950/80 backdrop-blur-md border-b border-white/5 flex items-center gap-3 px-3 md:px-5 py-1.5"
        style={{ paddingTop: 'max(0.375rem, env(safe-area-inset-top))' }}
      >
        <button
          ref={backRef}
          onClick={onBack}
          className="h-11 px-3 -ml-1 inline-flex items-center gap-1.5 rounded-xl text-sm font-semibold text-slate-300 hover:text-emerald-400 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 transition-colors"
        >
          <span aria-hidden>←</span> All rides
        </button>
        <span
          className={`flex-1 min-w-0 text-sm font-semibold truncate transition-opacity duration-300 ${heroPassed ? 'opacity-100' : 'opacity-0'}`}
        >
          {route.name}
        </span>
        {/* Desktop CTAs */}
        <div className="hidden md:flex items-center gap-2 shrink-0">
          <a href={gmaps} target="_blank" rel="noopener noreferrer" className="h-10 px-3.5 inline-flex items-center rounded-xl bg-emerald-500 text-slate-950 text-[13px] font-bold hover:bg-emerald-400 active:scale-[.98] transition-all">Ride it · Google Maps</a>
          <a href={amaps} target="_blank" rel="noopener noreferrer" className="h-10 px-3.5 inline-flex items-center rounded-xl bg-slate-800 ring-1 ring-slate-700 text-[13px] font-bold hover:ring-emerald-500/40 active:scale-[.98] transition-all">Apple Maps</a>
        </div>
        {/* Mobile score pill */}
        <span className="md:hidden shrink-0 font-mono font-black text-emerald-400 bg-emerald-500/10 ring-1 ring-emerald-500/25 px-2.5 py-1 rounded-lg text-sm">{route.score}</span>
      </header>

      {/* Hero */}
      <section ref={heroRef} className="relative w-full h-[52vh] md:h-[58vh] min-h-[340px] max-h-[680px] overflow-hidden">
        {hero && !heroFailed ? (
          <>
            {/* SVG path shows while the satellite tile loads (no empty dark flash). */}
            {!heroLoaded && <HeroPlaceholder coords={route.coords} keyless={false} />}
            <img
              src={hero}
              alt={`Satellite map of ${route.name} with the route drawn in green`}
              decoding="async"
              onLoad={() => setHeroLoaded(true)}
              onError={() => setHeroFailed(true)}
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${heroLoaded ? 'opacity-100' : 'opacity-0'}`}
            />
          </>
        ) : (
          <HeroPlaceholder coords={route.coords} keyless={!hasGoogleKey()} />
        )}
        {/* Scrims */}
        <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-slate-950/60 to-transparent" aria-hidden />
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-slate-950 via-slate-950/70 to-transparent" aria-hidden />

        {/* Score disc (desktop) */}
        <div className="hidden md:block absolute top-20 right-8 bg-slate-950/40 backdrop-blur ring-1 ring-emerald-400/30 rounded-2xl px-4 py-2 text-right">
          <div className="text-[10px] uppercase tracking-wider text-slate-300 font-semibold">Score</div>
          <div className="font-mono text-4xl lg:text-5xl font-black text-emerald-400 leading-none">{route.score}</div>
        </div>

        {/* Title block */}
        <div className="absolute inset-x-0 bottom-0 p-6 md:p-10 lg:p-12">
          <div className="max-w-5xl mx-auto">
            <span className="inline-block text-[10px] uppercase font-bold tracking-wider text-emerald-300 bg-emerald-500/15 ring-1 ring-emerald-500/30 px-2 py-0.5 rounded-md">{route.theme}</span>
            <h1 className="mt-2 text-3xl md:text-5xl lg:text-6xl font-black tracking-tight leading-[1.05] break-words">{route.name}</h1>
            <p className="mt-1.5 text-sm md:text-base text-slate-300">{route.region}</p>
          </div>
        </div>

        {/* Scroll hint (mobile) */}
        {showHint && (
          <div className="md:hidden absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] font-bold uppercase tracking-widest text-slate-300/80 motion-safe:animate-bounce" aria-hidden>
            Scroll for stops ↓
          </div>
        )}
      </section>

      {/* Body */}
      <div className="mx-auto max-w-5xl px-6 lg:px-12 pb-36 md:pb-24">
        {/* Stat strip */}
        <dl className="grid grid-cols-3 divide-x divide-white/10 py-6 text-center">
          <div className="px-2">
            <dd className="font-mono text-2xl md:text-3xl font-black text-slate-100">{route.distanceKm}</dd>
            <dt className="text-[10px] uppercase tracking-wider text-slate-400 mt-0.5">km</dt>
          </div>
          <div className="px-2">
            <dd className="font-mono text-2xl md:text-3xl font-black text-slate-100">{route.drivingTime}</dd>
            <dt className="text-[10px] uppercase tracking-wider text-slate-400 mt-0.5">drive time</dt>
          </div>
          <div className="px-2">
            <dd className="font-mono text-2xl md:text-3xl font-black text-slate-100">{route.stops.length}</dd>
            <dt className="text-[10px] uppercase tracking-wider text-slate-400 mt-0.5">scenic stops</dt>
          </div>
        </dl>

        {/* Pull-quote */}
        {route.whyRide && (
          <blockquote className="border-l-2 border-emerald-400 pl-5 md:pl-7 py-8 text-xl md:text-2xl lg:text-3xl font-light italic text-emerald-200/90 leading-snug">
            “{route.whyRide}”
          </blockquote>
        )}

        {/* Summary + rubric */}
        <div className="lg:grid lg:grid-cols-[1fr_320px] lg:gap-10 lg:items-start">
          <p className="text-base md:text-lg leading-relaxed text-slate-300 max-w-prose">{route.summary}</p>
          <div className="mt-6 lg:mt-0 bg-slate-900/60 ring-1 ring-white/5 rounded-2xl p-6">
            <RubricMeters rubric={route.rubric} />
          </div>
        </div>

        {/* Stops */}
        <h2 className="mt-14 text-xs uppercase tracking-[0.2em] text-emerald-400 after:block after:h-px after:bg-white/10 after:mt-3">
          The stops
        </h2>
        <ol className="mt-8 space-y-12 md:space-y-16">
          {route.stops.map((stop, i) => (
            <StopFeature
              key={`${stop.lat},${stop.lon}-${i}`}
              stop={stop}
              index={i}
              color={route.color}
              eager={i < 2}
              onLocate={() => onLocate(i, stop.lat, stop.lon)}
            />
          ))}
        </ol>

        {/* Bottom CTAs (desktop / large screens) */}
        <div className="mt-16 hidden md:grid grid-cols-2 gap-3">
          <a href={gmaps} target="_blank" rel="noopener noreferrer" className="h-12 inline-flex items-center justify-center rounded-xl bg-emerald-500 text-slate-950 font-bold hover:bg-emerald-400 active:scale-[.98] transition-all">Ride it · Google Maps</a>
          <a href={amaps} target="_blank" rel="noopener noreferrer" className="h-12 inline-flex items-center justify-center rounded-xl bg-slate-800 ring-1 ring-slate-700 font-bold hover:ring-emerald-500/40 active:scale-[.98] transition-all">Apple Maps</a>
        </div>
        <p className="mt-6 text-[11px] text-slate-400 text-center leading-snug">
          Routes are road-snapped and scenery-scored from OpenStreetMap data + an automated judge.
          {!hasGoogleKey() && ' Imagery uses keyless Street View links.'} Verify pavement, season, and traffic before riding.
        </p>
      </div>

      {/* Mobile sticky footer CTAs */}
      <div
        className="md:hidden sticky bottom-0 z-30 grid grid-cols-2 gap-2 p-3 bg-slate-950/85 backdrop-blur border-t border-white/5"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <a href={gmaps} target="_blank" rel="noopener noreferrer" className="min-h-[48px] inline-flex items-center justify-center rounded-xl bg-emerald-500 text-slate-950 font-bold text-[13px] active:scale-[.98] transition-all">Ride it · Google Maps</a>
        <a href={amaps} target="_blank" rel="noopener noreferrer" className="min-h-[48px] inline-flex items-center justify-center rounded-xl bg-slate-800 ring-1 ring-slate-700 font-bold text-[13px] active:scale-[.98] transition-all">Apple Maps</a>
      </div>
    </div>
  );
}

/** Horizontal labeled rubric meters — far more legible than tiny vertical bars in a rail. */
function RubricMeters({ rubric }: { rubric: ScenicRubric }) {
  return (
    <div className="space-y-3">
      {RUBRIC_LABELS.map(({ key, label }) => {
        const v = Math.max(0, Math.min(10, rubric[key]));
        return (
          <div key={key} className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-[11px] font-semibold text-slate-300">{label}</span>
            <div className="flex-1 h-2 rounded-full bg-slate-800 overflow-hidden" aria-hidden>
              <div className="h-full rounded-full bg-emerald-500 motion-safe:transition-[width] motion-safe:duration-700" style={{ width: `${v * 10}%` }} />
            </div>
            <span className="w-7 shrink-0 text-right font-mono text-[11px] text-emerald-400">{v.toFixed(1)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** One scenic stop, magazine-style: big image alternating left/right with its text. */
function StopFeature({
  stop,
  index,
  color,
  eager,
  onLocate,
}: {
  stop: ScenicStop;
  index: number;
  color: string;
  eager: boolean;
  onLocate: () => void;
}) {
  const flip = index % 2 === 1;
  return (
    <li className="lg:grid lg:grid-cols-2 lg:gap-8 lg:items-center group">
      <figure className={`relative ${flip ? 'lg:order-2' : ''}`}>
        <StopHero stop={stop} eager={eager} />
        <figcaption className="absolute top-3 left-3 flex items-center gap-2">
          <span
            className="w-8 h-8 rounded-full grid place-items-center font-mono font-black text-slate-950 ring-2 ring-white/70 shadow"
            style={{ background: color }}
          >
            {index + 1}
          </span>
          <span className="text-lg drop-shadow" aria-hidden>{KIND_ICON[stop.kind]}</span>
        </figcaption>
      </figure>
      <div className={`mt-4 lg:mt-0 min-w-0 ${flip ? 'lg:order-1' : ''}`}>
        <div className="text-[10px] uppercase tracking-wider text-slate-400">{stop.kind}</div>
        <h3 className="mt-0.5 text-xl md:text-2xl font-bold text-slate-100 break-words">{stop.title}</h3>
        <p className="mt-2 text-slate-300 leading-relaxed break-words">{stop.blurb}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={onLocate}
            aria-label={`Locate stop ${index + 1}, ${stop.title}, on the map`}
            className="h-11 px-4 rounded-xl bg-slate-800 ring-1 ring-slate-700 text-sm font-semibold hover:ring-emerald-500/40 active:scale-[.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            <span aria-hidden>📍</span> Locate on map
          </button>
          <a
            href={streetViewDeepLink(stop.lat, stop.lon, stop.heading)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${stop.title} in Google Street View (opens in a new tab)`}
            className="h-11 px-4 rounded-xl text-sm font-semibold text-emerald-400 ring-1 ring-emerald-500/30 hover:bg-emerald-500/10 inline-flex items-center transition-colors"
          >
            <span aria-hidden>📷</span>&nbsp;Open in Street View <span aria-hidden>↗</span>
          </a>
        </div>
      </div>
    </li>
  );
}

/** Large Street View frame for a stop, with a graceful no-image fallback. */
function StopHero({ stop, eager }: { stop: ScenicStop; eager: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = streetViewStaticUrl(stop.lat, stop.lon, stop.heading, { size: '640x400' });
  const show = src && !failed;
  return (
    <div className="relative aspect-[16/10] lg:aspect-[4/3] w-full rounded-2xl ring-1 ring-white/10 overflow-hidden bg-slate-900">
      {show ? (
        <>
          {!loaded && <div className="absolute inset-0 motion-safe:animate-pulse bg-slate-800" aria-hidden />}
          <img
            src={src}
            alt={`Street View looking toward ${stop.title}`}
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={`w-full h-full object-cover transition-transform duration-300 motion-safe:group-hover:scale-[1.02] ${loaded ? 'opacity-100' : 'opacity-0'}`}
          />
        </>
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-slate-800 to-slate-900 grid place-items-center text-center p-4">
          <div>
            <div className="text-6xl" aria-hidden>{KIND_ICON[stop.kind]}</div>
            <div className="mt-2 text-[10px] uppercase tracking-wider text-slate-400">{stop.kind}</div>
            <a
              href={streetViewDeepLink(stop.lat, stop.lon, stop.heading)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center text-[11px] font-semibold text-emerald-400 hover:underline"
            >
              📷 Open in Street View ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Hero fallback: a self-drawn SVG of the route path (faithful, cos-lat corrected). Used both as
 * a load skeleton (keyless=false → no caption) and as the no-key state (keyless=true → caption).
 * Degrades gracefully for a single point (a dot) or no usable coords (a map glyph).
 */
function HeroPlaceholder({ coords, keyless }: { coords: LatLng[]; keyless: boolean }) {
  const pts = coords.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const W = 160;
  const H = 100;
  const pad = 12;
  let polyline = '';
  if (pts.length >= 2) {
    const lats = pts.map((p) => p[0]);
    const lons = pts.map((p) => p[1]);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const midLat = (minLat + maxLat) / 2;
    const cos = Math.cos((midLat * Math.PI) / 180) || 1;
    const w = (maxLon - minLon) * cos || 1e-6;
    const h = maxLat - minLat || 1e-6;
    const s = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
    const offX = (W - w * s) / 2;
    const offY = (H - h * s) / 2;
    polyline = pts
      .map((p) => `${(offX + (p[1] - minLon) * cos * s).toFixed(1)},${(offY + (maxLat - p[0]) * s).toFixed(1)}`)
      .join(' ');
  }
  return (
    <div className="absolute inset-0 bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full opacity-90" preserveAspectRatio="xMidYMid meet" aria-hidden>
        {polyline ? (
          <polyline points={polyline} fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        ) : pts.length === 1 ? (
          <circle cx={W / 2} cy={H / 2} r="4" fill="#34d399" />
        ) : (
          <text x={W / 2} y={H / 2} textAnchor="middle" dominantBaseline="central" fontSize="18" fill="#475569">🗺️</text>
        )}
      </svg>
      {keyless && (
        <p className="absolute bottom-3 inset-x-0 text-center text-[10px] text-slate-400 px-6">
          Add a Google Maps key for satellite + Street View imagery — the path and links still work.
        </p>
      )}
    </div>
  );
}
