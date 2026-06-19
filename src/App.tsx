import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import { useLeafletMap } from './hooks/useLeafletMap';
import { useBottomSheet } from './hooks/useBottomSheet';
import { scoreAndSort } from './lib/scoring';
import { scanRoads, dedupeByName, OverpassError } from './lib/overpass';
import { CURATED_ROUTES } from './data/routes';
import { SCENIC_ROUTES } from './data/scenicRoutes';
import { HOME } from './lib/mapsUrl';
import { RouteDetail, type DetailData } from './components/RouteDetail';
import { ScenicRoutePreview } from './components/ScenicRoutePreview';
import type { Weights, ScoredRoute, Pin, ScenicRoute, ScenicStop } from './data/types';
import type { ScannedRoad } from './data/types';

type Tab = 'scenic' | 'curated' | 'scanner';

const SCENIC_SORTED = [...SCENIC_ROUTES].sort((a, b) => b.score - a.score);
const escapeHtml = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
const STOP_ICON: Record<ScenicStop['kind'], string> = {
  viewpoint: '🌄', waterfall: '💦', gorge: '🪨', water: '💧', overlook: '🔭',
  village: '🏘️', forest: '🌲', bridge: '🌉', caution: '⚠️',
};

export default function App() {
  const { map, ready, clearLayers, addLayer } = useLeafletMap('map');
  const sheet = useBottomSheet();

  const [tab, setTab] = useState<Tab>('scenic');
  const [weights, setWeights] = useState<Weights>({ sinuosity: 7, scenery: 9, community: 8 });
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [scenicDetail, setScenicDetail] = useState<ScenicRoute | null>(null);
  const [toast, setToast] = useState('Pick a scenic ride — preview the stops, then send it to Maps');
  const [scanRadius, setScanRadius] = useState(12);
  const [scanIntensity, setScanIntensity] = useState(6);
  const [scanResults, setScanResults] = useState<ScannedRoad[]>([]);
  const [scanning, setScanning] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const scanController = useRef<AbortController | null>(null);

  const showToast = useCallback((m: string) => setToast(m), []);

  const drawPin = useCallback((pin: Pin) => {
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:14px;background:#0f172a;border:1px solid #334155;border-radius:9999px;box-shadow:0 1px 4px rgba(0,0,0,.5)">${pin.type === 'lookout' ? '📷' : pin.type === 'caution' ? '⚠️' : '📍'}</div>`,
      iconSize: [24, 24], iconAnchor: [12, 12],
    });
    addLayer(L.marker([pin.lat, pin.lon], { icon }).bindPopup(`<b>${escapeHtml(pin.title)}</b><br><span style="color:#475569">${escapeHtml(pin.desc)}</span>`));
  }, [addLayer]);

  const drawScenicStop = useCallback((stop: ScenicStop, index: number, color: string) => {
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#020617;background:${color};border:2px solid #fff;border-radius:9999px;box-shadow:0 1px 5px rgba(0,0,0,.6)">${index + 1}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    });
    addLayer(
      L.marker([stop.lat, stop.lon], { icon }).bindPopup(
        `<b>${STOP_ICON[stop.kind]} ${escapeHtml(stop.title)}</b><br><span style="color:#475569">${escapeHtml(stop.blurb)}</span>`,
      ),
    );
  }, [addLayer]);

  // Render curated routes whenever weights change and the tab is active.
  useEffect(() => {
    if (!ready || tab !== 'curated') return;
    clearLayers();
    const scored = scoreAndSort(CURATED_ROUTES, weights);
    scored.forEach((r) => {
      const pl = L.polyline(r.coords, { color: r.color, weight: 4, opacity: 0.85 });
      addLayer(pl);
      r.pins?.forEach(drawPin);
    });
  }, [ready, tab, weights, clearLayers, addLayer, drawPin]);

  // Scenic tab: draw all routes as an overview, or one selected route + numbered stops.
  useEffect(() => {
    if (!ready || tab !== 'scenic' || !map) return;
    clearLayers();
    if (scenicDetail) {
      const r = scenicDetail;
      addLayer(L.polyline(r.coords, { color: r.color, weight: 5, opacity: 0.92 }));
      r.stops.forEach((s, i) => drawScenicStop(s, i, r.color));
      const b = L.polyline(r.coords).getBounds();
      if (b.isValid()) map.fitBounds(b, { padding: [70, 70] });
    } else {
      SCENIC_SORTED.forEach((r) => addLayer(L.polyline(r.coords, { color: r.color, weight: 4, opacity: 0.8 })));
      map.setView(HOME, 9);
    }
  }, [ready, tab, scenicDetail, map, clearLayers, addLayer, drawScenicStop]);

  const selectScenic = (r: ScenicRoute) => {
    setScenicDetail(r);
    sheet.expand();
  };

  const flyToStop = (lat: number, lon: number) => {
    if (!map) return;
    map.flyTo([lat, lon], 15, { duration: 0.8 });
  };

  const selectCurated = (r: ScoredRoute) => {
    if (!map) return;
    const pl = L.polyline(r.coords);
    map.fitBounds(pl.getBounds(), { padding: [60, 60] });
    setDetail({
      name: r.name, type: r.type, highlights: r.highlights, score: r.score,
      sinuosity: r.sinuosity, canopy: r.canopy, waterProximity: r.waterProximity,
      note: r.note, communityIntel: r.communityIntel, coords: r.coords,
    });
    sheet.expand();
  };

  const selectScan = (r: ScannedRoad) => {
    if (!map) return;
    const pl = L.polyline(r.coords);
    map.fitBounds(pl.getBounds(), { padding: [60, 60] });
    setDetail({
      name: r.name, type: 'Measured from OSM', highlights: `Curve density ${r.curveDensity.toFixed(2)}`,
      score: r.score, sinuosity: r.sinuosity,
      note: 'Scored purely on measured curvature from OpenStreetMap geometry. No scenery data — scout it on satellite/Street View before committing.',
      coords: r.coords,
    });
    sheet.expand();
  };

  const runScan = async () => {
    if (!map || scanning) return;
    const controller = new AbortController();
    scanController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 25000);

    setScanning(true);
    setDetail(null);
    clearLayers();
    addLayer(L.circle(HOME, { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.04, weight: 1, dashArray: '5,8', radius: scanRadius * 1000 }));
    try {
      const roads = await scanRoads(HOME, scanRadius, scanIntensity / 10, controller.signal);
      // Draw every segment; de-clutter the list to one row per named road.
      roads.slice(0, 60).forEach((r) => {
        const color = r.score > 70 ? '#10b981' : r.score > 50 ? '#f59e0b' : '#38bdf8';
        addLayer(L.polyline(r.coords, { color, weight: 4, opacity: 0.85 }));
      });
      const listed = dedupeByName(roads).slice(0, 40);
      setScanResults(listed);
      showToast(
        listed.length
          ? `Found ${listed.length} twisty road${listed.length === 1 ? '' : 's'}`
          : 'No roads above your twistiness threshold — lower it or widen the radius',
      );
    } catch (e) {
      const kind = e instanceof OverpassError ? e.kind : 'network';
      showToast(
        kind === 'timeout'
          ? 'OpenStreetMap timed out — try a smaller radius'
          : kind === 'http'
            ? 'OpenStreetMap is busy — retry in a moment'
            : 'Scan failed — check your connection',
      );
      setScanResults([]);
    } finally {
      clearTimeout(timeout);
      scanController.current = null;
      setScanning(false);
      setHasScanned(true);
    }
  };

  const cancelScan = () => scanController.current?.abort();

  const switchTab = (t: Tab) => {
    setTab(t);
    setDetail(null);
    setScenicDetail(null);
    sheet.expand();
    if (t === 'scanner' && map) {
      clearLayers();
      addLayer(L.circle(HOME, { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.04, weight: 1, dashArray: '5,8', radius: scanRadius * 1000 }));
      map.setView(HOME, 10);
    }
  };

  const scored = useMemo(() => scoreAndSort(CURATED_ROUTES, weights), [weights]);

  return (
    <div className="relative w-full h-full overflow-hidden bg-slate-950 text-slate-100">
      <div id="map" className="absolute inset-0 z-0" />

      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-[1000] p-3" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <div className="max-w-2xl mx-auto bg-slate-900/95 backdrop-blur-md px-4 py-3 rounded-2xl shadow-2xl border border-slate-800 flex justify-between items-center">
          <div className="min-w-0">
            <h1 className="text-sm font-black tracking-tight text-white flex items-center gap-1.5">
              SINUOSITY <span className="text-[9px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded font-bold uppercase">WNY</span>
            </h1>
            <p className="text-[10px] text-slate-400 mt-0.5 truncate">From 36 Char Del Way · twisty + scenic backroads</p>
          </div>
          <div role="tablist" aria-label="Ride finder mode" className="flex items-center gap-1 bg-slate-950/60 p-1 rounded-xl border border-slate-800 shrink-0">
            <button role="tab" aria-selected={tab === 'scenic'} onClick={() => switchTab('scenic')} className={`px-2.5 py-2 rounded-lg text-[12px] font-bold transition-all ${tab === 'scenic' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}>Scenic</button>
            <button role="tab" aria-selected={tab === 'curated'} onClick={() => switchTab('curated')} className={`px-2.5 py-2 rounded-lg text-[12px] font-bold transition-all ${tab === 'curated' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}>Curated</button>
            <button role="tab" aria-selected={tab === 'scanner'} onClick={() => switchTab('scanner')} className={`px-2.5 py-2 rounded-lg text-[12px] font-bold transition-all ${tab === 'scanner' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}>Scan</button>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div role="status" aria-live="polite" className="absolute top-24 left-3 right-3 z-[1200] max-w-2xl mx-auto bg-slate-900/95 border border-emerald-500/30 px-4 py-3 rounded-xl shadow-xl flex items-center gap-3">
        <span className="text-base">🛰️</span>
        <span className="text-xs text-slate-200 font-medium">{toast}</span>
      </div>

      {/* Loader */}
      {scanning && (
        <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm z-[1300] flex flex-col justify-center items-center gap-4">
          <div className="relative w-14 h-14">
            <div className="absolute inset-0 rounded-full border-4 border-emerald-500/20" />
            <div className="absolute inset-0 rounded-full border-4 border-emerald-500 border-t-transparent animate-spin" />
          </div>
          <p className="text-sm font-semibold text-slate-200">Querying OpenStreetMap…</p>
          <button onClick={cancelScan} className="text-xs text-slate-400 hover:text-emerald-400 underline font-medium py-2 px-3">Cancel</button>
        </div>
      )}

      {/* Bottom sheet */}
      <div
        ref={sheet.sheetRef}
        className="sheet absolute bottom-0 left-0 right-0 mx-auto max-w-2xl z-[1100] bg-slate-900/97 backdrop-blur-md rounded-t-3xl shadow-2xl border-t border-x border-slate-800 flex flex-col"
        style={{ transform: `translateY(${sheet.translate}px)` }}
      >
        <div
          className="pt-2.5 pb-1.5 flex flex-col items-center cursor-grab active:cursor-grabbing shrink-0"
          onClick={sheet.toggle}
          onTouchStart={(e) => sheet.onPointerDown(e.touches[0].clientY)}
          onTouchMove={(e) => sheet.onPointerMove(e.touches[0].clientY)}
          onTouchEnd={sheet.onPointerUp}
          onMouseDown={(e) => {
            sheet.onPointerDown(e.clientY);
            const mm = (ev: MouseEvent) => sheet.onPointerMove(ev.clientY);
            const mu = () => { sheet.onPointerUp(); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
            document.addEventListener('mousemove', mm);
            document.addEventListener('mouseup', mu);
          }}
        >
          <div className="w-10 h-1.5 bg-slate-600 rounded-full" />
        </div>

        <div className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] overflow-hidden flex flex-col" style={{ maxHeight: '80vh' }}>
          {tab === 'scenic' && (
            <div className="flex flex-col gap-3 overflow-hidden">
              <div className="flex justify-between items-center">
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Scenic rides</h2>
                  <p className="text-[10px] text-slate-400">{scenicDetail ? 'Preview the stops, then ride it' : 'Agent-generated · scenery-scored · judge-ranked'}</p>
                </div>
                {scenicDetail && (
                  <button onClick={() => setScenicDetail(null)} className="text-[11px] text-slate-400 hover:text-emerald-400 underline font-medium py-2 px-1">← All rides</button>
                )}
              </div>
              <div className="overflow-y-auto custom-scrollbar space-y-2 pr-1" style={{ maxHeight: '64vh' }}>
                {!scenicDetail ? (
                  SCENIC_SORTED.map((r) => (
                    <button key={r.id} onClick={() => selectScenic(r)} className="w-full flex justify-between items-center p-3 rounded-xl border border-slate-800 bg-slate-900/40 active:scale-[.99] transition-all text-left">
                      <div className="min-w-0 pr-2">
                        <h4 className="font-bold text-[13px] text-slate-100 truncate">{r.name}</h4>
                        <p className="text-[10px] text-slate-400 truncate mt-0.5">{r.theme} · {r.region} · {r.distanceKm} km</p>
                      </div>
                      <span className="font-mono text-[13px] font-black text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded-lg shrink-0">{r.score}</span>
                    </button>
                  ))
                ) : (
                  <ScenicRoutePreview route={scenicDetail} onFlyTo={flyToStop} />
                )}
              </div>
            </div>
          )}

          {tab === 'curated' && (
            <div className="flex flex-col gap-3 overflow-hidden">
              <div className="flex justify-between items-center">
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Curated rides</h2>
                  <p className="text-[10px] text-slate-400">Hand-picked real roads, ranked by your weights</p>
                </div>
                <button onClick={() => setWeights({ sinuosity: 7, scenery: 9, community: 8 })} className="text-[11px] text-slate-400 hover:text-emerald-400 underline font-medium py-2 px-1">Reset</button>
              </div>
              <div className="grid grid-cols-3 gap-3 bg-slate-950/50 p-3 rounded-xl border border-slate-800">
                {([['sinuosity', 'Twistiness', false], ['scenery', 'Scenery', true], ['community', 'Rider buzz', true]] as const).map(([key, label, est]) => (
                  <div className="flex flex-col" key={key}>
                    <label htmlFor={`weight-${key}`} className="text-[10px] font-bold text-slate-300">{label} {est && <span className="text-amber-500/80">est</span>}</label>
                    <input id={`weight-${key}`} type="range" min={1} max={10} value={weights[key]} aria-label={`${label} weight`} aria-valuetext={`${weights[key].toFixed(1)} times`} onChange={(e) => setWeights((w) => ({ ...w, [key]: +e.target.value }))} />
                    <span className="text-[11px] font-mono font-semibold text-emerald-400">{weights[key].toFixed(1)}×</span>
                  </div>
                ))}
              </div>
              <div className="overflow-y-auto custom-scrollbar space-y-2 pr-1" style={{ maxHeight: '34vh' }}>
                {scored.map((r) => (
                  <button key={r.id} onClick={() => selectCurated(r)} className="w-full flex justify-between items-center p-3 rounded-xl border border-slate-800 bg-slate-900/40 active:scale-[.99] transition-all text-left">
                    <div className="min-w-0 pr-2">
                      <h4 className="font-bold text-[13px] text-slate-100 truncate">{r.name}</h4>
                      <p className="text-[10px] text-slate-400 truncate mt-0.5">{r.type} · {r.highlights}</p>
                    </div>
                    <span className="font-mono text-[13px] font-black text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded-lg shrink-0">{r.score}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === 'scanner' && (
            <div className="flex flex-col gap-3 overflow-hidden">
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Live road scan</h2>
                <p className="text-[10px] text-slate-400">Real OSM geometry, scored by measured curvature</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800 flex flex-col">
                  <label htmlFor="scan-radius" className="text-[10px] font-bold text-slate-300">Search radius</label>
                  <input id="scan-radius" type="range" min={5} max={30} value={scanRadius} aria-label="Search radius in kilometers" aria-valuetext={`${scanRadius} kilometers`} onChange={(e) => setScanRadius(+e.target.value)} />
                  <div className="text-right font-mono text-emerald-400 font-bold text-sm">{scanRadius} km</div>
                </div>
                <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800 flex flex-col">
                  <label htmlFor="scan-intensity" className="text-[10px] font-bold text-slate-300">Min twistiness</label>
                  <input id="scan-intensity" type="range" min={3} max={15} value={scanIntensity} aria-label="Minimum twistiness threshold" aria-valuetext={`${(scanIntensity / 10).toFixed(1)}`} onChange={(e) => setScanIntensity(+e.target.value)} />
                  <div className="text-right font-mono text-emerald-400 font-bold text-sm">{(scanIntensity / 10).toFixed(1)}</div>
                </div>
              </div>
              <button onClick={runScan} disabled={scanning} className="bg-emerald-500 active:bg-emerald-600 active:scale-[.98] disabled:opacity-50 disabled:active:scale-100 text-slate-950 font-bold py-3 rounded-xl text-sm shadow-lg transition-all">{scanning ? 'Scanning…' : 'Scan nearby roads'}</button>
              <div className="overflow-y-auto custom-scrollbar space-y-2" style={{ maxHeight: '30vh' }}>
                {scanResults.length === 0 ? (
                  <p className="text-[11px] text-slate-400 italic text-center py-3">{hasScanned ? 'No roads above your twistiness threshold — lower it or widen the radius.' : 'Measures real curve density from OpenStreetMap within your radius. No scenery estimates here — pure geometry.'}</p>
                ) : (
                  scanResults.map((r) => (
                    <button key={r.id} onClick={() => selectScan(r)} className="w-full flex justify-between items-center p-3 rounded-xl border border-slate-800 bg-slate-900/40 active:scale-[.99] transition-all text-left">
                      <div className="min-w-0 pr-2">
                        <h4 className="font-bold text-[13px] text-slate-100 truncate">{r.name}</h4>
                        <p className="text-[10px] text-slate-400 truncate">Curve density {r.curveDensity.toFixed(2)}</p>
                      </div>
                      <span className="font-mono text-[13px] font-bold text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded shrink-0">{r.score}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {tab !== 'scenic' && <RouteDetail data={detail} />}
        </div>
      </div>
    </div>
  );
}
