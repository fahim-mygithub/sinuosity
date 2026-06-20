import { useRef, useState } from 'react';
import { geocode, reverseGeocode, GeocodeError, type GeoResult } from '../lib/geocode';
import type { SavedLocation } from '../lib/settings';

/**
 * First-class "scan around here" location control for the Scan tab. The rider can type any
 * address/place (keyless Nominatim geocoding), drop onto their device location, see where the
 * scan is currently centered, and pin the current spot as their saved default — so the app is
 * no longer hard-wired to one home coordinate.
 */
export function LocationSearch({
  value,
  isDefault,
  defaultLabel,
  onSelect,
  onSetDefault,
  onUseDefault,
}: {
  value: SavedLocation;
  isDefault: boolean;
  defaultLabel: string;
  onSelect: (loc: SavedLocation) => void;
  onSetDefault: () => void;
  onUseDefault: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [busy, setBusy] = useState<false | 'search' | 'locate'>(false);
  const [error, setError] = useState('');
  const [locatable] = useState(() => typeof navigator !== 'undefined' && !!navigator.geolocation);
  const ctrl = useRef<AbortController | null>(null);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    ctrl.current?.abort();
    const controller = new AbortController();
    ctrl.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    setBusy('search');
    setError('');
    setResults([]);
    try {
      const hits = await geocode(q, controller.signal);
      setResults(hits);
      if (!hits.length) setError(`No matches for “${q}”. Try a town, ZIP, or landmark.`);
    } catch (err) {
      setError(
        err instanceof GeocodeError && err.kind === 'timeout'
          ? 'Search timed out — try again.'
          : 'Search failed — check your connection.',
      );
    } finally {
      clearTimeout(timeout);
      ctrl.current = null;
      setBusy(false);
    }
  };

  const pick = (r: GeoResult) => {
    onSelect({ label: r.label, lat: r.lat, lon: r.lon });
    setResults([]);
    setQuery('');
    setError('');
  };

  const useMyLocation = () => {
    if (!locatable || busy) return;
    setBusy('locate');
    setError('');
    setResults([]);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        let label = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        try {
          const place = await reverseGeocode(lat, lon);
          if (place) label = place.label;
        } catch {
          /* keep the coordinate label */
        }
        onSelect({ label, lat, lon });
        setBusy(false);
      },
      (geoErr) => {
        setError(
          geoErr.code === geoErr.PERMISSION_DENIED
            ? 'Location permission denied — search for a place instead.'
            : 'Could not get your location — search for a place instead.',
        );
        setBusy(false);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };

  return (
    <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800 flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <label htmlFor="loc-search" className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
          Scan around
        </label>
        {locatable && (
          <button
            type="button"
            onClick={useMyLocation}
            disabled={!!busy}
            className="text-[10px] font-bold text-emerald-400 hover:text-emerald-300 disabled:opacity-50 inline-flex items-center gap-1 py-1"
          >
            <span aria-hidden>{busy === 'locate' ? '⏳' : '🎯'}</span> Use my location
          </button>
        )}
      </div>

      <form onSubmit={runSearch} className="flex gap-2">
        <input
          id="loc-search"
          type="text"
          inputMode="search"
          autoComplete="off"
          placeholder="Address, town, ZIP, or landmark…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 min-w-0 bg-slate-900 border border-slate-700 focus:border-emerald-500/60 focus:outline-none rounded-lg px-3 py-2 text-[13px] text-slate-100 placeholder:text-slate-500"
        />
        <button
          type="submit"
          disabled={!!busy || !query.trim()}
          className="shrink-0 bg-emerald-500 active:bg-emerald-600 active:scale-[.98] disabled:opacity-40 disabled:active:scale-100 text-slate-950 font-bold px-3.5 rounded-lg text-[13px] transition-all"
        >
          {busy === 'search' ? '…' : 'Search'}
        </button>
      </form>

      {results.length > 0 && (
        <ul role="listbox" aria-label="Search results" className="flex flex-col gap-1 -mt-0.5">
          {results.map((r, i) => (
            <li key={`${r.lat},${r.lon}-${i}`}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => pick(r)}
                title={r.fullLabel}
                className="w-full text-left px-3 py-2 rounded-lg border border-slate-800 bg-slate-900/60 hover:border-emerald-500/40 hover:bg-emerald-500/5 active:scale-[.99] transition-all"
              >
                <span className="block text-[12px] font-semibold text-slate-100 truncate">{r.label}</span>
                <span className="block text-[10px] text-slate-500 truncate">{r.fullLabel}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="text-[10px] text-amber-400/90 leading-snug">
          {error}
        </p>
      )}

      {/* Current center + default management */}
      <div className="flex items-center gap-2 border-t border-slate-800/70 pt-2">
        <span className="text-sm shrink-0" aria-hidden>📍</span>
        <div className="min-w-0 flex-1">
          <p className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold leading-none">Centered on</p>
          <p className="text-[12px] font-bold text-slate-100 truncate" title={value.label}>{value.label}</p>
        </div>
        {isDefault ? (
          <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2 py-1 rounded-lg">
            <span aria-hidden>★</span> Default
          </span>
        ) : (
          <button
            type="button"
            onClick={onSetDefault}
            className="shrink-0 text-[10px] font-bold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1 rounded-lg transition-colors"
          >
            ★ Set default
          </button>
        )}
      </div>

      {!isDefault && (
        <button
          type="button"
          onClick={onUseDefault}
          className="text-[10px] text-slate-400 hover:text-emerald-400 underline self-start -mt-1"
        >
          ↺ Back to {defaultLabel}
        </button>
      )}
    </div>
  );
}
