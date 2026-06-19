import { useState } from 'react';
import { googleMapsUrl, appleMapsUrl } from '../lib/mapsUrl';
import {
  hasGoogleKey,
  streetViewStaticUrl,
  staticRouteSatelliteUrl,
  streetViewDeepLink,
} from '../lib/scenicImagery';
import type { ScenicRoute, ScenicStop, ScenicRubric } from '../data/types';

const KIND_ICON: Record<ScenicStop['kind'], string> = {
  viewpoint: '🌄', waterfall: '💦', gorge: '🪨', water: '💧', overlook: '🔭',
  village: '🏘️', forest: '🌲', bridge: '🌉', caution: '⚠️',
};

const RUBRIC_LABELS: { key: keyof ScenicRubric; label: string }[] = [
  { key: 'curvature', label: 'Twisties' },
  { key: 'scenery', label: 'Scenery' },
  { key: 'greenery', label: 'Greenery' },
  { key: 'water', label: 'Water' },
  { key: 'notability', label: 'Notable' },
];

function RubricBars({ rubric }: { rubric: ScenicRubric }) {
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {RUBRIC_LABELS.map(({ key, label }) => {
        const v = Math.max(0, Math.min(10, rubric[key]));
        return (
          <div key={key} className="flex flex-col items-center gap-1">
            <div className="w-full h-12 bg-slate-800/70 rounded-md flex items-end overflow-hidden" aria-hidden>
              <div className="w-full bg-emerald-500/80 rounded-md" style={{ height: `${v * 10}%` }} />
            </div>
            <span className="text-[9px] text-slate-400 font-semibold">{label}</span>
            <span className="text-[9px] font-mono text-emerald-400">{v.toFixed(1)}</span>
          </div>
        );
      })}
    </div>
  );
}

function StopImage({ stop }: { stop: ScenicStop }) {
  const [failed, setFailed] = useState(false);
  const src = streetViewStaticUrl(stop.lat, stop.lon, stop.heading, { size: '320x200' });
  const showImg = src && !failed;
  return (
    <div className="relative w-24 h-16 shrink-0 rounded-lg overflow-hidden bg-slate-800 border border-slate-700">
      {showImg ? (
        <img
          src={src}
          alt={`Street View near ${stop.title}`}
          loading="lazy"
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-2xl">{KIND_ICON[stop.kind]}</div>
      )}
    </div>
  );
}

export function ScenicRoutePreview({
  route,
  onFlyTo,
}: {
  route: ScenicRoute;
  onFlyTo?: (lat: number, lon: number) => void;
}) {
  const gmaps = googleMapsUrl(route.coords);
  const amaps = appleMapsUrl(route.coords);
  const hero = staticRouteSatelliteUrl(route.coords, { size: '640x280' });

  return (
    <div className="flex flex-col gap-3 border-t border-slate-800 pt-3 mt-3 animate-fadeIn">
      {/* Hero satellite */}
      {hero ? (
        <img src={hero} alt={`Satellite view of ${route.name}`} loading="lazy" className="w-full h-32 object-cover rounded-xl border border-slate-800" />
      ) : (
        <div className="w-full h-20 rounded-xl border border-slate-800 bg-slate-950/70 flex items-center justify-center text-center px-4">
          <span className="text-[10px] text-slate-500">Add a Google Maps key to see a satellite preview · stop links below still work</span>
        </div>
      )}

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[9px] uppercase font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md">{route.theme}</span>
          <h4 className="font-bold text-sm text-slate-100 mt-1">{route.name}</h4>
          <p className="text-[10px] text-slate-400">{route.region} · {route.distanceKm} km · {route.drivingTime}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[9px] uppercase text-slate-400 font-semibold">Score</div>
          <div className="font-mono text-2xl font-black text-emerald-400">{route.score}</div>
        </div>
      </div>

      {route.whyRide && (
        <p className="text-[11px] text-emerald-300/90 italic leading-snug">“{route.whyRide}”</p>
      )}
      <p className="text-[11px] text-slate-300 leading-relaxed">{route.summary}</p>

      <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
        <RubricBars rubric={route.rubric} />
      </div>

      {/* Scenic stops */}
      <div>
        <h5 className="text-[10px] font-bold uppercase tracking-wider text-slate-300 mb-1.5">
          Scenic stops · tap to locate
        </h5>
        <div className="space-y-2">
          {route.stops.map((stop, i) => (
            <div key={`${stop.lat},${stop.lon}-${i}`} className="flex gap-2.5 p-2 rounded-xl border border-slate-800 bg-slate-900/40">
              <button
                onClick={() => onFlyTo?.(stop.lat, stop.lon)}
                className="shrink-0"
                aria-label={`Locate ${stop.title} on the map`}
              >
                <StopImage stop={stop} />
              </button>
              <div className="min-w-0 flex flex-col">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">{KIND_ICON[stop.kind]}</span>
                  <button onClick={() => onFlyTo?.(stop.lat, stop.lon)} className="font-bold text-[12px] text-slate-100 text-left truncate">
                    {i + 1}. {stop.title}
                  </button>
                </div>
                <p className="text-[10px] text-slate-400 leading-snug mt-0.5">{stop.blurb}</p>
                <a
                  href={streetViewDeepLink(stop.lat, stop.lon, stop.heading)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-emerald-400 font-semibold mt-1 hover:underline w-fit"
                >
                  📷 Open in Street View
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <a href={gmaps} target="_blank" rel="noopener noreferrer" className="bg-emerald-500 active:scale-[.98] text-slate-950 font-bold py-3 rounded-xl text-[13px] text-center transition-all">Ride it · Google Maps</a>
        <a href={amaps} target="_blank" rel="noopener noreferrer" className="bg-slate-800 active:scale-[.98] text-slate-100 font-bold py-3 rounded-xl text-[13px] text-center transition-all border border-slate-700">Apple Maps</a>
      </div>
      <p className="text-[9px] text-slate-500 text-center leading-snug">
        Routes are road-snapped and scenery-scored from OpenStreetMap data + an automated judge.
        {!hasGoogleKey() && ' Imagery uses keyless Street View links.'} Verify pavement, season, and traffic before riding.
      </p>
    </div>
  );
}
