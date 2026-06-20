import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import { useLeafletMap } from './hooks/useLeafletMap';
import { useBottomSheet } from './hooks/useBottomSheet';
import { scanRoads, dedupeByName, OverpassError } from './lib/overpass';
import { CURATED_ROUTES } from './data/curatedRoutes';
import { SCENIC_ROUTES } from './data/scenicRoutes';
import { loadDefaultLocation, saveDefaultLocation, type SavedLocation } from './lib/settings';
import { LocationSearch } from './components/LocationSearch';
import { RouteDetail, type DetailData } from './components/RouteDetail';
import { ScenicRouteReview } from './components/ScenicRouteReview';
import { KIND_ICON } from './lib/scenicMeta';
import type { ScenicRoute, ScenicStop, ScannedRoad } from './data/types';
import type { LatLng } from './lib/geometry';

type Tab = 'scenic' | 'curated' | 'scanner';

const SCENIC_SORTED = [...SCENIC_ROUTES].sort((a, b) => b.score - a.score);
const CURATED_SORTED = [...CURATED_ROUTES].sort((a, b) => b.score - a.score);
const escapeHtml = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
const SCAN_CIRCLE = { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.04, weight: 1, dashArray: '5,8' };

export default function App() {
  const { map, ready, clearLayers, addLayer } = useLeafletMap('map');
  const sheet = useBottomSheet();

  const [tab, setTab] = useState<Tab>('scenic');
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [scenicDetail, setScenicDetail] = useState<ScenicRoute | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [activeStopIdx, setActiveStopIdx] = useState<number | null>(null);
  const lastScenicFocus = useRef<HTMLElement | null>(null);
  const fittedRouteId = useRef<string | null>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const [toast, setToast] = useState('Pick a scenic ride — preview the stops, then send it to Maps');

  // Location: the rider's saved default (navigation origin + scan home) and the live scan center.
  const [defaultLocation, setDefaultLocation] = useState<SavedLocation>(loadDefaultLocation);
  const [scanCenter, setScanCenter] = useState<SavedLocation>(() => defaultLocation);
  const homeCenter = useMemo<LatLng>(() => [defaultLocation.lat, defaultLocation.lon], [defaultLocation]);
  const scanCenterLatLng = useMemo<LatLng>(() => [scanCenter.lat, scanCenter.lon], [scanCenter]);
  const isScanDefault =
    Math.abs(scanCenter.lat - defaultLocation.lat) < 1e-4 && Math.abs(scanCenter.lon - defaultLocation.lon) < 1e-4;

  const [scanRadius, setScanRadius] = useState(12);
  const [scanIntensity, setScanIntensity] = useState(6);
  const [scanResults, setScanResults] = useState<ScannedRoad[]>([]);
  const [scanning, setScanning] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const scanController = useRef<AbortController | null>(null);

  const showToast = useCallback((m: string) => setToast(m), []);

  // fitBounds padding that keeps the drawn route clear of the panel (left dock on
  // desktop, bottom sheet on mobile) and the floating header/status chrome.
  const fitOptions = useCallback(
    (): L.FitBoundsOptions =>
      sheet.isMobile
        ? { paddingTopLeft: [24, 132], paddingBottomRight: [24, 320] }
        : { paddingTopLeft: [424, 96], paddingBottomRight: [64, 48] },
    [sheet.isMobile],
  );

  // While the full-page review is open, make everything behind it inert: removes it from the
  // tab order (focus trap) and blocks pointer interaction with the map/sheet underneath.
  useEffect(() => {
    const el = chromeRef.current;
    if (el) el.inert = reviewOpen;
  }, [reviewOpen]);

  // Esc collapses the expanded mobile sheet (but not while the full-page review owns Esc).
  useEffect(() => {
    if (!sheet.isMobile || sheet.state !== 'full' || reviewOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') sheet.collapse(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet.isMobile, sheet.state, sheet.collapse, sheet, reviewOpen]);

  const drawScenicStop = useCallback((stop: ScenicStop, index: number, color: string, active: boolean) => {
    const size = active ? 38 : 26;
    const ring = active ? '3px solid #34d399' : '2px solid #fff';
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;font-size:${active ? 15 : 11}px;font-weight:800;color:#020617;background:${color};border:${ring};border-radius:9999px;box-shadow:0 1px 6px rgba(0,0,0,.7)${active ? ';outline:4px solid rgba(52,211,153,.35)' : ''}">${index + 1}</div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    });
    const m = L.marker([stop.lat, stop.lon], { icon, zIndexOffset: active ? 1000 : 0 }).bindPopup(
      `<b>${KIND_ICON[stop.kind]} ${escapeHtml(stop.title)}</b><br><span style="color:#475569">${escapeHtml(stop.blurb)}</span>`,
      // The active popup auto-opens during "Locate" — keep autoPan off so it doesn't fight flyTo.
      active ? { autoPan: false } : undefined,
    );
    addLayer(m);
    if (active) m.openPopup();
  }, [addLayer]);

  // Scenic & Curated tabs share the same review experience: draw all routes as an overview, or
  // one selected route + numbered stops. (Curated routes are now full ScenicRoutes too.)
  const browseRoutes = tab === 'curated' ? CURATED_SORTED : SCENIC_SORTED;
  useEffect(() => {
    if (!ready || !map || (tab !== 'scenic' && tab !== 'curated')) return;
    clearLayers();
    if (scenicDetail) {
      const r = scenicDetail;
      addLayer(L.polyline(r.coords, { color: r.color, weight: 5, opacity: 0.92 }));
      r.stops.forEach((s, i) => drawScenicStop(s, i, r.color, i === activeStopIdx));
      // Fit once per route — not on activeStopIdx change, so "Locate" flyTo isn't overridden.
      if (fittedRouteId.current !== r.id) {
        const b = L.polyline(r.coords).getBounds();
        if (b.isValid()) map.fitBounds(b, fitOptions());
        fittedRouteId.current = r.id;
      }
    } else {
      fittedRouteId.current = null;
      browseRoutes.forEach((r) => addLayer(L.polyline(r.coords, { color: r.color, weight: 4, opacity: 0.8 })));
      map.setView(homeCenter, 9);
    }
  }, [ready, tab, scenicDetail, activeStopIdx, map, clearLayers, addLayer, drawScenicStop, fitOptions, browseRoutes, homeCenter]);

  const selectScenic = useCallback((r: ScenicRoute, originEl?: HTMLElement | null) => {
    lastScenicFocus.current = originEl ?? null;
    setScenicDetail(r);
    setActiveStopIdx(null);
    setReviewOpen(true);
  }, []);

  // Back from the full-page review: clear the route and restore focus to the list.
  const closeReview = useCallback(() => {
    setReviewOpen(false);
    setScenicDetail(null);
    setActiveStopIdx(null);
    requestAnimationFrame(() => lastScenicFocus.current?.focus());
  }, []);

  // "Locate on map": close the overlay but KEEP the route drawn, fly to the stop, announce it,
  // and move focus back to the ride list so keyboard focus isn't dropped to <body>.
  const locateStop = useCallback((index: number, lat: number, lon: number) => {
    setReviewOpen(false);
    setActiveStopIdx(index);
    if (map) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) map.setView([lat, lon], 15);
      else map.flyTo([lat, lon], 15, { duration: 0.8 });
    }
    const stop = scenicDetail?.stops[index];
    if (stop) showToast(`Showing ${stop.title} on the map`);
    requestAnimationFrame(() => lastScenicFocus.current?.focus());
  }, [map, scenicDetail, showToast]);

  const selectScan = (r: ScannedRoad) => {
    if (!map) return;
    const pl = L.polyline(r.coords);
    map.fitBounds(pl.getBounds(), fitOptions());
    setDetail({
      name: r.name, type: 'Measured from OSM', highlights: `Curve density ${r.curveDensity.toFixed(2)}`,
      score: r.score, sinuosity: r.sinuosity,
      note: 'Scored purely on measured curvature from OpenStreetMap geometry. No scenery data — scout it on satellite/Street View before committing.',
      coords: r.coords,
    });
    sheet.expand();
  };

  // --- Location handlers (Scan tab) -------------------------------------------------------
  // Recenter the scan on a chosen place: reset prior results, redraw the radius ring, fly there.
  const recenterScan = useCallback((loc: SavedLocation) => {
    setScanCenter(loc);
    setScanResults([]);
    setHasScanned(false);
    setDetail(null);
    if (map) {
      clearLayers();
      addLayer(L.circle([loc.lat, loc.lon], { ...SCAN_CIRCLE, radius: scanRadius * 1000 }));
      map.setView([loc.lat, loc.lon], 10);
    }
    showToast(`Scan centered on ${loc.label}`);
  }, [map, clearLayers, addLayer, scanRadius, showToast]);

  const handleSetDefault = useCallback(() => {
    if (saveDefaultLocation(scanCenter)) {
      setDefaultLocation(scanCenter);
      showToast(`Saved ${scanCenter.label} as your default location`);
    } else {
      showToast('Could not save default — storage is unavailable');
    }
  }, [scanCenter, showToast]);

  const handleUseDefault = useCallback(() => recenterScan(defaultLocation), [recenterScan, defaultLocation]);

  const runScan = async () => {
    if (!map || scanning) return;
    const controller = new AbortController();
    scanController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 25000);

    setScanning(true);
    setDetail(null);
    clearLayers();
    addLayer(L.circle(scanCenterLatLng, { ...SCAN_CIRCLE, radius: scanRadius * 1000 }));
    try {
      const roads = await scanRoads(scanCenterLatLng, scanRadius, scanIntensity / 10, controller.signal);
      // Draw every segment; de-clutter the list to one row per named road.
      roads.slice(0, 60).forEach((r) => {
        const color = r.score > 70 ? '#10b981' : r.score > 50 ? '#f59e0b' : '#38bdf8';
        addLayer(L.polyline(r.coords, { color, weight: 4, opacity: 0.85 }));
      });
      const listed = dedupeByName(roads).slice(0, 40);
      setScanResults(listed);
      showToast(
        listed.length
          ? `Found ${listed.length} twisty road${listed.length === 1 ? '' : 's'} near ${scanCenter.label}`
          : 'No roads above your twistiness threshold — lower it or widen the radius',
      );
    } catch (e) {
      const kind = e instanceof OverpassError ? e.kind : 'network';
      showToast(
        kind === 'timeout'
          ? 'OpenStreetMap servers are busy right now — wait a moment and retry, or use a smaller radius'
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
    setReviewOpen(false);
    setActiveStopIdx(null);
    if (t === 'scanner' && map) {
      clearLayers();
      addLayer(L.circle(scanCenterLatLng, { ...SCAN_CIRCLE, radius: scanRadius * 1000 }));
      map.setView(scanCenterLatLng, 10);
    }
  };

  const browsing = tab === 'scenic' || tab === 'curated';
  const browseTitle = tab === 'curated' ? 'Curated rides' : 'Scenic rides';
  const browseSubtitle =
    tab === 'curated'
      ? 'Hand-picked classics · road-snapped · measured curvature · tap to review'
      : 'Agent-generated · scenery-scored · judge-ranked · tap to review';

  return (
    <div className="relative w-full h-full overflow-hidden bg-slate-950 text-slate-100">
      <div ref={chromeRef} style={{ display: 'contents' }}>
      <div id="map" className="absolute inset-0 z-0" />

      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-[1200] p-3" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <div className="max-w-2xl mx-auto bg-slate-900/95 backdrop-blur-md px-4 py-3 rounded-2xl shadow-2xl border border-slate-800 flex justify-between items-center">
          <div className="min-w-0">
            <h1 className="text-sm font-black tracking-tight text-white flex items-center gap-1.5">
              SINUOSITY <span className="text-[9px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded font-bold uppercase">WNY</span>
            </h1>
            <p className="text-[10px] text-slate-400 mt-0.5 truncate">Twisty + scenic backroads · scout from anywhere</p>
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

      {/* Scrim: tap to collapse the expanded mobile sheet */}
      {sheet.isMobile && sheet.state === 'full' && (
        <button
          aria-label="Collapse ride list"
          onClick={sheet.collapse}
          className="absolute inset-0 z-[1050] bg-slate-950/50 backdrop-blur-[1px] animate-fadeIn cursor-default"
        />
      )}

      {/* Bottom sheet (mobile) · docked side panel (desktop) */}
      <div
        ref={sheet.sheetRef}
        className={
          sheet.isMobile
            ? `sheet${sheet.dragging ? ' dragging' : ''} absolute bottom-0 left-0 right-0 mx-auto max-w-2xl z-[1100] bg-slate-900/97 backdrop-blur-md rounded-t-3xl shadow-2xl border-t border-x border-slate-800 flex flex-col`
            : 'absolute left-4 top-[92px] z-[1100] w-[384px] max-h-[calc(100vh-112px)] bg-slate-900/95 backdrop-blur-md rounded-2xl shadow-2xl border border-slate-800 flex flex-col overflow-hidden'
        }
        style={sheet.isMobile ? { transform: `translateY(${sheet.translate}px)` } : undefined}
        role={sheet.isMobile ? 'dialog' : 'region'}
        aria-label="Ride list"
      >
        {sheet.isMobile && (
          <button
            type="button"
            aria-label={sheet.state === 'full' ? 'Collapse ride list' : 'Expand ride list'}
            aria-expanded={sheet.state === 'full'}
            onPointerDown={sheet.onPointerDown}
            onPointerMove={sheet.onPointerMove}
            onPointerUp={sheet.onPointerUp}
            onPointerCancel={sheet.onPointerCancel}
            onClick={(e) => { if (e.detail === 0) sheet.toggle(); }}
            className="sheet-handle group w-full pt-3 pb-2 flex flex-col items-center gap-1 shrink-0 cursor-grab active:cursor-grabbing select-none"
          >
            <span className="w-10 h-1.5 bg-slate-600 group-hover:bg-slate-500 rounded-full transition-colors" />
            <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
              {sheet.state === 'full' ? 'Tap or drag down to close' : 'Tap or drag up for rides'}
            </span>
          </button>
        )}

        <div
          className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] overflow-y-auto custom-scrollbar flex flex-col min-h-0"
          style={{ maxHeight: sheet.isMobile ? '80vh' : undefined, paddingTop: sheet.isMobile ? undefined : '1.1rem' }}
        >
          {browsing && (
            <div className="flex flex-col gap-3 overflow-hidden">
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-emerald-400">{browseTitle}</h2>
                <p className="text-[10px] text-slate-400">{browseSubtitle}</p>
              </div>
              {/* When a route is on the map but the review is closed: reopen / clear. */}
              {scenicDetail && !reviewOpen && (
                <div className="flex items-center gap-2 p-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5">
                  <span className="text-base shrink-0" aria-hidden>📍</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-bold text-slate-100 truncate">{scenicDetail.name}</p>
                    <p className="text-[9px] text-slate-400">shown on the map</p>
                  </div>
                  <button onClick={() => setReviewOpen(true)} className="text-[11px] font-bold text-emerald-400 hover:underline py-2 px-1 shrink-0">Reopen review</button>
                  <button onClick={closeReview} className="text-[11px] text-slate-400 hover:text-slate-200 py-2 px-1 shrink-0">Clear</button>
                </div>
              )}
              <div className="overflow-y-auto custom-scrollbar space-y-2 pr-1" style={{ maxHeight: '64vh' }}>
                {browseRoutes.map((r) => {
                  const isActive = scenicDetail?.id === r.id;
                  return (
                    <button
                      key={r.id}
                      onClick={(e) => selectScenic(r, e.currentTarget)}
                      aria-current={isActive ? 'true' : undefined}
                      className={`w-full flex justify-between items-center p-3 rounded-xl border active:scale-[.99] transition-all text-left ${isActive ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-slate-800 bg-slate-900/40'}`}
                    >
                      <div className="min-w-0 pr-2">
                        <h4 className="font-bold text-[13px] text-slate-100 truncate">{r.name}</h4>
                        <p className="text-[10px] text-slate-400 truncate mt-0.5">{r.theme} · {r.region} · {r.distanceKm} km</p>
                      </div>
                      <span className="font-mono text-[13px] font-black text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded-lg shrink-0">{r.score}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'scanner' && (
            <div className="flex flex-col gap-3 overflow-hidden">
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Live road scan</h2>
                <p className="text-[10px] text-slate-400">Real OSM geometry, scored by measured curvature</p>
              </div>
              <LocationSearch
                value={scanCenter}
                isDefault={isScanDefault}
                defaultLabel={defaultLocation.label}
                onSelect={recenterScan}
                onSetDefault={handleSetDefault}
                onUseDefault={handleUseDefault}
              />
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

          {tab === 'scanner' && <RouteDetail data={detail} origin={scanCenterLatLng} />}
        </div>
      </div>
      </div>

      {/* Full-page review overlay (scenic + curated) */}
      {browsing && reviewOpen && scenicDetail && (
        <ScenicRouteReview route={scenicDetail} onBack={closeReview} onLocate={locateStop} origin={homeCenter} />
      )}
    </div>
  );
}
