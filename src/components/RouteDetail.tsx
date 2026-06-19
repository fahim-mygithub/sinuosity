import { googleMapsUrl, appleMapsUrl } from '../lib/mapsUrl';
import type { LatLng } from '../lib/geometry';

export interface DetailData {
  name: string;
  type: string;
  highlights: string;
  score: number;
  sinuosity: number;
  canopy?: number;
  waterProximity?: string;
  note: string;
  communityIntel?: string;
  coords: LatLng[];
}

export function RouteDetail({ data }: { data: DetailData | null }) {
  if (!data) return null;
  const gmaps = googleMapsUrl(data.coords);
  const amaps = appleMapsUrl(data.coords);

  return (
    <div className="flex flex-col gap-2 border-t border-slate-800 pt-3 mt-3 animate-fadeIn">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[9px] uppercase font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md">{data.type}</span>
          <h4 className="font-bold text-sm text-slate-100 mt-1 truncate">{data.name}</h4>
          <p className="text-[10px] text-slate-400 truncate">{data.highlights}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[9px] uppercase text-slate-400 font-semibold">Score</div>
          <div className="font-mono text-2xl font-black text-emerald-400">{data.score}</div>
        </div>
      </div>

      <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800 space-y-2">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-semibold text-slate-400">
          <span>🌀 Curvature: {data.sinuosity.toFixed(1)}</span>
          {data.canopy != null && <span>🌲 Canopy: ~{data.canopy}% <span className="text-amber-500/70">est</span></span>}
          {data.waterProximity && <span>💧 {data.waterProximity} <span className="text-amber-500/70">est</span></span>}
        </div>
        <p className="text-[11px] text-slate-300 leading-relaxed">{data.note}</p>
        {data.communityIntel && (
          <p className="text-[10px] text-slate-500 leading-normal border-t border-slate-800/60 pt-1.5">
            Rider chatter (paraphrased): {data.communityIntel}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <a href={gmaps} target="_blank" rel="noopener noreferrer" className="bg-emerald-500 active:scale-[.98] text-slate-950 font-bold py-3 rounded-xl text-[13px] text-center transition-all">Google Maps</a>
        <a href={amaps} target="_blank" rel="noopener noreferrer" className="bg-slate-800 active:scale-[.98] text-slate-100 font-bold py-3 rounded-xl text-[13px] text-center transition-all border border-slate-700">Apple Maps</a>
      </div>
      <p className="text-[9px] text-slate-500 text-center leading-snug">
        Scenery &amp; buzz values are rough estimates, not measured. Curvature is computed from real road geometry. Verify pavement and traffic before riding.
      </p>
    </div>
  );
}
