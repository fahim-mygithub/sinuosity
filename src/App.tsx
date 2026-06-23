import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import { useLeafletMap } from './hooks/useLeafletMap';
import { useBottomSheet } from './hooks/useBottomSheet';
import { scanArea, OverpassError, type AreaScan } from './lib/overpass';
import { buildRides } from './lib/routeBuilder';
import { BIAS_PRESETS, normalizeWeights, type BiasWeights, type BiasPreset } from './lib/composite';
import { CURATED_ROUTES } from './data/curatedRoutes';
import { SCENIC_ROUTES } from './data/scenicRoutes';
import { loadDefaultLocation, saveDefaultLocation, type SavedLocation } from './lib/settings';
import { loadPreferences, updatePreferences, applyTheme, type Preferences } from './lib/preferences';
import {
  loadSavedRoutes, writeSavedRoutes, toggleSavedRoute, removeSavedRoute, isRouteSaved, type SavedRoute,
} from './lib/savedRoutes';
import { formatDistance } from './lib/units';
import { reverseGeocode } from './lib/geocode';
import { LocationSearch } from './components/LocationSearch';
import { ScenicRouteReview } from './components/ScenicRouteReview';
import { SettingsMenu } from './components/SettingsMenu';
import { KIND_ICON } from './lib/scenicMeta';
import type { ScenicRoute, ScenicStop } from './data/types';
import type { LatLng } from './lib/geometry';

/** Bias-slider rows (label per rubric dimension), in display order. */
const BIAS_ROWS: { key: keyof BiasWeights; label: string; icon: string }[] = [
  { key: 'curvature', label: 'Twisties', icon: '🌀' },
  { key: 'scenery', label: 'Scenery', icon: '🌄' },
  { key: 'greenery', label: 'Greenery', icon: '🌲' },
  { key: 'water', label: 'Water', icon: '💧' },
  { key: 'notability', label: 'Notable', icon: '📍' },
];

type Tab = 'scenic' | 'curated' | 'scanner';

/** Resolve a saved bias-preset id back to its preset (falls back to the first/Balanced). */
const presetById = (id: string) => BIAS_PRESETS.find((p) => p.id === id) ?? BIAS_PRESETS[0];

const SCENIC_SORTED = [...SCENIC_ROUTES].sort((a, b) => b.score - a.score);
const CURATED_SORTED = [...CURATED_ROUTES].sort((a, b) => b.score - a.score);
const escapeHtml = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
const SCAN_CIRCLE = { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.04, weight: 1, dashArray: '5,8' };

export default function App() {
  const { map, ready, clearLayers, addLayer } = useLeafletMap('map');
  const sheet = useBottomSheet();

  const [tab, setTab] = useState<Tab>('scenic');
  const [scenicDetail, setScenicDetail] = useState<ScenicRoute | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [activeStopIdx, setActiveStopIdx] = useState<number | null>(null);
  const lastScenicFocus = useRef<HTMLElement | null>(null);
  const fittedRouteId = useRef<string | null>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const [toast, setToast] = useState('Pick a scenic ride — preview the stops, then send it to Maps');

  // Rider preferences (units / default bias / theme), saved rides, and the settings overlay — all local.
  const [prefs, setPrefs] = useState<Preferences>(loadPreferences);
  const [saved, setSaved] = useState<SavedRoute[]>(loadSavedRoutes);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const units = prefs.units;

  // Location: the rider's saved default (navigation origin + scan home) and the live scan center.
  const [defaultLocation, setDefaultLocation] = useState<SavedLocation>(loadDefaultLocation);
  const [scanCenter, setScanCenter] = useState<SavedLocation>(() => defaultLocation);
  const homeCenter = useMemo<LatLng>(() => [defaultLocation.lat, defaultLocation.lon], [defaultLocation]);
  const scanCenterLatLng = useMemo<LatLng>(() => [scanCenter.lat, scanCenter.lon], [scanCenter]);
  const isScanDefault =
    Math.abs(scanCenter.lat - defaultLocation.lat) < 1e-4 && Math.abs(scanCenter.lon - defaultLocation.lon) < 1e-4;

  const [scanRadius, setScanRadius] = useState(12);
  // When on, the builder prefers round-trip loops (returns near the start) over there-and-backs.
  const [loopMode, setLoopMode] = useState(false);
  // Multi-criteria scan: the cached area corpus + the rides built from it under the current bias.
  const [areaScan, setAreaScan] = useState<AreaScan | null>(null);
  const [scanRides, setScanRides] = useState<ScenicRoute[]>([]);
  const [bias, setBias] = useState<BiasWeights>(() => presetById(prefs.defaultBiasPreset).weights);
  const [presetId, setPresetId] = useState(() => prefs.defaultBiasPreset);
  const [showWeights, setShowWeights] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const scanController = useRef<AbortController | null>(null);
  // Live handle on the dashed scan-radius ring so the slider can resize it in place, plus a
  // visible, draggable center pin (Leaflet marker) that moves the whole scan area.
  const scanCircleRef = useRef<L.Circle | null>(null);
  const scanHandleRef = useRef<L.Marker | null>(null);
  // Latest "ring dropped at" handler, held in a ref so drawScanCircle's drag wiring never goes stale.
  const onCircleDropRef = useRef<(ll: L.LatLng) => void>(() => {});

  const showToast = useCallback((m: string) => setToast(m), []);

  // Apply the chosen theme to the document root so the light-mode CSS overrides engage.
  useEffect(() => { applyTheme(prefs.theme); }, [prefs.theme]);

  // Persist a preferences change and reflect it in state immediately.
  const changePrefs = useCallback((patch: Partial<Preferences>) => {
    setPrefs(updatePreferences(patch));
  }, []);

  const savedIds = useMemo(() => new Set(saved.map((s) => s.route.id)), [saved]);

  // Draw (or replace) the scan-radius ring at `center`, keeping a handle so the radius slider
  // can grow/shrink it live without a re-scan. Call AFTER clearLayers() so it isn't wiped. A visible
  // emerald "move" pin sits at the center as the DRAG HANDLE — Leaflet's own marker dragging handles
  // mouse/touch/pen and suppresses map panning while you drag, so it's reliable everywhere. As the
  // pin moves the dashed circle tracks it live; on release, onCircleDropRef recenters the scan.
  const drawScanCircle = useCallback((center: LatLng) => {
    const radius = scanRadius * 1000;
    const circle = L.circle(center, { ...SCAN_CIRCLE, radius, interactive: false });
    const handleIcon = L.divIcon({
      className: '',
      html:
        `<div title="Drag to move the scan area" style="width:34px;height:34px;display:flex;align-items:center;` +
        `justify-content:center;background:#10b981;border:2px solid #fff;border-radius:9999px;` +
        `box-shadow:0 2px 8px rgba(0,0,0,.6);cursor:move;touch-action:none">` +
        `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#022c22" stroke-width="2.5" ` +
        `stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/>` +
        `<polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/>` +
        `<polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/>` +
        `<line x1="12" y1="2" x2="12" y2="22"/></svg></div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    const handle = L.marker(center, { icon: handleIcon, draggable: true, zIndexOffset: 1200, keyboard: false });
    handle.on('drag', () => circle.setLatLng(handle.getLatLng()));
    handle.on('dragend', () => onCircleDropRef.current(handle.getLatLng()));
    handle.bindTooltip('Drag to move the scan area', { direction: 'top', offset: [0, -18], opacity: 0.9 });
    scanCircleRef.current = circle;
    scanHandleRef.current = handle;
    addLayer(circle);
    addLayer(handle); // on top of the disk so it's always grabbable
  }, [addLayer, scanRadius]);

  // Resize the dashed ring in place as the slider moves (no clear, no re-scan) so the on-map circle
  // always matches the "{n} km" readout. The center pin stays put.
  useEffect(() => {
    if (tab === 'scanner') {
      scanCircleRef.current?.setRadius(scanRadius * 1000);
    }
  }, [scanRadius, tab]);

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

  // Draw each discovered ride as its own colored line, with a wide invisible "hit" line beneath so
  // it's easy to tap. Either one opens the same full cruise page the scenic/curated rides use.
  const drawRides = useCallback((rides: ScenicRoute[]) => {
    rides.forEach((r) => {
      const open = () => selectScenic(r);
      const hit = L.polyline(r.coords, { color: r.color, weight: 18, opacity: 0 });
      const line = L.polyline(r.coords, { color: r.color, weight: 4, opacity: 0.9 });
      hit.on('click', open);
      line.on('click', open);
      addLayer(hit);
      addLayer(line);
    });
  }, [addLayer, selectScenic]);

  // Scenic & Curated tabs share the same review experience: draw all routes as an overview (each
  // line clickable → opens the cruise page, same as the Scan tab via drawRides), or one selected
  // route + its numbered stops. Placed after drawRides so the overview can reuse its clickable lines.
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
      drawRides(browseRoutes); // clickable colored lines (hit-line beneath) → tap a path to open it
      map.setView(homeCenter, 9);
    }
  }, [ready, tab, scenicDetail, activeStopIdx, map, clearLayers, addLayer, drawScenicStop, drawRides, fitOptions, browseRoutes, homeCenter]);

  // Re-rank + redraw from the cached area corpus under a bias — no network. Used both right after a
  // scan and whenever the rider nudges a bias slider, so weighting changes feel instant.
  const rebuildRides = useCallback((scan: AreaScan, b: BiasWeights, loops: boolean): ScenicRoute[] => {
    const rides = buildRides(scan.roads, scan.catalog, { bias: b, areaLabel: scanCenter.label, preferLoops: loops });
    setScanRides(rides);
    if (map) {
      clearLayers();
      drawScanCircle([scan.center[0], scan.center[1]]);
      drawRides(rides);
    }
    return rides;
  }, [map, clearLayers, drawScanCircle, drawRides, scanCenter.label]);

  // --- Location handlers (Scan tab) -------------------------------------------------------
  // Recenter the scan on a chosen place: reset prior results, redraw the radius ring, fly there.
  const recenterScan = useCallback((loc: SavedLocation) => {
    setScanCenter(loc);
    setScanRides([]);
    setAreaScan(null);
    setHasScanned(false);
    if (map) {
      clearLayers();
      drawScanCircle([loc.lat, loc.lon]);
      map.setView([loc.lat, loc.lon], 10);
    }
    showToast(`Scan centered on ${loc.label}`);
  }, [map, clearLayers, drawScanCircle, showToast]);

  // Ring dropped after a freehand drag: recenter the scan there WITHOUT flying the map (the rider
  // just placed it by hand). Reset any prior results, label it with the coord immediately, then
  // upgrade the label from a background reverse-geocode when it returns.
  const handleCircleDrop = useCallback((ll: L.LatLng) => {
    const lat = +ll.lat.toFixed(5);
    const lon = +ll.lng.toFixed(5);
    const provisional: SavedLocation = { label: `Dropped pin · ${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon };
    setScanCenter(provisional);
    setScanRides([]);
    setAreaScan(null);
    setHasScanned(false);
    if (map) {
      clearLayers();
      drawScanCircle([lat, lon]);
    }
    showToast('Scan moved — tap “Scan & build rides” to search here');
    reverseGeocode(lat, lon)
      .then((r) => {
        if (r?.label) setScanCenter((c) => (c.lat === lat && c.lon === lon ? { ...c, label: r.label } : c));
      })
      .catch(() => { /* keep the coord label */ });
  }, [map, clearLayers, drawScanCircle, showToast]);

  useEffect(() => { onCircleDropRef.current = handleCircleDrop; }, [handleCircleDrop]);

  const handleSetDefault = useCallback(() => {
    if (saveDefaultLocation(scanCenter)) {
      setDefaultLocation(scanCenter);
      showToast(`Saved ${scanCenter.label} as your default location`);
    } else {
      showToast('Could not save default — storage is unavailable');
    }
  }, [scanCenter, showToast]);

  const handleUseDefault = useCallback(() => recenterScan(defaultLocation), [recenterScan, defaultLocation]);

  // Settings → Home: persist a new default location (the Scan home + navigation origin).
  const handleChangeHome = useCallback((loc: SavedLocation) => {
    if (saveDefaultLocation(loc)) {
      setDefaultLocation(loc);
      showToast(`Home set to ${loc.label}`);
    } else {
      showToast('Could not save home — storage is unavailable');
    }
  }, [showToast]);

  // Save / unsave the current ride. The full route is persisted so it reopens through the same path.
  const toggleSaveRoute = useCallback((route: ScenicRoute) => {
    const wasSaved = isRouteSaved(saved, route.id);
    const next = toggleSavedRoute(saved, route, Date.now());
    setSaved(next);
    writeSavedRoutes(next);
    showToast(wasSaved ? `Removed “${route.name}” from saved` : `Saved “${route.name}”`);
  }, [saved, showToast]);

  const removeSaved = useCallback((id: string) => {
    setSaved((prev) => { const next = removeSavedRoute(prev, id); writeSavedRoutes(next); return next; });
  }, []);

  // Open a saved ride from the settings overlay: close settings, then show its full review.
  const openSavedRoute = useCallback((route: ScenicRoute) => {
    setSettingsOpen(false);
    selectScenic(route);
  }, [selectScenic]);

  const runScan = async () => {
    if (!map || scanning) return;
    const controller = new AbortController();
    scanController.current = controller;
    // Two Overpass queries now run in parallel (road network + scenic-feature catalog), each with
    // its own mirror failover; a wide radius can take ~25-30s when the servers are busy.
    const timeout = setTimeout(() => controller.abort(), 45000);

    setScanning(true);
    clearLayers();
    drawScanCircle(scanCenterLatLng);
    try {
      const scan = await scanArea(scanCenterLatLng, scanRadius, controller.signal);
      setAreaScan(scan);
      const rides = rebuildRides(scan, bias, loopMode);
      if (rides.length) {
        const b = L.latLngBounds(rides.flatMap((r) => r.coords.map((c) => L.latLng(c[0], c[1]))));
        if (b.isValid()) map.fitBounds(b, fitOptions());
      }
      showToast(
        rides.length
          ? `Built ${rides.length} ride${rides.length === 1 ? '' : 's'} near ${scanCenter.label} — tap one to explore`
          : 'No rides here — widen the radius or try a twistier area',
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
      setAreaScan(null);
      setScanRides([]);
    } finally {
      clearTimeout(timeout);
      scanController.current = null;
      setScanning(false);
      setHasScanned(true);
    }
  };

  const cancelScan = () => scanController.current?.abort();

  // Nudging a bias slider / preset re-ranks the SAME corpus instantly (no re-query). Skip the very
  // first run so this doesn't fire before any scan exists.
  const firstBias = useRef(true);
  useEffect(() => {
    if (firstBias.current) { firstBias.current = false; return; }
    if (tab === 'scanner' && areaScan) rebuildRides(areaScan, bias, loopMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps — intentionally keyed on bias + loopMode
  }, [bias, loopMode]);

  const applyPreset = (p: BiasPreset) => { setPresetId(p.id); setBias(p.weights); };
  const setWeight = (k: keyof BiasWeights, v: number) => {
    setPresetId('custom');
    setBias((prev) => ({ ...prev, [k]: v }));
  };

  const switchTab = (t: Tab) => {
    setTab(t);
    setScenicDetail(null);
    setReviewOpen(false);
    setActiveStopIdx(null);
    if (t === 'scanner' && map) {
      clearLayers();
      drawScanCircle(scanCenterLatLng);
      if (scanRides.length) drawRides(scanRides);
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
      <div ref={chromeRef} className="app-chrome" style={{ display: 'contents' }}>
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
          <div className="flex items-center gap-2 shrink-0">
            <div role="tablist" aria-label="Ride finder mode" className="flex items-center gap-1 bg-slate-950/60 p-1 rounded-xl border border-slate-800">
              <button role="tab" aria-selected={tab === 'scenic'} onClick={() => switchTab('scenic')} className={`px-2.5 py-2 rounded-lg text-[12px] font-bold transition-all ${tab === 'scenic' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}>Scenic</button>
              <button role="tab" aria-selected={tab === 'curated'} onClick={() => switchTab('curated')} className={`px-2.5 py-2 rounded-lg text-[12px] font-bold transition-all ${tab === 'curated' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}>Curated</button>
              <button role="tab" aria-selected={tab === 'scanner'} onClick={() => switchTab('scanner')} className={`px-2.5 py-2 rounded-lg text-[12px] font-bold transition-all ${tab === 'scanner' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}>Scan</button>
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              title="Settings"
              className="relative h-9 w-9 grid place-items-center rounded-xl bg-slate-950/60 border border-slate-800 text-slate-300 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors"
            >
              <span className="text-base" aria-hidden>⚙️</span>
              {saved.length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 grid place-items-center rounded-full bg-emerald-500 text-slate-950 text-[9px] font-black" aria-hidden>
                  {saved.length}
                </span>
              )}
            </button>
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
          <p className="text-[11px] text-slate-400 -mt-2">Can take 20–30s when the map servers are busy</p>
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
                      className={`w-full flex justify-between items-center p-3 rounded-xl border-2 active:scale-[.99] transition-all text-left ${isActive ? 'bg-emerald-500/10' : 'bg-slate-900/40'}`}
                      style={{ borderColor: r.color, boxShadow: isActive ? `0 0 0 2px ${r.color}66` : undefined }}
                    >
                      <div className="min-w-0 pr-2">
                        <h4 className="font-bold text-[13px] text-slate-100 truncate">{r.name}</h4>
                        <p className="text-[10px] text-slate-400 truncate mt-0.5">{r.theme} · {r.region} · {formatDistance(r.distanceKm, units)}</p>
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
                <h2 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Live ride builder</h2>
                <p className="text-[10px] text-slate-400">Combs the radius for twisties, scenery, greenery, water &amp; notable spots — then stitches rides</p>
              </div>
              <LocationSearch
                value={scanCenter}
                isDefault={isScanDefault}
                defaultLabel={defaultLocation.label}
                onSelect={recenterScan}
                onSetDefault={handleSetDefault}
                onUseDefault={handleUseDefault}
              />
              <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800 flex flex-col">
                <label htmlFor="scan-radius" className="text-[10px] font-bold text-slate-300">Search radius</label>
                <input id="scan-radius" type="range" min={5} max={30} value={scanRadius} aria-label="Search radius in kilometers" aria-valuetext={`${scanRadius} kilometers`} onChange={(e) => setScanRadius(+e.target.value)} />
                <div className="text-right font-mono text-emerald-400 font-bold text-sm">{scanRadius} km</div>
                <p className="text-[10px] text-slate-500 mt-1">Tip: drag the green center pin on the map to move the scan area.</p>
              </div>

              {/* Loop toggle — prefer round trips that return near the start. Re-ranks instantly. */}
              <button
                type="button"
                onClick={() => setLoopMode((m) => !m)}
                aria-pressed={loopMode}
                className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${loopMode ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-slate-950/50 border-slate-800 hover:border-emerald-500/30'}`}
              >
                <span className="text-lg shrink-0" aria-hidden>🔄</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-bold text-slate-100">Loop rides</span>
                  <span className="block text-[10px] text-slate-400 leading-snug">Round trips that come back near where you start. No loop fits? You’ll get the best there-and-back instead.</span>
                </span>
                <span className={`shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors ${loopMode ? 'bg-emerald-500' : 'bg-slate-700'}`} aria-hidden>
                  <span className={`block w-5 h-5 rounded-full bg-white shadow transition-transform ${loopMode ? 'translate-x-4' : ''}`} />
                </span>
              </button>

              {/* Bias: one-tap presets + an expandable manual mixer. Changing either re-ranks the
                  already-scanned corpus instantly — no re-query. */}
              <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-slate-300">What matters to you</span>
                  <button onClick={() => setShowWeights((s) => !s)} className="text-[10px] font-bold text-emerald-400 hover:underline py-1">
                    {showWeights ? 'Hide weights' : 'Adjust weights'}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Ride bias preset">
                  {BIAS_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => applyPreset(p)}
                      aria-pressed={presetId === p.id}
                      title={p.hint}
                      className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-all ${presetId === p.id ? 'bg-emerald-500 text-slate-950 border-emerald-400' : 'bg-slate-900/60 text-slate-300 border-slate-700 hover:border-emerald-500/40'}`}
                    >
                      {p.label}
                    </button>
                  ))}
                  {presetId === 'custom' && (
                    <span className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Custom</span>
                  )}
                </div>
                {showWeights && (
                  <div className="flex flex-col gap-1.5 pt-1">
                    {BIAS_ROWS.map(({ key, label, icon }) => {
                      const pct = Math.round(normalizeWeights(bias)[key] * 100);
                      return (
                        <div key={key} className="flex items-center gap-2">
                          <span className="w-20 shrink-0 text-[11px] font-semibold text-slate-300">{icon} {label}</span>
                          <input
                            type="range" min={0} max={1} step={0.05} value={bias[key]}
                            aria-label={`${label} importance`} aria-valuetext={`${pct} percent`}
                            onChange={(e) => setWeight(key, +e.target.value)}
                            className="flex-1"
                          />
                          <span className="w-9 shrink-0 text-right font-mono text-[11px] text-emerald-400">{pct}%</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <button onClick={runScan} disabled={scanning} className="bg-emerald-500 active:bg-emerald-600 active:scale-[.98] disabled:opacity-50 disabled:active:scale-100 text-slate-950 font-bold py-3 rounded-xl text-sm shadow-lg transition-all">{scanning ? 'Building rides…' : 'Scan & build rides'}</button>

              <div className="overflow-y-auto custom-scrollbar space-y-2" style={{ maxHeight: '34vh' }}>
                {scanRides.length === 0 ? (
                  <p className="text-[11px] text-slate-400 italic text-center py-3">{hasScanned ? 'No rides matched here — widen the radius, lighten the bias, or try a twistier area.' : 'Catalogs real roads, water, woods, viewpoints and landmarks in your radius, then stitches rides ranked by your bias. Tap a ride — or its line on the map — for the full review.'}</p>
                ) : (
                  scanRides.map((r) => (
                    <button key={r.id} onClick={(e) => selectScenic(r, e.currentTarget)} aria-current={scenicDetail?.id === r.id ? 'true' : undefined} style={{ borderColor: r.color, boxShadow: scenicDetail?.id === r.id ? `0 0 0 2px ${r.color}66` : undefined }} className={`w-full flex justify-between items-center gap-2 p-3 rounded-xl border-2 active:scale-[.99] transition-all text-left ${scenicDetail?.id === r.id ? 'bg-emerald-500/10' : 'bg-slate-900/40'}`}>
                      <div className="min-w-0 pr-1">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.color }} aria-hidden />
                          <h4 className="font-bold text-[13px] text-slate-100 truncate">{r.name}</h4>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate mt-0.5">{r.theme} · {formatDistance(r.distanceKm, units)} · 🌀{r.rubric.curvature.toFixed(1)} 💧{r.rubric.water.toFixed(1)} 🌲{r.rubric.greenery.toFixed(1)} 📍{r.rubric.notability.toFixed(1)}</p>
                      </div>
                      <span className="font-mono text-[13px] font-black text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded-lg shrink-0">{r.score}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Settings overlay — themed with the chrome (inside .app-chrome), above the panel/header */}
      {settingsOpen && (
        <SettingsMenu
          prefs={prefs}
          onChangePrefs={changePrefs}
          home={defaultLocation}
          onChangeHome={handleChangeHome}
          saved={saved}
          onOpenSaved={openSavedRoute}
          onRemoveSaved={removeSaved}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      </div>

      {/* Full-page review overlay — shared by scenic, curated AND scan-built rides */}
      {reviewOpen && scenicDetail && (
        <ScenicRouteReview
          route={scenicDetail}
          onBack={closeReview}
          onLocate={locateStop}
          origin={tab === 'scanner' ? scanCenterLatLng : homeCenter}
          units={units}
          isSaved={savedIds.has(scenicDetail.id)}
          onToggleSave={() => toggleSaveRoute(scenicDetail)}
        />
      )}
    </div>
  );
}
