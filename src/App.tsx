import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import { useLeafletMap } from './hooks/useLeafletMap';
import { useBottomSheet } from './hooks/useBottomSheet';
import { OverpassError, type AreaScan } from './lib/overpass';
import { fetchAreaScan } from './lib/areaSource';
import { buildRides } from './lib/routeBuilder';
import { BIAS_PRESETS, normalizeWeights, type BiasWeights, type BiasPreset } from './lib/composite';
import { CURATED_ROUTES } from './data/curatedRoutes';
import { SCENIC_ROUTES } from './data/scenicRoutes';
import { loadDefaultLocation, saveDefaultLocation, type SavedLocation } from './lib/settings';
import { loadPreferences, updatePreferences, applyTheme, type Preferences } from './lib/preferences';
import {
  loadSavedRoutes, writeSavedRoutes, toggleSavedRoute, removeSavedRoute, isRouteSaved,
  mergeSavedRoutes, type SavedRoute,
} from './lib/savedRoutes';
import {
  loadScanHistory, writeScanHistory, addScanRecord, removeScanRecord, makeScanRecord,
  mergeScanHistory, type ScanRecord,
} from './lib/scanHistory';
import { getAccount, onAuthChange, AUTH_ENABLED, type Account } from './lib/account';
import {
  pullSavedRides, pushSavedRide, pushSavedRides, deleteSavedRide,
  pullScanHistory, pushScanRecord, deleteScanRecord,
  pullPublicRides, publishRide, unpublishRide, pullMyPublished, toggleReaction, pullMyReactions,
  type PublicRide,
} from './lib/cloudSync';
import { formatDistance, toUnits, fromUnits, distanceLabel } from './lib/units';
import { reverseGeocode } from './lib/geocode';
import { googleMapsUrl } from './lib/mapsUrl';
import { LocationSearch } from './components/LocationSearch';
import { ScenicRouteReview } from './components/ScenicRouteReview';
import { SettingsMenu } from './components/SettingsMenu';
import {
  ReelPanel, markColor, dayAnchor, holdInstant, peakInstant, reelPool, reelShortlist,
  toDateInput, toTimeInput, REEL_REBUILD_DEBOUNCE_MS, type ReelView,
} from './components/ReelPanel';
import { buildShootRide, type ShootRide } from './lib/reelRoute';
import { enrichMarks, type ReelOptions } from './lib/reelScore';
import { shootWindow } from './lib/reelPlan';
import { REEL_WEIGHTS, type CameraAim, type ReelMark, type ReelMetrics } from './lib/reelTypes';
import { KIND_ICON } from './lib/scenicMeta';
import type { ScenicRoute, ScenicStop } from './data/types';
import { offsetPath, type LatLng } from './lib/geometry';

/** Bias-slider rows (label per rubric dimension), in display order. */
const BIAS_ROWS: { key: keyof BiasWeights; label: string; icon: string }[] = [
  { key: 'curvature', label: 'Twisties', icon: '🌀' },
  { key: 'gradeDrama', label: 'Elevation', icon: '⛰️' },
  { key: 'scenery', label: 'Scenery', icon: '🌄' },
  { key: 'greenery', label: 'Greenery', icon: '🌲' },
  { key: 'water', label: 'Water', icon: '💧' },
  { key: 'notability', label: 'Notable', icon: '📍' },
];

type Tab = 'scenic' | 'curated' | 'scanner' | 'reel' | 'community';

/** Mode tabs, in display order. Driven off a list so the mobile (full-width, wrapped onto its own
 *  row) and desktop (inline) layouts can't drift apart. */
const TABS: { id: Tab; label: string }[] = [
  { id: 'scenic', label: 'Scenic' },
  { id: 'curated', label: 'Curated' },
  { id: 'scanner', label: 'Scan' },
  { id: 'reel', label: 'Reel' },
  { id: 'community', label: 'Community' },
];

/** Resolve a saved bias-preset id back to its preset (falls back to the first/Balanced). */
const presetById = (id: string) => BIAS_PRESETS.find((p) => p.id === id) ?? BIAS_PRESETS[0];

const SCENIC_SORTED = [...SCENIC_ROUTES].sort((a, b) => b.score - a.score);
const CURATED_SORTED = [...CURATED_ROUTES].sort((a, b) => b.score - a.score);
const escapeHtml = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
const SCAN_CIRCLE = { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.04, weight: 1, dashArray: '5,8' };
// A loop ride's dashed "way back to the start" leg. A `retrace` return is offset this many metres
// beside the outbound line so the round trip reads as two passes; a `circuit` return rides its own
// (different) connector roads and is drawn as-is.
const RETURN_OFFSET_M = 45;
const RETURN_DASH = { weight: 3, opacity: 0.7, dashArray: '3,9', lineCap: 'round' as const };

/** A loop ride's return leg, ready to draw (offset for a retrace, on its own roads for a circuit). */
function returnDrawCoords(r: ScenicRoute): LatLng[] | null {
  if (!r.returnCoords || r.returnCoords.length < 2) return null;
  return r.returnKind === 'retrace' ? offsetPath(r.returnCoords, RETURN_OFFSET_M) : r.returnCoords;
}

/** All coords a ride occupies (fun road + its return leg), for fitBounds. */
function routeBoundsCoords(r: ScenicRoute): LatLng[] {
  return r.returnCoords?.length ? [...r.coords, ...r.returnCoords] : r.coords;
}

// --- Reel tab helpers ---------------------------------------------------------------------------
//
// The wall-clock arithmetic (`instantFrom`, `holdInstant`, `dayAnchor`, `peakInstant`) lives in
// ReelPanel.tsx, beside the two inputs it parses. It used to live here, untested, and that is not a
// coincidence: this module imports Leaflet, which touches `document` at load, so nothing in it can
// be reached by a unit test at all.

/**
 * A mark on the map is an ARROW, not a dot.
 *
 * Direction of travel is half of what this feature outputs — the same 400 m of road ridden the
 * other way is a different mark, with the backdrop on the other side and the sun moved from ahead
 * to behind — and a dot cannot say which way to ride. The glyph rotates to `travelBearingDeg`; the
 * rank badge is outside the rotated element so it stays upright and legible at any bearing.
 */
function reelMarkIcon(bearingDeg: number, color: string, rank: number, active: boolean): L.DivIcon {
  const size = active ? 40 : 32;
  return L.divIcon({
    className: '',
    html:
      `<div style="position:relative;width:${size}px;height:${size}px">` +
      `<div style="width:100%;height:100%;transform:rotate(${bearingDeg.toFixed(1)}deg)">` +
      `<svg viewBox="0 0 24 24" width="${size}" height="${size}">` +
      `<circle cx="12" cy="12" r="10.5" fill="#020617" fill-opacity=".82" stroke="${color}" stroke-width="${active ? 2.6 : 1.8}"/>` +
      `<path d="M12 4.4 L17.4 17.2 L12 14.3 L6.6 17.2 Z" fill="${color}"/>` +
      `</svg></div>` +
      `<div style="position:absolute;left:50%;top:100%;transform:translate(-50%,-3px);` +
      `font:800 9px/1.3 ui-sans-serif,system-ui,sans-serif;color:#e2e8f0;background:rgba(2,6,23,.85);` +
      `border-radius:4px;padding:0 3px">${rank}</div></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

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
  const topChromeRef = useRef<HTMLDivElement>(null);
  const [toast, setToast] = useState('Pick a scenic ride — preview the stops, then send it to Maps');

  // Rider preferences (units / default bias / theme), saved rides, scan history, and the settings
  // overlay. Preferences are local; saved rides + scan history are local-first and sync to the
  // signed-in account (Supabase) when there is one.
  const [prefs, setPrefs] = useState<Preferences>(loadPreferences);
  const [saved, setSaved] = useState<SavedRoute[]>(loadSavedRoutes);
  const [scanHistory, setScanHistory] = useState<ScanRecord[]>(loadScanHistory);
  const [account, setAccount] = useState<Account | null>(() => getAccount());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const units = prefs.units;
  const signedIn = account != null;

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
  // When on, rides that use a KNOWN-unpaved (gravel/dirt) leg are filtered out before stitching.
  const [pavedOnly, setPavedOnly] = useState(false);
  // Multi-criteria scan: the cached area corpus + the rides built from it under the current bias.
  const [areaScan, setAreaScan] = useState<AreaScan | null>(null);
  const [scanRides, setScanRides] = useState<ScenicRoute[]>([]);
  const [bias, setBias] = useState<BiasWeights>(() => presetById(prefs.defaultBiasPreset).weights);
  const [presetId, setPresetId] = useState(() => prefs.defaultBiasPreset);
  const [showWeights, setShowWeights] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const scanController = useRef<AbortController | null>(null);
  // Which half of the Scan tab is on screen. The setup form and the results list are both tall;
  // stacking them in one scroll (as this used to) buries the results under the whole form on a
  // phone. Only meaningful once a scan has produced rides — see `showScanResults`.
  const [scanView, setScanView] = useState<'setup' | 'results'>('setup');

  // Reel tab: the same area scan as above, asked a different question — not "is this road good?"
  // but "is this road good at 20:15, ridden west-to-east, with the camera boom out to the right?".
  //
  // TWO STAGES, HELD SEPARATELY (see `reelPoolRef`): the weight-independent pool of scored windows,
  // and the shortlist `reelShortlist` selects from it. `reelMarks` is that shortlist, exactly as
  // selection or `enrichMarks` returned it, and it is already ranked — nothing downstream re-scores
  // it.
  const [reelMarks, setReelMarks] = useState<ReelMark[]>([]);
  const [reelSelectedId, setReelSelectedId] = useState<string | null>(null);
  const [reelRunning, setReelRunning] = useState(false);
  const [reelRefining, setReelRefining] = useState(false);
  const [reelHasRun, setReelHasRun] = useState(false);
  const [reelView, setReelView] = useState<ReelView>('setup');
  const [reelAim, setReelAim] = useState<CameraAim>('side');
  // The chained ride. Held as state (unlike the pool) because the whole ride view and the map layer
  // render from it, and cleared whenever the shortlist beneath it moves — a ride built from marks
  // that no longer exist would draw a route to shots the rider can no longer open.
  const [reelRide, setReelRide] = useState<ShootRide | null>(null);
  const [reelRideBuilding, setReelRideBuilding] = useState(false);
  const [reelRideKm, setReelRideKm] = useState(60);
  const [reelRideLoop, setReelRideLoop] = useState(true);
  const [reelWeights, setReelWeights] = useState<ReelMetrics>(REEL_WEIGHTS);
  const [reelDate, setReelDate] = useState(() => toDateInput(new Date()));
  // Default to the middle of tonight's best light at the rider's home, so the tab opens on a real
  // evening rather than on whatever o'clock it happens to be when they first tap it.
  const [reelTime, setReelTime] = useState(() =>
    toTimeInput(peakInstant(shootWindow(dayAnchor(new Date()), [defaultLocation.lat, defaultLocation.lon]))),
  );
  const reelController = useRef<AbortController | null>(null);
  const reelRefineController = useRef<AbortController | null>(null);
  // The corpus the current marks were cut from. A ref, not state: nothing renders from it, and it
  // is read inside a debounced rebuild that must not itself be a reason to re-render.
  const reelScanRef = useRef<AreaScan | null>(null);
  /**
   * Every window of that corpus, scored in BOTH directions and not yet selected — the pool the
   * shortlist is chosen from. Same reasoning as `reelScanRef`: nothing renders from it (only the
   * shortlist does), and it is read inside two debounced effects that must not re-render on it.
   *
   * It depends on the scan, the shoot instant and the camera aim, and on NOTHING else — the weights
   * enter only at selection. That is what lets a weight slider re-select instead of rebuilding:
   * measured on a real 30 km Buffalo scan, 300 ms to build the pool against 12-14 ms to re-select
   * from it.
   */
  const reelPoolRef = useRef<ReelMark[]>([]);

  /**
   * Drop any refinement in flight.
   *
   * A refinement belongs to the marks that were on screen when it started, so ANYTHING that replaces
   * or clears those marks has to abort it first. `enrichMarks` resolves against the list it was
   * handed, not against current state, so an unaborted one puts a stale list back — most visibly
   * when a rebuild returns no marks at all, since then nothing else overwrites it and marks scored
   * for a different evening simply reappear.
   *
   * Clearing the ref means the aborted call's own `finally` will not touch `reelRefining`, so this
   * has to lower the flag itself.
   */
  const abortReelRefine = useCallback(() => {
    reelRefineController.current?.abort();
    reelRefineController.current = null;
    setReelRefining(false);
  }, []);

  // Marks are cut from one corpus around one centre, so moving the centre invalidates every one of
  // them. Declared up here because the location handlers below need it and they are defined first.
  const clearReel = useCallback(() => {
    abortReelRefine();
    reelScanRef.current = null;
    reelPoolRef.current = [];
    setReelMarks([]);
    setReelSelectedId(null);
    setReelHasRun(false);
    setReelView('setup');
  }, [abortReelRefine]);

  // Community tab: the public gallery, the rider's own published rides (route id → public id), and
  // their 👍 likes (public ride ids). `activePublic` is the gallery ride currently open in the cruise
  // page, so its live counts/like state drive the page's community controls.
  const [communityRides, setCommunityRides] = useState<PublicRide[]>([]);
  const [communitySort, setCommunitySort] = useState<'new' | 'top'>('new');
  const [communityLoading, setCommunityLoading] = useState(false);
  const [myPublished, setMyPublished] = useState<Map<string, string>>(new Map());
  const [myLikes, setMyLikes] = useState<Set<string>>(new Set());
  const [activePublic, setActivePublic] = useState<PublicRide | null>(null);
  // Live handle on the dashed scan-radius ring so the slider can resize it in place, plus a
  // visible, draggable center pin (Leaflet marker) that moves the whole scan area.
  const scanCircleRef = useRef<L.Circle | null>(null);
  const scanHandleRef = useRef<L.Marker | null>(null);
  // Latest "ring dropped at" handler, held in a ref so drawScanCircle's drag wiring never goes stale.
  const onCircleDropRef = useRef<(ll: L.LatLng) => void>(() => {});

  // The status line is an announcement, not a permanent fixture: left up it ate ~58px of a phone
  // screen forever. It stays in the DOM as a live region (so it is still announced) but drops out
  // of layout once read, which hands those pixels back to the map and the sheet.
  const [toastVisible, setToastVisible] = useState(true);
  const showToast = useCallback((m: string) => {
    setToast(m);
    setToastVisible(true);
  }, []);
  useEffect(() => {
    if (!toastVisible) return;
    const t = window.setTimeout(() => setToastVisible(false), 6000);
    return () => window.clearTimeout(t);
  }, [toast, toastVisible]);

  // Apply the chosen theme to the document root so the light-mode CSS overrides engage.
  useEffect(() => { applyTheme(prefs.theme); }, [prefs.theme]);

  // Persist a preferences change and reflect it in state immediately.
  const changePrefs = useCallback((patch: Partial<Preferences>) => {
    setPrefs(updatePreferences(patch));
  }, []);

  const savedIds = useMemo(() => new Set(saved.map((s) => s.route.id)), [saved]);

  // Track sign-in / sign-out (incl. landing back from a magic link, which resolves a session a
  // tick after mount and emits here).
  useEffect(() => onAuthChange(setAccount), []);

  // First time a rider is signed in: pull their cloud rides + scan history, merge the on-device
  // copies up (local-first, so nothing made offline is lost), and persist the union both ways.
  // Keyed on the user id so re-emits for the same session don't re-run the merge.
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    (async () => {
      const [cloudSaved, cloudHist] = await Promise.all([pullSavedRides(), pullScanHistory()]);
      if (cancelled) return;

      const mergedSaved = mergeSavedRoutes(loadSavedRoutes(), cloudSaved);
      setSaved(mergedSaved);
      writeSavedRoutes(mergedSaved);
      const cloudSavedIds = new Set(cloudSaved.map((s) => s.route.id));
      const localOnlySaved = mergedSaved.filter((s) => !cloudSavedIds.has(s.route.id));
      if (localOnlySaved.length) await pushSavedRides(localOnlySaved);

      if (cancelled) return;
      const mergedHist = mergeScanHistory(loadScanHistory(), cloudHist);
      setScanHistory(mergedHist);
      writeScanHistory(mergedHist);
      const cloudHistIds = new Set(cloudHist.map((h) => h.id));
      for (const h of mergedHist.filter((x) => !cloudHistIds.has(x.id))) {
        if (cancelled) return;
        await pushScanRecord(h);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps — keyed on the user id, not the object
  }, [account?.id]);

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
    if (tab === 'scanner' || tab === 'reel') {
      scanCircleRef.current?.setRadius(scanRadius * 1000);
    }
  }, [scanRadius, tab]);

  // fitBounds padding that keeps the drawn route clear of the panel (left dock on desktop, bottom
  // sheet on mobile) and the floating header/status chrome. On mobile the bottom padding tracks how
  // much sheet is actually on screen, so a route isn't fitted underneath an expanded sheet — but it
  // is capped, because padding approaching the viewport height leaves Leaflet no room to fit into.
  // `visibleOverride` is for callers that are about to change the snap point in the same tick: the
  // state has not re-rendered yet, so `sheet.visiblePx` still describes the OLD position.
  const fitOptions = useCallback(
    (visibleOverride?: number): L.FitBoundsOptions => {
      const visible = visibleOverride ?? sheet.visiblePx;
      return sheet.isMobile
        ? {
            paddingTopLeft: [24, 150],
            paddingBottomRight: [24, Math.min(visible + 24, Math.round(window.innerHeight * 0.45))],
          }
        : { paddingTopLeft: [424, 96], paddingBottomRight: [64, 48] };
    },
    [sheet.isMobile, sheet.visiblePx],
  );

  // Publish the floating chrome's live height so the sheet can size itself to clear it. The chrome
  // is not a fixed height: it grows with env(safe-area-inset-top), with the tab strip wrapping onto
  // its own row below 768px, and with a long status message wrapping to two lines.
  useLayoutEffect(() => {
    const el = topChromeRef.current;
    if (!el) return;
    const publish = () =>
      document.documentElement.style.setProperty('--chrome-h', `${Math.round(el.getBoundingClientRect().height)}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // While the full-page review is open, make everything behind it inert: removes it from the
  // tab order (focus trap) and blocks pointer interaction with the map/sheet underneath.
  useEffect(() => {
    const el = chromeRef.current;
    if (el) el.inert = reviewOpen;
  }, [reviewOpen]);

  // Esc collapses the raised mobile sheet (but not while the full-page review owns Esc).
  useEffect(() => {
    if (!sheet.isMobile || sheet.state === 'peek' || reviewOpen) return;
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
    setActivePublic(null); // cleared by default; openPublicRide re-sets it for a gallery ride
    setActiveStopIdx(null);
    setReviewOpen(true);
  }, []);

  // Open a community gallery ride: remember the public row (for live counts/like state), then review.
  const openPublicRide = useCallback((pr: PublicRide, originEl?: HTMLElement | null) => {
    selectScenic(pr.route, originEl);
    setActivePublic(pr);
  }, [selectScenic]);

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
      // Dashed return leg first (underneath), so the solid fun road sits on top.
      const ret = returnDrawCoords(r);
      if (ret) {
        const retHit = L.polyline(ret, { color: r.color, weight: 16, opacity: 0 });
        const retLine = L.polyline(ret, { color: r.color, ...RETURN_DASH });
        retHit.on('click', open);
        retLine.on('click', open);
        addLayer(retHit);
        addLayer(retLine);
      }
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
      const ret = returnDrawCoords(r);
      if (ret) addLayer(L.polyline(ret, { color: r.color, ...RETURN_DASH }));
      addLayer(L.polyline(r.coords, { color: r.color, weight: 5, opacity: 0.92 }));
      r.stops.forEach((s, i) => drawScenicStop(s, i, r.color, i === activeStopIdx));
      // Fit once per route — not on activeStopIdx change, so "Locate" flyTo isn't overridden.
      if (fittedRouteId.current !== r.id) {
        const b = L.polyline(routeBoundsCoords(r)).getBounds();
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
  const rebuildRides = useCallback((scan: AreaScan, b: BiasWeights, loops: boolean, paved: boolean): ScenicRoute[] => {
    // Paved-only: drop legs OSM tags as gravel/dirt (unknown surface stays — most backroads are
    // paved-but-untagged). Filters both the ride candidates and the connector roads used for returns.
    const roads = paved ? scan.roads.filter((r) => r.paved !== false) : scan.roads;
    const connectors = paved ? scan.corpus.filter((r) => r.paved !== false) : scan.corpus;
    const rides = buildRides(roads, scan.catalog, { bias: b, areaLabel: scanCenter.label, preferLoops: loops, connectors });
    setScanRides(rides);
    if (map) {
      clearLayers();
      drawScanCircle([scan.center[0], scan.center[1]]);
      drawRides(rides);
    }
    return rides;
  }, [map, clearLayers, drawScanCircle, drawRides, scanCenter.label]);

  // --- Community tab ---------------------------------------------------------------------------
  // Pull the public gallery (+ the rider's own published rides and likes) and draw the rides.
  const loadCommunity = useCallback(async (sort: 'new' | 'top') => {
    setCommunityLoading(true);
    const [rides, mine, reactions] = await Promise.all([pullPublicRides(sort), pullMyPublished(), pullMyReactions()]);
    setCommunityRides(rides);
    setMyPublished(mine);
    setMyLikes(reactions.likes);
    setCommunityLoading(false);
    if (map) {
      clearLayers();
      drawRides(rides.map((r) => r.route));
      const all = rides.flatMap((r) => routeBoundsCoords(r.route));
      if (all.length) {
        const b = L.latLngBounds(all.map((c) => L.latLng(c[0], c[1])));
        if (b.isValid()) map.fitBounds(b, fitOptions());
      } else {
        map.setView(homeCenter, 9);
      }
    }
  }, [map, clearLayers, drawRides, fitOptions, homeCenter]);

  // Publish the open ride, or unpublish it if it's already the rider's published ride.
  const handlePublishToggle = useCallback(async (route: ScenicRoute, publishedId: string | null) => {
    if (!signedIn) { showToast('Sign in (Settings) to publish a ride to the community'); return; }
    if (publishedId) {
      await unpublishRide(publishedId);
      setMyPublished((prev) => { const m = new Map(prev); m.delete(route.id); return m; });
      setActivePublic((p) => (p && p.id === publishedId ? null : p));
      setCommunityRides((prev) => prev.filter((r) => r.id !== publishedId));
      showToast(`Removed “${route.name}” from the community`);
    } else {
      const pr = await publishRide(route);
      if (pr) {
        setMyPublished((prev) => new Map(prev).set(route.id, pr.id));
        setActivePublic(pr);
        showToast(`Published “${route.name}” to the community`);
      } else {
        showToast('Could not publish — try again in a moment');
      }
    }
  }, [signedIn, showToast]);

  // Toggle the rider's 👍 on a published ride (optimistic; the trigger keeps the server count true).
  const handleLikeToggle = useCallback((publicRideId: string) => {
    if (!signedIn) { showToast('Sign in (Settings) to like community rides'); return; }
    const liked = myLikes.has(publicRideId);
    const delta = liked ? -1 : 1;
    setMyLikes((prev) => { const s = new Set(prev); if (liked) s.delete(publicRideId); else s.add(publicRideId); return s; });
    setCommunityRides((prev) => prev.map((r) => (r.id === publicRideId ? { ...r, likeCount: Math.max(0, r.likeCount + delta) } : r)));
    setActivePublic((p) => (p && p.id === publicRideId ? { ...p, likeCount: Math.max(0, p.likeCount + delta) } : p));
    void toggleReaction(publicRideId, 'like', !liked);
  }, [signedIn, myLikes, showToast]);

  // --- Location handlers (Scan tab) -------------------------------------------------------
  // Recenter the scan on a chosen place: reset prior results, redraw the radius ring, fly there.
  const recenterScan = useCallback((loc: SavedLocation) => {
    setScanCenter(loc);
    setScanRides([]);
    setAreaScan(null);
    setHasScanned(false);
    clearReel();
    if (map) {
      clearLayers();
      drawScanCircle([loc.lat, loc.lon]);
      map.setView([loc.lat, loc.lon], 10);
    }
    showToast(`Scan centered on ${loc.label}`);
  }, [map, clearLayers, drawScanCircle, showToast, clearReel]);

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
    clearReel();
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
  }, [map, clearLayers, drawScanCircle, showToast, clearReel]);

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

  // Save / unsave the current ride. The full route is persisted so it reopens through the same
  // path; when signed in the change also syncs to the rider's account (fire-and-forget — the local
  // write is the source of truth, the cloud call mirrors it).
  const toggleSaveRoute = useCallback((route: ScenicRoute) => {
    const wasSaved = isRouteSaved(saved, route.id);
    const now = Date.now();
    const next = toggleSavedRoute(saved, route, now);
    setSaved(next);
    writeSavedRoutes(next);
    if (signedIn) {
      if (wasSaved) void deleteSavedRide(route.id);
      else void pushSavedRide(route, now);
    }
    showToast(wasSaved ? `Removed “${route.name}” from saved` : `Saved “${route.name}”`);
  }, [saved, signedIn, showToast]);

  const removeSaved = useCallback((id: string) => {
    setSaved((prev) => { const next = removeSavedRoute(prev, id); writeSavedRoutes(next); return next; });
    if (signedIn) void deleteSavedRide(id);
  }, [signedIn]);

  // Open a saved ride from the settings overlay: close settings, then show its full review.
  const openSavedRoute = useCallback((route: ScenicRoute) => {
    setSettingsOpen(false);
    selectScenic(route);
  }, [selectScenic]);

  // Re-open a logged scan: surface its best (first) ride through the same review path.
  const openScanRecord = useCallback((record: ScanRecord) => {
    const best = record.rides[0];
    if (!best) return;
    setSettingsOpen(false);
    selectScenic(best);
  }, [selectScenic]);

  const removeScanRecord_ = useCallback((id: string) => {
    setScanHistory((prev) => { const next = removeScanRecord(prev, id); writeScanHistory(next); return next; });
    if (signedIn) void deleteScanRecord(id);
  }, [signedIn]);

  // Log a finished scan to history (local-first; mirrored to the account when signed in).
  const recordScan = useCallback((rides: ScenicRoute[]) => {
    if (rides.length === 0) return;
    const record = makeScanRecord(
      { center: { label: scanCenter.label, lat: scanCenter.lat, lon: scanCenter.lon }, radiusKm: scanRadius, bias, rides },
      Date.now(),
    );
    setScanHistory((prev) => { const next = addScanRecord(prev, record); writeScanHistory(next); return next; });
    if (signedIn) void pushScanRecord(record);
  }, [scanCenter, scanRadius, bias, signedIn]);

  const runScan = async () => {
    if (!map || scanning) return;
    const controller = new AbortController();
    scanController.current = controller;
    // Inside the precomputed corpus this resolves in a few hundred ms from static tiles. Outside
    // it (or if the corpus fails) it falls back to two parallel Overpass queries, each with mirror
    // failover — measured ~24s roads / ~17s scenic at the 30km max, and that latency is near-
    // constant dispatch overhead rather than payload-driven, so a busy moment moves it by seconds.
    // The budget must cover a slow lead mirror AND one full fallback attempt, or a recoverable
    // failover gets killed and reported as "servers busy". Cancel aborts the same controller.
    const timeout = setTimeout(() => controller.abort(), 100000);

    setScanning(true);
    clearLayers();
    drawScanCircle(scanCenterLatLng);
    try {
      const { scan } = await fetchAreaScan(scanCenterLatLng, scanRadius, controller.signal);
      setAreaScan(scan);
      const rides = rebuildRides(scan, bias, loopMode, pavedOnly);
      if (rides.length) {
        // Show the rides, and raise the sheet to `half` so the list and the drawn routes are both
        // on screen — the results are the point of the scan, not a footnote under the form.
        setScanView('results');
        sheet.snapTo('half');
        const b = L.latLngBounds(rides.flatMap((r) => routeBoundsCoords(r).map((c) => L.latLng(c[0], c[1]))));
        if (b.isValid()) map.fitBounds(b, fitOptions(Math.round(window.innerHeight * 0.5)));
        recordScan(rides); // log this scan to history (local + cloud when signed in)
      } else {
        setScanView('setup');
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

  // --- Reel tab --------------------------------------------------------------------------------

  /**
   * The instant everything Reel is scored for: the one the rider named, HELD through a half-typed
   * one.
   *
   * An `<input type="date">` emits `''` while it is being edited. `instantFrom` used to fall back to
   * `new Date()` there, so every transient empty value became a distinct instant: it cleared the
   * rebuild debounce on its own, rescored the whole pool, and fired Open-Meteo requests for whatever
   * o'clock it happened to be — and the rider was shown scores for an evening they never asked for.
   * The entire category is about a specific time, so silently scoring a different one is the worst
   * available answer.
   *
   * Holding returns the previous Date BY IDENTITY, which is what makes the fix complete rather than
   * cosmetic: `reelOpts` does not re-memo, and the rebuild effect below keys on `reelAt.getTime()`,
   * so an incomplete input does not merely score correctly — it does no work at all. The panel says
   * which instant is in force while the pair is incomplete.
   *
   * Both initial values are built from `new Date()` above, so the first pass always names a real
   * instant; the `new Date()` seed only exists to keep the ref total.
   */
  const heldReelAt = useRef<Date | null>(null);
  const reelAt = useMemo(() => {
    const held = holdInstant(heldReelAt.current ?? new Date(), reelDate, reelTime);
    heldReelAt.current = held;
    return held;
  }, [reelDate, reelTime]);
  const reelShoot = useMemo(() => shootWindow(dayAnchor(reelAt), scanCenterLatLng), [reelAt, scanCenterLatLng]);
  const reelOpts = useMemo<ReelOptions>(
    () => ({ at: reelAt, aim: reelAim, weights: reelWeights }),
    [reelAt, reelAim, reelWeights],
  );
  // The live opts, held in a ref so the three effects below can read them without themselves being
  // keyed on every field. Each of those effects is keyed on the ONE input it responds to: the pool
  // rebuild on the instant and the aim, the re-selection on the weights.
  const reelOptsRef = useRef(reelOpts);
  useEffect(() => { reelOptsRef.current = reelOpts; }, [reelOpts]);

  // `reelMarks` arrives ranked from `reelShortlist`/`enrichMarks` and is NOT re-scored here. It used
  // to be: App applied the rider's weights with a `.map(reelComposite).sort()` over the shortlist,
  // which re-ordered a set of marks the OLD weights had already selected. See `reelShortlist` in
  // ReelPanel.tsx for the measurement that killed it, and the weight effect below for what replaces
  // it.
  const reelSelected = useMemo(
    () => reelMarks.find((m) => m.id === reelSelectedId) ?? null,
    [reelMarks, reelSelectedId],
  );

  const selectReelMark = useCallback((m: ReelMark | null) => {
    setReelSelectedId(m?.id ?? null);
    if (!m) return;
    setReelView('shots');
    // Tapping an arrow on the map with the sheet collapsed would otherwise open a card nobody can
    // see. From the list the sheet is already up, so this is a no-op there.
    if (sheet.state === 'peek') sheet.snapTo('full');
  }, [sheet.state, sheet.snapTo]);

  // Latest select handler, held in a ref so the marker wiring below never goes stale and the whole
  // layer set does not get rebuilt every time the sheet snaps. Same idiom as onCircleDropRef.
  const onReelSelectRef = useRef<(m: ReelMark | null) => void>(() => {});
  useEffect(() => { onReelSelectRef.current = selectReelMark; }, [selectReelMark]);

  // Each mark is drawn as the actual 400 m stretch plus an arrow at its midpoint pointing the way
  // to ride it. The stretch matters as much as the pin: a rider needs to see which piece of road
  // the card is talking about, not just roughly where it is.
  const drawReelMarks = useCallback((marks: ReelMark[], selectedId: string | null) => {
    marks.forEach((m, i) => {
      const color = markColor(m);
      const active = m.id === selectedId;
      const open = () => onReelSelectRef.current(m);
      const hit = L.polyline(m.window.pts, { color, weight: 18, opacity: 0 });
      const line = L.polyline(m.window.pts, { color, weight: active ? 6 : 4, opacity: active ? 1 : 0.85 });
      hit.on('click', open);
      line.on('click', open);
      addLayer(hit);
      addLayer(line);
      const arrow = L.marker(m.window.mid, {
        icon: reelMarkIcon(m.travelBearingDeg, color, i + 1, active),
        zIndexOffset: active ? 1000 : 0,
      });
      arrow.on('click', open);
      addLayer(arrow);
    });
  }, [addLayer]);

  // Exactly what the map draws, as a string: the marks in rank order, each with the two things the
  // arrow encodes. Redrawing on the array's identity instead would rebuild ~120 Leaflet layers on
  // every step of a weight or radius slider — the arrays are new objects each time even when not one
  // arrow moved. The radius ring is exempt for the same reason and stays live through the in-place
  // `setRadius` effect above, exactly as the Scan tab already does it.
  const reelDrawKey = useMemo(
    () => reelMarks.map((m) => `${m.id}:${Math.round(m.travelBearingDeg)}:${m.backdropSide ?? '-'}`).join('|'),
    [reelMarks],
  );

  /**
   * The transit half of a chained ride: everything between the shots.
   *
   * The shot legs are deliberately NOT drawn here. `drawReelMarks` already draws that same ground as
   * a numbered, tappable mark, and a second polyline over it would only be a heavier line that opens
   * nothing when tapped. Connectors are slate and quiet because they are the part of the evening the
   * rider is not filming; the way home is dashed, the same idiom the Scan tab's loops already use.
   */
  const drawReelRide = useCallback((ride: ShootRide) => {
    for (const leg of ride.legs) {
      if (leg.kind === 'shot') continue;
      addLayer(
        L.polyline(
          leg.coords,
          leg.kind === 'return'
            ? { color: '#38bdf8', ...RETURN_DASH }
            : { color: '#64748b', weight: 3, opacity: 0.85 },
        ),
      );
    }
    addLayer(
      L.circleMarker(ride.start, {
        radius: 6,
        color: '#10b981',
        fillColor: '#022c22',
        fillOpacity: 1,
        weight: 2,
      }).bindTooltip('Ride starts here'),
    );
  }, [addLayer]);

  const reelRideDrawKey = useMemo(
    () => (reelRide ? `${reelRide.shots.map((s) => s.mark.id).join('|')}@${Math.round(reelRide.km * 100)}` : ''),
    [reelRide],
  );

  // All Reel drawing lives here rather than being scattered through the handlers, so the map is a
  // pure function of (marks, selection, ride) and cannot fall out of step with the list.
  useEffect(() => {
    if (!ready || !map || tab !== 'reel') return;
    clearLayers();
    drawScanCircle(scanCenterLatLng);
    // In the ride view the marks drawn are the RIDE's, in riding order — `drawReelMarks` numbers by
    // array position, so passing the ride's own shots is what makes the number on the map the number
    // in the itinerary. Drawing the whole shortlist here instead would put shortlist ranks on a map
    // of a ride that visits them in a different order, which is the one confusion worth spending a
    // branch to avoid.
    if (reelView === 'ride' && reelRide) {
      drawReelRide(reelRide);
      drawReelMarks(reelRide.shots.map((s) => s.mark), reelSelectedId);
    } else {
      drawReelMarks(reelMarks, reelSelectedId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps — keyed on what is drawn, not on identity
  }, [ready, map, tab, reelDrawKey, reelSelectedId, reelView, reelRideDrawKey]);

  /**
   * Chain the shortlist into one ride.
   *
   * Deferred by a turn of the event loop rather than run inline: the build is pure CPU (one graph
   * search per candidate, then an exact tour) and blocking the click handler would leave the button
   * showing its idle label for the whole of it. The delay buys the pending state a paint, nothing
   * more — there is no network here to wait on.
   */
  const buildReelRide = useCallback(() => {
    const scan = reelScanRef.current;
    if (!scan || !reelMarks.length) return;
    setReelRideBuilding(true);
    setTimeout(() => {
      try {
        setReelRide(
          buildShootRide(reelMarks, scan, {
            from: scanCenterLatLng,
            targetKm: reelRideKm,
            loop: reelRideLoop,
            departAt: reelAt,
            window: reelShoot,
          }),
        );
      } catch {
        // A ride is a convenience over a shortlist that is already on screen and already useful, so
        // a failure to chain must not take the shortlist down with it.
        setReelRide(null);
      } finally {
        setReelRideBuilding(false);
      }
    }, 0);
  }, [reelMarks, scanCenterLatLng, reelRideKm, reelRideLoop, reelAt, reelShoot]);

  // A ride outlives nothing. The moment the shortlist beneath it moves — a new scan, a weight nudge,
  // the refinement landing — the ride is about marks that may no longer be on screen, so it goes.
  const reelMarkIds = useMemo(() => reelMarks.map((m) => m.id).join('|'), [reelMarks]);
  useEffect(() => {
    setReelRide(null);
  }, [reelMarkIds]);

  /** The whole ride as one navigable link: the fun and the transit, with the way home as the return. */
  const reelRideHref = useMemo(() => {
    if (!reelRide) return null;
    const back = reelRide.legs.find((l) => l.kind === 'return');
    const out = reelRide.legs.filter((l) => l.kind !== 'return').flatMap((l) => l.coords);
    if (out.length < 2) return null;
    return googleMapsUrl(out, {
      origin: reelRide.start,
      ...(back ? { returnCoords: back.coords } : {}),
    });
  }, [reelRide]);

  /**
   * Stage two: refine an already-ranked shortlist with the DEM lateral fall and the built-up query.
   *
   * Never blocks and never invalidates stage one — `enrichMarks` degrades to returning its input if
   * both lookups fail, so the worst case is that the list stays provisional and says so. Aborting
   * the previous refinement matters: the built-up query is ~20-25s of near-constant Overpass
   * dispatch overhead, so two of them overlapping would land out of order.
   */
  const refineReel = useCallback(async (marks: ReelMark[], scan: AreaScan, opts: ReelOptions) => {
    reelRefineController.current?.abort();
    const controller = new AbortController();
    reelRefineController.current = controller;
    setReelRefining(true);
    try {
      const refined = await enrichMarks(marks, scan, opts, controller.signal);
      if (!controller.signal.aborted) setReelMarks(refined);
    } catch {
      // enrichMarks swallows its own failures by contract; this is only here so a future throw
      // cannot leave the rider staring at a spinner over a list that is already perfectly usable.
    } finally {
      if (reelRefineController.current === controller) {
        reelRefineController.current = null;
        setReelRefining(false);
      }
    }
  }, []);

  /**
   * Select the shortlist the rider's current weights earn from a held pool, and start its
   * refinement. Returns the shortlist so a caller can fit the map to it.
   *
   * The single path from pool to screen, shared by all three things that change what is on it — the
   * scan itself, the debounced instant/aim rebuild, and the weight sliders — so there is exactly one
   * place that decides what a mark list is.
   *
   * The refinement is re-run rather than carried across a re-selection, and re-running it is nearly
   * free: `fetchLateralFall` caches by window id and `fetchBuiltIndex` by centre+radius, so a
   * selection that keeps the same windows costs ZERO requests. That is the same cache
   * REEL_REBUILD_DEBOUNCE_MS's comment leans on, and it is why a weight change no longer has to
   * choose between selecting correctly and keeping the DEM readings.
   */
  const applyReelPool = useCallback((pool: ReelMark[], scan: AreaScan, opts: ReelOptions) => {
    const marks = reelShortlist(pool, opts);
    // Before the marks are replaced, not after: the refinement in flight belongs to the OLD
    // shortlist, and if this selection returns nothing there is no later call to abort it.
    abortReelRefine();
    setReelMarks(marks);
    if (marks.length) void refineReel(marks, scan, opts);
    return marks;
  }, [abortReelRefine, refineReel]);

  const runReel = async () => {
    if (!map || reelRunning) return;
    const controller = new AbortController();
    reelController.current = controller;
    // Same budget as runScan, and for the same reason: inside the tile corpus this is a few hundred
    // ms, outside it the fallback is two Overpass queries with mirror failover.
    const timeout = setTimeout(() => controller.abort(), 100000);

    setReelRunning(true);
    try {
      const { scan } = await fetchAreaScan(scanCenterLatLng, scanRadius, controller.signal);
      reelScanRef.current = scan;
      const opts = reelOptsRef.current;
      // Both halves are synchronous and network-free, so the list is on screen before the refinement
      // is even asked for. That two-stage shape is the whole point of the category's architecture.
      const pool = reelPool(scan, opts);
      reelPoolRef.current = pool;
      const marks = applyReelPool(pool, scan, opts);
      setReelSelectedId(null);
      if (marks.length) {
        setReelView('shots');
        sheet.snapTo('half');
        const b = L.latLngBounds(marks.flatMap((m) => m.window.pts.map((p) => L.latLng(p[0], p[1]))));
        if (b.isValid()) map.fitBounds(b, fitOptions(Math.round(window.innerHeight * 0.5)));
      } else {
        setReelView('setup');
      }
      showToast(
        marks.length
          ? `${marks.length} filmable stretch${marks.length === 1 ? '' : 'es'} near ${scanCenter.label} — tap one for the shoot card`
          : 'Nothing here reads as filmable — widen the radius or try another evening',
      );
    } catch (e) {
      const kind = e instanceof OverpassError ? e.kind : 'network';
      showToast(
        kind === 'timeout'
          ? 'OpenStreetMap servers are busy right now — wait a moment and retry, or use a smaller radius'
          : kind === 'http'
            ? 'OpenStreetMap is busy — retry in a moment'
            : 'Could not read this area — check your connection',
      );
      abortReelRefine();
      reelScanRef.current = null;
      reelPoolRef.current = [];
      setReelMarks([]);
    } finally {
      clearTimeout(timeout);
      reelController.current = null;
      setReelRunning(false);
      setReelHasRun(true);
    }
  };

  const cancelReel = () => reelController.current?.abort();

  // Moving the shoot instant or the camera rebuilds the POOL against the corpus already in hand — no
  // re-query. Only these two, because they are the only inputs that change a mark's LIGHT, and light
  // is the one dimension that depends on when the rider is there. The weights are deliberately NOT
  // in this key: they cannot change a window's metrics at all, only which windows are selected, and
  // that is the cheap half (see the effect below). Debounced (see REEL_REBUILD_DEBOUNCE_MS for what
  // that does and does NOT buy) and skipped on the first run so it does not fire before any scan.
  // `reelAt` holds the last instant the rider actually named, so a half-typed date never reaches
  // this effect at all.
  const firstReelBuild = useRef(true);
  useEffect(() => {
    if (firstReelBuild.current) { firstReelBuild.current = false; return; }
    const scan = reelScanRef.current;
    if (!scan) return;
    let frame = 0;
    const t = window.setTimeout(() => {
      // Yield a frame first: scoring the pool is measured at ~300 ms for a whole scan and it runs on
      // the main thread, so without this the changed control appears to swallow the input and only
      // repaint once the work is done.
      frame = window.requestAnimationFrame(() => {
        const opts = reelOptsRef.current;
        const pool = reelPool(scan, opts);
        reelPoolRef.current = pool;
        applyReelPool(pool, scan, opts);
      });
    }, REEL_REBUILD_DEBOUNCE_MS);
    return () => { window.clearTimeout(t); window.cancelAnimationFrame(frame); };
    // eslint-disable-next-line react-hooks/exhaustive-deps — intentionally keyed on the shoot instant + aim
  }, [reelAt.getTime(), reelAim]);

  /**
   * Moving a weight slider RE-SELECTS from the held pool. It must never re-sort the shortlist.
   *
   * This is the whole reason the pool is held. Both non-max suppression and the mark limit consume
   * `mark.score`, so the weights in force decide WHICH ~40 of a scan's ~1,400 windows survive, not
   * merely what order they come back in — reelScore.ts says so in as many words. App used to
   * `.map(reelComposite).sort()` the shortlist instead, and measured on the real corpus with drama
   * weighted to 1 and everything else 0 that left 37 of the 40 correct marks unreachable: the top-5
   * drama read 10, 10, 10, 8.6, 6.5 against a true 10, 10, 10, 10, 10.
   *
   * Nothing is re-scored from the road geometry here — the pool is weight-independent by
   * construction, so this is the 12-14 ms half rather than the 300 ms one, and it needs no frame
   * yield.
   *
   * Debounced on the same timer as the rebuild above for a plainer reason than that one has: a
   * dragged `<input type="range">` emits a change per pointer move, and 12-14 ms of selection at
   * that rate is most of a frame budget spent re-ranking a list the rider has not stopped moving.
   *
   * TWO CONSEQUENCES A READER SHOULD EXPECT, both of them the honest behaviour rather than bugs.
   * A mark the new weights do not select is genuinely no longer in the shortlist, so an open shoot
   * card for it closes back to the list — `reelSelected` resolves against `reelMarks`. And if a
   * weight moves and then the shoot instant moves inside the same 700 ms, this fires first against a
   * pool still scored for the previous instant; the rebuild above lands right behind it and replaces
   * both. What is on screen in between is what was already on screen, re-selected.
   */
  const firstReelSelect = useRef(true);
  useEffect(() => {
    if (firstReelSelect.current) { firstReelSelect.current = false; return; }
    const scan = reelScanRef.current;
    if (!scan || !reelPoolRef.current.length) return;
    const t = window.setTimeout(() => {
      applyReelPool(reelPoolRef.current, scan, reelOptsRef.current);
    }, REEL_REBUILD_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [reelWeights, applyReelPool]);

  // A dropped tab or a closed page should not leave an Overpass query and a DEM batch running.
  useEffect(() => () => {
    reelController.current?.abort();
    reelRefineController.current?.abort();
  }, []);

  const setReelWeight = (k: keyof ReelMetrics, v: number) =>
    setReelWeights((prev) => ({ ...prev, [k]: v }));

  // Snap the shoot time to the middle of the evening's best light for the date already chosen. The
  // peak can land on the next local day at extreme longitudes, so the date moves with it.
  const useReelPeakLight = () => {
    const peak = peakInstant(reelShoot);
    setReelDate(toDateInput(peak));
    setReelTime(toTimeInput(peak));
  };

  const locateReelMark = useCallback((m: ReelMark) => {
    if (!map) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) map.setView(m.window.mid, 15);
    else map.flyTo(m.window.mid, 15, { duration: 0.8 });
    showToast(`Showing ${m.roadName || 'this stretch'} on the map`);
  }, [map, showToast]);

  // Nudging a bias slider / preset re-ranks the SAME corpus instantly (no re-query). Skip the very
  // first run so this doesn't fire before any scan exists.
  const firstBias = useRef(true);
  useEffect(() => {
    if (firstBias.current) { firstBias.current = false; return; }
    if (tab === 'scanner' && areaScan) rebuildRides(areaScan, bias, loopMode, pavedOnly);
    // eslint-disable-next-line react-hooks/exhaustive-deps — intentionally keyed on bias + loop + paved
  }, [bias, loopMode, pavedOnly]);

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
      setScanView(scanRides.length ? 'results' : 'setup'); // coming back to a finished scan shows its rides
      clearLayers();
      drawScanCircle(scanCenterLatLng);
      if (scanRides.length) drawRides(scanRides);
      map.setView(scanCenterLatLng, 10);
    } else if (t === 'reel' && map) {
      // Only the view; the marks and the ring are drawn by the Reel effect, which owns that map
      // state outright so the arrows can never disagree with the list.
      setReelSelectedId(null);
      map.setView(scanCenterLatLng, 10);
    } else if (t === 'community') {
      setActivePublic(null);
      void loadCommunity(communitySort);
    }
  };

  // Reload the gallery when the sort flips (only while the Community tab is open).
  useEffect(() => {
    if (tab === 'community') void loadCommunity(communitySort);
    // eslint-disable-next-line react-hooks/exhaustive-deps — keyed on the sort toggle
  }, [communitySort]);

  const browsing = tab === 'scenic' || tab === 'curated';
  const browseTitle = tab === 'curated' ? 'Curated rides' : 'Scenic rides';
  const browseSubtitle =
    tab === 'curated'
      ? 'Hand-picked classics · road-snapped · measured curvature · tap to review'
      : 'Agent-generated · scenery-scored · judge-ranked · tap to review';

  // Scan tab: once a scan lands, its rides REPLACE the setup form rather than sitting below it.
  const showScanResults = tab === 'scanner' && scanRides.length > 0 && scanView === 'results';

  // The Reel tab's primary action, shaped exactly like `scanAction` so the pinned mobile bar can
  // carry either one without knowing which tab it is on.
  const reelAction = (
    <button
      onClick={runReel}
      disabled={reelRunning}
      className="w-full bg-emerald-500 active:bg-emerald-600 active:scale-[.98] disabled:opacity-50 disabled:active:scale-100 text-slate-950 font-bold min-h-[48px] rounded-xl text-sm shadow-lg transition-all"
    >
      {reelRunning ? 'Reading the roads…' : reelMarks.length ? 'Find shots again' : 'Find the shots'}
    </button>
  );

  // The Scan tab's primary action. On mobile it is pinned to the bottom of the sheet so it is
  // reachable at every snap point; on desktop it stays in the form's normal flow.
  const scanAction = (
    <button
      onClick={runScan}
      disabled={scanning}
      className="w-full bg-emerald-500 active:bg-emerald-600 active:scale-[.98] disabled:opacity-50 disabled:active:scale-100 text-slate-950 font-bold min-h-[48px] rounded-xl text-sm shadow-lg transition-all"
    >
      {scanning ? 'Building rides…' : scanRides.length ? 'Rescan this area' : 'Scan & build rides'}
    </button>
  );
  // The Scan tab's pinned bar: where the scan is centred, how wide, and the action. It sits in the
  // sheet's TOP region (see below) so it is on screen at every snap point, peek included.
  const mobileAction =
    sheet.isMobile && (tab === 'scanner' || tab === 'reel') ? (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[11px] min-w-0">
          <span className="shrink-0" aria-hidden>📍</span>
          <span className="truncate font-semibold text-slate-200">{scanCenter.label}</span>
          <span className="ml-auto shrink-0 font-mono font-bold text-emerald-400">
            {Math.round(toUnits(scanRadius, units))} {distanceLabel(units)}
          </span>
        </div>
        {tab === 'scanner' ? scanAction : reelAction}
      </div>
    ) : null;

  return (
    <div className="relative w-full h-full overflow-hidden bg-slate-950 text-slate-100">
      <div ref={chromeRef} className="app-chrome" style={{ display: 'contents' }}>
      <div id="map" className="absolute inset-0 z-0" />

      {/* Top chrome: header + status stacked in ONE flow container. They used to be two absolutely
          positioned boxes, the status pinned at a hardcoded `top-24` — so the moment the header grew
          (safe-area inset on a notched phone, or the tab row wrapping) the status slid underneath it.
          `pointer-events-none` on the stack keeps the map draggable in the gaps between the cards. */}
      <div
        ref={topChromeRef}
        className="absolute top-0 left-0 right-0 z-[1200] p-3 flex flex-col gap-2 pointer-events-none"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        {/* Mobile: wordmark + gear on one row, full-width tab strip wrapped onto the next (the four
            labels cannot fit beside the wordmark at 360–390px). Desktop: all three inline. */}
        <div className="pointer-events-auto w-full max-w-2xl mx-auto bg-slate-900/95 backdrop-blur-md px-3 py-2.5 md:px-4 md:py-3 rounded-2xl shadow-2xl border border-slate-800 flex flex-wrap items-center gap-2">
          <div className="order-1 min-w-0 flex-1">
            <h1 className="text-sm font-black tracking-tight text-white flex items-center gap-1.5">
              SINUOSITY <span className="text-[9px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded font-bold uppercase">Beta</span>
            </h1>
            <p className="text-[10px] text-slate-400 mt-0.5 truncate">Twisty + scenic backroads · scout anywhere</p>
          </div>
          <div role="tablist" aria-label="Ride finder mode" className="order-3 md:order-2 w-full md:w-auto flex items-center gap-0.5 bg-slate-950/60 p-1 rounded-xl border border-slate-800">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => switchTab(t.id)}
                // Mobile padding and type step down at five tabs: at 360px the strip has ~59px per
                // tab, and "Community" needs every one of them. Desktop is unchanged.
                className={`flex-1 md:flex-none min-h-[44px] px-0.5 md:px-3 rounded-lg text-[10px] md:text-[11px] leading-tight font-bold transition-all ${tab === t.id ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title="Settings"
            className="order-2 md:order-3 relative h-11 w-11 shrink-0 grid place-items-center rounded-xl bg-slate-950/60 border border-slate-800 text-slate-300 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors"
          >
            <span className="text-base" aria-hidden>⚙️</span>
            {saved.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 grid place-items-center rounded-full bg-emerald-500 text-slate-950 text-[9px] font-black" aria-hidden>
                {saved.length}
              </span>
            )}
          </button>
        </div>

        <div
          role="status"
          aria-live="polite"
          className={
            toastVisible
              ? 'pointer-events-auto w-full max-w-2xl mx-auto bg-slate-900/95 border border-emerald-500/30 px-3 py-2.5 rounded-xl shadow-xl flex items-center gap-2.5 animate-fadeIn'
              : 'sr-only'
          }
        >
          <span className="text-base shrink-0" aria-hidden>🛰️</span>
          <span className="text-xs text-slate-200 font-medium">{toast}</span>
        </div>
      </div>

      {/* Loader. Only the corpus fetch blocks — the Reel refinement deliberately does not, and
          shows itself as a quiet note beside the list instead. */}
      {(scanning || reelRunning) && (
        <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm z-[1300] flex flex-col justify-center items-center gap-4">
          <div className="relative w-14 h-14">
            <div className="absolute inset-0 rounded-full border-4 border-emerald-500/20" />
            <div className="absolute inset-0 rounded-full border-4 border-emerald-500 border-t-transparent animate-spin" />
          </div>
          <p className="text-sm font-semibold text-slate-200">Querying OpenStreetMap…</p>
          <p className="text-[11px] text-slate-400 -mt-2">Can take 20–30s when the map servers are busy</p>
          <button onClick={reelRunning ? cancelReel : cancelScan} className="text-xs text-slate-400 hover:text-emerald-400 underline font-medium py-2 px-3">Cancel</button>
        </div>
      )}

      {/* Scrim: tap to collapse the expanded mobile sheet. Only at `full` — at `half` the map is
          deliberately still live so the rider can pan//drag the scan pin against visible results. */}
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
            // `/95`, not `/97`: Tailwind's opacity scale steps by 5, so `bg-slate-900/97` generated
            // NO rule at all and the sheet rendered with a transparent background — legible over the
            // old dark satellite basemap, not over the light topo one.
            ? `sheet${sheet.dragging ? ' dragging' : ''} absolute bottom-0 left-0 right-0 mx-auto max-w-2xl z-[1100] bg-slate-900/95 backdrop-blur-md rounded-t-3xl shadow-2xl border-t border-x border-slate-800 flex flex-col`
            : 'absolute left-4 top-[92px] z-[1100] w-[384px] max-h-[calc(100vh-112px)] bg-slate-900/95 backdrop-blur-md rounded-2xl shadow-2xl border border-slate-800 flex flex-col overflow-hidden'
        }
        style={sheet.isMobile ? { transform: `translateY(${sheet.translate}px)` } : undefined}
        role={sheet.isMobile ? 'dialog' : 'region'}
        aria-label="Ride list"
      >
        {sheet.isMobile && (
          <button
            type="button"
            aria-label={sheet.state === 'peek' ? 'Expand ride list' : 'Collapse ride list'}
            aria-expanded={sheet.state !== 'peek'}
            onPointerDown={sheet.onPointerDown}
            onPointerMove={sheet.onPointerMove}
            onPointerUp={sheet.onPointerUp}
            onPointerCancel={sheet.onPointerCancel}
            onClick={(e) => { if (e.detail === 0) sheet.toggle(); }}
            className="sheet-handle group w-full pt-3 pb-2 flex flex-col items-center gap-1 shrink-0 cursor-grab active:cursor-grabbing select-none"
          >
            <span className="w-10 h-1.5 bg-slate-600 group-hover:bg-slate-500 rounded-full transition-colors" />
            <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
              {sheet.state === 'peek' ? 'Tap or drag up' : 'Tap to close · drag to resize'}
            </span>
          </button>
        )}

        {/* Pinned action bar. It sits in the sheet's TOP region — above the scroll, directly under
            the handle — because the sheet's BOTTOM hangs off-screen at every snap point except
            `full`; a bar anchored there would be invisible exactly when it is needed most. Here it
            is on screen at peek, at half, at full, and at any scroll position. */}
        {mobileAction && (
          <div className="shrink-0 px-4 pb-3 border-b border-slate-800">{mobileAction}</div>
        )}

        {/* The sheet's ONE scroll region. Tab panels below must not introduce their own height caps
            or `overflow-hidden`: doing so clipped content instead of scrolling it, which is how the
            Scan tab's primary action ended up unreachable on a phone. */}
        <div
          className="sheet-body px-4 custom-scrollbar flex flex-col"
          style={{
            paddingTop: sheet.isMobile ? (mobileAction ? '0.75rem' : undefined) : '1.1rem',
            paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
          }}
        >
          {browsing && (
            <div className="flex flex-col gap-3">
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
              {/* No nested scroller: the sheet body is the one scroll region, so a flick anywhere in
                  the list scrolls it instead of hitting a trapped inner box. */}
              <div className="space-y-2">
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
            <div className="flex flex-col gap-3">
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Live ride builder</h2>
                <p className="text-[10px] text-slate-400">Combs the radius for twisties, scenery, greenery, water &amp; notable spots — then stitches rides</p>
              </div>

              {/* Setup ⇄ results. Only once there is something to switch to. */}
              {scanRides.length > 0 && (
                <div role="group" aria-label="Scan view" className="grid grid-cols-2 gap-0.5 bg-slate-950/60 p-1 rounded-xl border border-slate-800">
                  <button
                    onClick={() => setScanView('setup')}
                    aria-pressed={scanView === 'setup'}
                    className={`min-h-[40px] rounded-lg text-[11px] font-bold transition-all ${scanView === 'setup' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}
                  >
                    Setup
                  </button>
                  <button
                    onClick={() => setScanView('results')}
                    aria-pressed={scanView === 'results'}
                    className={`min-h-[40px] rounded-lg text-[11px] font-bold transition-all ${scanView === 'results' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}
                  >
                    Rides · {scanRides.length}
                  </button>
                </div>
              )}

              {showScanResults ? (
                <div className="space-y-2">
                  {scanRides.map((r) => (
                    <button key={r.id} onClick={(e) => selectScenic(r, e.currentTarget)} aria-current={scenicDetail?.id === r.id ? 'true' : undefined} style={{ borderColor: r.color, boxShadow: scenicDetail?.id === r.id ? `0 0 0 2px ${r.color}66` : undefined }} className={`w-full flex justify-between items-center gap-2 p-3 rounded-xl border-2 active:scale-[.99] transition-all text-left ${scenicDetail?.id === r.id ? 'bg-emerald-500/10' : 'bg-slate-900/40'}`}>
                      <div className="min-w-0 pr-1">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.color }} aria-hidden />
                          <h4 className="font-bold text-[13px] text-slate-100 truncate">{r.name}</h4>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate mt-0.5">{r.theme} · {formatDistance(r.distanceKm, units)} · 🌀{r.rubric.curvature.toFixed(1)}{r.rubric.gradeDrama != null ? ` ⛰️${r.rubric.gradeDrama.toFixed(1)}` : ''} 💧{r.rubric.water.toFixed(1)} 🌲{r.rubric.greenery.toFixed(1)} 📍{r.rubric.notability.toFixed(1)}</p>
                      </div>
                      <span className="font-mono text-[13px] font-black text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded-lg shrink-0">{r.score}</span>
                    </button>
                  ))}
                </div>
              ) : (
              <>
              <LocationSearch
                value={scanCenter}
                isDefault={isScanDefault}
                defaultLabel={defaultLocation.label}
                onSelect={recenterScan}
                onSetDefault={handleSetDefault}
                onUseDefault={handleUseDefault}
              />
              <div className="bg-slate-950/50 px-3 py-2.5 rounded-xl border border-slate-800 flex flex-col">
                <div className="flex items-baseline justify-between gap-2">
                  <label htmlFor="scan-radius" className="text-[11px] font-bold text-slate-300">Search radius</label>
                  <span className="font-mono text-emerald-400 font-bold text-sm">{Math.round(toUnits(scanRadius, units))} {distanceLabel(units)}</span>
                </div>
                <input id="scan-radius" className="w-full" type="range" min={Math.round(toUnits(5, units))} max={Math.round(toUnits(30, units))} value={Math.round(toUnits(scanRadius, units))} aria-label={`Search radius in ${units === 'mi' ? 'miles' : 'kilometers'}`} aria-valuetext={`${Math.round(toUnits(scanRadius, units))} ${units === 'mi' ? 'miles' : 'kilometers'}`} onChange={(e) => setScanRadius(fromUnits(+e.target.value, units))} />
                <p className="text-[10px] text-slate-500">Drag the green pin on the map to move the scan area.</p>
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
                  <span className="block text-[10px] text-slate-400 leading-snug">Round trips back near your start, else the best there-and-back.</span>
                </span>
                <span className={`shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors ${loopMode ? 'bg-emerald-500' : 'bg-slate-700'}`} aria-hidden>
                  <span className={`block w-5 h-5 rounded-full bg-white shadow transition-transform ${loopMode ? 'translate-x-4' : ''}`} />
                </span>
              </button>

              {/* Paved-only — drop rides that use a known gravel/dirt leg. Re-ranks instantly. */}
              <button
                type="button"
                onClick={() => setPavedOnly((m) => !m)}
                aria-pressed={pavedOnly}
                className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${pavedOnly ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-slate-950/50 border-slate-800 hover:border-emerald-500/30'}`}
              >
                <span className="text-lg shrink-0" aria-hidden>🛣️</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-bold text-slate-100">Paved roads only</span>
                  <span className="block text-[10px] text-slate-400 leading-snug">Hide rides using a road tagged gravel or dirt.</span>
                </span>
                <span className={`shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors ${pavedOnly ? 'bg-emerald-500' : 'bg-slate-700'}`} aria-hidden>
                  <span className={`block w-5 h-5 rounded-full bg-white shadow transition-transform ${pavedOnly ? 'translate-x-4' : ''}`} />
                </span>
              </button>

              {/* Bias: one-tap presets + an expandable manual mixer. Changing either re-ranks the
                  already-scanned corpus instantly — no re-query. */}
              <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-slate-300">What matters to you</span>
                  <button onClick={() => setShowWeights((s) => !s)} className="text-[11px] font-bold text-emerald-400 hover:underline min-h-[40px] px-2 -mr-2">
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
                      className={`px-3 min-h-[40px] rounded-lg text-[11px] font-bold border transition-all ${presetId === p.id ? 'bg-emerald-500 text-slate-950 border-emerald-400' : 'bg-slate-900/60 text-slate-300 border-slate-700 hover:border-emerald-500/40'}`}
                    >
                      {p.label}
                    </button>
                  ))}
                  {presetId === 'custom' && (
                    <span className="px-3 grid place-items-center min-h-[40px] rounded-lg text-[11px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Custom</span>
                  )}
                </div>
                {showWeights && (
                  <div className="flex flex-col gap-1.5 pt-1">
                    {BIAS_ROWS.map(({ key, label, icon }) => {
                      const pct = Math.round((normalizeWeights(bias)[key] ?? 0) * 100);
                      return (
                        <div key={key} className="flex items-center gap-2">
                          <span className="w-20 shrink-0 text-[11px] font-semibold text-slate-300">{icon} {label}</span>
                          <input
                            type="range" min={0} max={1} step={0.05} value={bias[key] ?? 0}
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

              {/* On mobile this lives in the sheet's pinned footer instead — see `mobileAction`. */}
              {!sheet.isMobile && scanAction}

              <p className="text-[11px] text-slate-400 italic text-center py-1">
                {hasScanned
                  ? 'No rides matched here — widen the radius, lighten the bias, or try a twistier area.'
                  : 'Catalogs real roads, water, woods, viewpoints and landmarks in your radius, then stitches rides ranked by your bias. Tap a ride — or its line on the map — for the full review.'}
              </p>
              </>
              )}
            </div>
          )}

          {tab === 'reel' && (
            <ReelPanel
              center={scanCenter}
              isDefaultCenter={isScanDefault}
              defaultLabel={defaultLocation.label}
              onRecenter={recenterScan}
              onSetDefault={handleSetDefault}
              onUseDefault={handleUseDefault}
              radiusKm={scanRadius}
              onRadiusChange={setScanRadius}
              units={units}
              date={reelDate}
              time={reelTime}
              onDateChange={setReelDate}
              onTimeChange={setReelTime}
              shoot={reelShoot}
              onUsePeakLight={useReelPeakLight}
              aim={reelAim}
              onAimChange={setReelAim}
              weights={reelWeights}
              onWeightChange={setReelWeight}
              onResetWeights={() => setReelWeights(REEL_WEIGHTS)}
              marks={reelMarks}
              at={reelAt}
              selected={reelSelected}
              onSelect={selectReelMark}
              onLocate={locateReelMark}
              refining={reelRefining}
              hasRun={reelHasRun}
              view={reelView}
              onViewChange={setReelView}
              ride={{
                ride: reelRide,
                building: reelRideBuilding,
                markCount: reelMarks.length,
                units,
                targetKm: reelRideKm,
                onTargetKmChange: setReelRideKm,
                loop: reelRideLoop,
                onLoopChange: setReelRideLoop,
                onBuild: buildReelRide,
                onSelectShot: selectReelMark,
                mapsHref: reelRideHref,
              }}
              action={reelAction}
              showAction={!sheet.isMobile}
            />
          )}

          {tab === 'community' && (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Community rides</h2>
                  <p className="text-[10px] text-slate-400">Rides published by other riders — open one, or publish your own from any ride’s page</p>
                </div>
                <div className="flex items-center gap-0.5 bg-slate-950/60 p-0.5 rounded-lg border border-slate-800 shrink-0" role="group" aria-label="Sort community rides">
                  <button onClick={() => setCommunitySort('new')} aria-pressed={communitySort === 'new'} className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all ${communitySort === 'new' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}>New</button>
                  <button onClick={() => setCommunitySort('top')} aria-pressed={communitySort === 'top'} className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all ${communitySort === 'top' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}>Top</button>
                </div>
              </div>
              {!signedIn && (
                <p className="text-[10px] text-slate-400 bg-slate-950/50 border border-slate-800 rounded-lg p-2.5">Browsing is open to everyone. Sign in from <span className="font-semibold text-slate-300">Settings ⚙️</span> to publish your own rides and like others’.</p>
              )}
              <div className="space-y-2">
                {communityLoading ? (
                  <p className="text-[11px] text-slate-400 italic text-center py-6">Loading community rides…</p>
                ) : communityRides.length === 0 ? (
                  <p className="text-[11px] text-slate-400 italic text-center py-6">No community rides yet — be the first: open any ride and tap “Publish to Community”.</p>
                ) : (
                  communityRides.map((pr) => (
                    <button
                      key={pr.id}
                      onClick={(e) => openPublicRide(pr, e.currentTarget)}
                      aria-current={scenicDetail?.id === pr.route.id ? 'true' : undefined}
                      style={{ borderColor: pr.route.color, boxShadow: scenicDetail?.id === pr.route.id ? `0 0 0 2px ${pr.route.color}66` : undefined }}
                      className={`w-full flex justify-between items-center gap-2 p-3 rounded-xl border-2 active:scale-[.99] transition-all text-left ${scenicDetail?.id === pr.route.id ? 'bg-emerald-500/10' : 'bg-slate-900/40'}`}
                    >
                      <div className="min-w-0 pr-1">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: pr.route.color }} aria-hidden />
                          <h4 className="font-bold text-[13px] text-slate-100 truncate">{pr.route.name}</h4>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate mt-0.5">{pr.route.theme} · {formatDistance(pr.route.distanceKm, units)} · by {pr.authorName}{pr.mine ? ' (you)' : ''}</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">👍 {pr.likeCount} · 💾 {pr.saveCount}</p>
                      </div>
                      <span className="font-mono text-[13px] font-black text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded-lg shrink-0">{pr.route.score}</span>
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
          history={scanHistory}
          onOpenScan={openScanRecord}
          onRemoveScan={removeScanRecord_}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      </div>

      {/* Full-page review overlay — shared by scenic, curated, scan-built AND community rides */}
      {reviewOpen && scenicDetail && (() => {
        // Is the open ride already a public ride? (the gallery row we opened, or one the rider published)
        const isActive = activePublic && activePublic.route.id === scenicDetail.id;
        const publishedId = isActive ? activePublic!.id : (myPublished.get(scenicDetail.id) ?? null);
        const likeCount = isActive ? activePublic!.likeCount : null;
        return (
          <ScenicRouteReview
            route={scenicDetail}
            onBack={closeReview}
            onLocate={locateStop}
            origin={tab === 'scanner' || tab === 'reel' ? scanCenterLatLng : homeCenter}
            units={units}
            isSaved={savedIds.has(scenicDetail.id)}
            onToggleSave={() => toggleSaveRoute(scenicDetail)}
            community={AUTH_ENABLED ? {
              signedIn,
              publishedId,
              likeCount,
              liked: publishedId ? myLikes.has(publishedId) : false,
              onPublishToggle: () => { void handlePublishToggle(scenicDetail, publishedId); },
              onLikeToggle: () => { if (publishedId) handleLikeToggle(publishedId); },
            } : undefined}
          />
        );
      })()}
    </div>
  );
}
