import { useEffect, useRef, useState } from 'react';
import { geocode, reverseGeocode, GeocodeError, type GeoResult } from '../lib/geocode';
import { BIAS_PRESETS } from '../lib/composite';
import { AUTH_ENABLED, getAccount, signInWithGoogle } from '../lib/account';
import { formatDistance } from '../lib/units';
import type { Preferences, Units, Theme } from '../lib/preferences';
import type { SavedLocation } from '../lib/settings';
import type { SavedRoute } from '../lib/savedRoutes';
import type { ScenicRoute } from '../data/types';

/**
 * Settings overlay: rider account (sign-in placeholder until a backend is wired), home location,
 * distance units, the Scan bias preset the app opens on, the UI theme, and the rider's saved
 * rides. All changes are local (localStorage) and take effect immediately. Opens from the gear in
 * the header; Esc or the backdrop closes it.
 */
export function SettingsMenu({
  prefs,
  onChangePrefs,
  home,
  onChangeHome,
  saved,
  onOpenSaved,
  onRemoveSaved,
  onClose,
}: {
  prefs: Preferences;
  onChangePrefs: (patch: Partial<Preferences>) => void;
  home: SavedLocation;
  onChangeHome: (loc: SavedLocation) => void;
  saved: SavedRoute[];
  onOpenSaved: (route: ScenicRoute) => void;
  onRemoveSaved: (id: string) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-[1500] flex items-end sm:items-center justify-center animate-fadeIn"
    >
      {/* Backdrop */}
      <button aria-label="Close settings" onClick={onClose} className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm cursor-default" />

      <div className="relative w-full sm:max-w-lg max-h-[90vh] sm:max-h-[85vh] bg-slate-900 sm:rounded-2xl rounded-t-3xl border border-slate-800 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 shrink-0">
          <h2 className="text-sm font-black tracking-tight text-white flex items-center gap-2">
            <span aria-hidden>⚙️</span> Settings
          </h2>
          <button
            ref={closeRef}
            onClick={onClose}
            className="h-9 w-9 grid place-items-center rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors text-lg"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto custom-scrollbar px-5 py-4 flex flex-col gap-6">
          <AccountSection />
          <HomeSection home={home} onChangeHome={onChangeHome} />
          <UnitsSection value={prefs.units} onChange={(units) => onChangePrefs({ units })} />
          <BiasSection value={prefs.defaultBiasPreset} onChange={(defaultBiasPreset) => onChangePrefs({ defaultBiasPreset })} />
          <ThemeSection value={prefs.theme} onChange={(theme) => onChangePrefs({ theme })} />
          <SavedSection saved={saved} units={prefs.units} onOpen={onOpenSaved} onRemove={onRemoveSaved} />
        </div>
      </div>
    </div>
  );
}

/** Section shell: small uppercase heading + content. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">{title}</h3>
      {children}
    </section>
  );
}

/** Account: signed-out placeholder + disabled Google button until a backend is wired (account.ts). */
function AccountSection() {
  const account = getAccount();
  const [reason, setReason] = useState('');

  return (
    <Section title="Account">
      {account ? (
        <div className="flex items-center gap-3 p-3 rounded-xl border border-slate-800 bg-slate-950/40">
          <div className="h-9 w-9 rounded-full bg-emerald-500 text-slate-950 grid place-items-center font-black">
            {account.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-bold text-slate-100 truncate">{account.name}</p>
            <p className="text-[11px] text-slate-400 truncate">{account.email}</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 p-3 rounded-xl border border-slate-800 bg-slate-950/40">
          <p className="text-[12px] text-slate-300">
            You’re riding locally — saved routes &amp; settings live on this device.
          </p>
          <button
            type="button"
            disabled={!AUTH_ENABLED}
            onClick={() => { const r = signInWithGoogle(); if (!r.ok) setReason(r.reason); }}
            className="h-11 inline-flex items-center justify-center gap-2.5 rounded-xl bg-white text-slate-800 font-semibold text-[13px] disabled:opacity-55 disabled:cursor-not-allowed transition-all"
          >
            <GoogleGlyph /> Continue with Google
          </button>
          <p className="text-[10px] text-slate-500 leading-snug">
            {reason || 'Cloud accounts &amp; cross-device sync are coming soon.'}
          </p>
        </div>
      )}
    </Section>
  );
}

/** Home location: search any place (Nominatim) or use device location; sets the saved default. */
function HomeSection({ home, onChangeHome }: { home: SavedLocation; onChangeHome: (loc: SavedLocation) => void }) {
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
    setBusy('search'); setError(''); setResults([]);
    try {
      const hits = await geocode(q, controller.signal);
      setResults(hits);
      if (!hits.length) setError(`No matches for “${q}”. Try a town, ZIP, or landmark.`);
    } catch (err) {
      setError(err instanceof GeocodeError && err.kind === 'timeout' ? 'Search timed out — try again.' : 'Search failed — check your connection.');
    } finally {
      clearTimeout(timeout); ctrl.current = null; setBusy(false);
    }
  };

  const pick = (r: GeoResult) => {
    onChangeHome({ label: r.label, lat: r.lat, lon: r.lon });
    setResults([]); setQuery(''); setError('');
  };

  const useMyLocation = () => {
    if (!locatable || busy) return;
    setBusy('locate'); setError(''); setResults([]);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        let label = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        try { const place = await reverseGeocode(lat, lon); if (place) label = place.label; } catch { /* keep coord */ }
        onChangeHome({ label, lat, lon });
        setBusy(false);
      },
      (geoErr) => {
        setError(geoErr.code === geoErr.PERMISSION_DENIED ? 'Location permission denied — search instead.' : 'Could not get your location — search instead.');
        setBusy(false);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };

  return (
    <Section title="Home location">
      <div className="flex items-center gap-2 p-2.5 rounded-xl border border-slate-800 bg-slate-950/40">
        <span className="text-sm shrink-0" aria-hidden>🏠</span>
        <div className="min-w-0 flex-1">
          <p className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold leading-none">Current home</p>
          <p className="text-[12px] font-bold text-slate-100 truncate" title={home.label}>{home.label}</p>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-500">The Scan tab opens here &amp; navigation routes from it.</span>
        {locatable && (
          <button type="button" onClick={useMyLocation} disabled={!!busy} className="text-[10px] font-bold text-emerald-400 hover:text-emerald-300 disabled:opacity-50 inline-flex items-center gap-1 py-1 shrink-0">
            <span aria-hidden>{busy === 'locate' ? '⏳' : '🎯'}</span> Use my location
          </button>
        )}
      </div>
      <form onSubmit={runSearch} className="flex gap-2">
        <input
          type="text" inputMode="search" autoComplete="off" placeholder="Set home — address, town, ZIP…"
          value={query} onChange={(e) => setQuery(e.target.value)}
          className="flex-1 min-w-0 bg-slate-900 border border-slate-700 focus:border-emerald-500/60 focus:outline-none rounded-lg px-3 py-2 text-[13px] text-slate-100 placeholder:text-slate-500"
        />
        <button type="submit" disabled={!!busy || !query.trim()} className="shrink-0 bg-emerald-500 active:bg-emerald-600 active:scale-[.98] disabled:opacity-40 text-slate-950 font-bold px-3.5 rounded-lg text-[13px] transition-all">
          {busy === 'search' ? '…' : 'Search'}
        </button>
      </form>
      {results.length > 0 && (
        <ul role="listbox" aria-label="Search results" className="flex flex-col gap-1">
          {results.map((r, i) => (
            <li key={`${r.lat},${r.lon}-${i}`}>
              <button type="button" onClick={() => pick(r)} title={r.fullLabel} className="w-full text-left px-3 py-2 rounded-lg border border-slate-800 bg-slate-900/60 hover:border-emerald-500/40 hover:bg-emerald-500/5 active:scale-[.99] transition-all">
                <span className="block text-[12px] font-semibold text-slate-100 truncate">{r.label}</span>
                <span className="block text-[10px] text-slate-500 truncate">{r.fullLabel}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="text-[10px] text-amber-400/90 leading-snug">{error}</p>}
    </Section>
  );
}

/** A two-button segmented toggle. */
function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex bg-slate-950/60 p-1 rounded-xl border border-slate-800 self-start">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`px-4 py-1.5 rounded-lg text-[12px] font-bold transition-all ${value === o.id ? 'bg-emerald-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function UnitsSection({ value, onChange }: { value: Units; onChange: (v: Units) => void }) {
  return (
    <Section title="Distance units">
      <Segmented<Units>
        label="Distance units" value={value} onChange={onChange}
        options={[{ id: 'mi', label: 'Miles' }, { id: 'km', label: 'Kilometers' }]}
      />
    </Section>
  );
}

function ThemeSection({ value, onChange }: { value: Theme; onChange: (v: Theme) => void }) {
  return (
    <Section title="Theme">
      <Segmented<Theme>
        label="Theme" value={value} onChange={onChange}
        options={[{ id: 'dark', label: '🌙 Dark' }, { id: 'light', label: '☀️ Light' }]}
      />
    </Section>
  );
}

/** Default Scan bias preset the app opens on. */
function BiasSection({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <Section title="Default ride bias">
      <p className="text-[10px] text-slate-500 -mt-1">Which weighting the Scan tab starts with.</p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Default bias preset">
        {BIAS_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            aria-pressed={value === p.id}
            title={p.hint}
            className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-all ${value === p.id ? 'bg-emerald-500 text-slate-950 border-emerald-400' : 'bg-slate-900/60 text-slate-300 border-slate-700 hover:border-emerald-500/40'}`}
          >
            {p.label}
          </button>
        ))}
      </div>
    </Section>
  );
}

/** The rider's saved rides — open or remove each. */
function SavedSection({ saved, units, onOpen, onRemove }: {
  saved: SavedRoute[]; units: Units; onOpen: (route: ScenicRoute) => void; onRemove: (id: string) => void;
}) {
  return (
    <Section title={`Saved routes${saved.length ? ` · ${saved.length}` : ''}`}>
      {saved.length === 0 ? (
        <p className="text-[11px] text-slate-400 italic leading-snug">
          No saved rides yet. Open any ride and tap the ♡ in its header to keep it here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {saved.map((s) => (
            <li
              key={s.route.id}
              className="flex items-center gap-2 p-2.5 rounded-xl border-2 bg-slate-900/40"
              style={{ borderColor: s.route.color }}
            >
              <button onClick={() => onOpen(s.route)} className="min-w-0 flex-1 text-left">
                <p className="text-[13px] font-bold text-slate-100 truncate">{s.route.name}</p>
                <p className="text-[10px] text-slate-400 truncate mt-0.5">
                  {s.route.theme} · {formatDistance(s.route.distanceKm, units)} · score {s.route.score}
                </p>
              </button>
              <button
                onClick={() => onRemove(s.route.id)}
                aria-label={`Remove ${s.route.name} from saved`}
                className="shrink-0 h-8 w-8 grid place-items-center rounded-lg text-slate-400 hover:text-rose-400 hover:bg-white/5 transition-colors"
              >
                🗑
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Google "G" mark (official four-color), small. */
function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8a12 12 0 1 1 7.9-21l5.7-5.7A20 20 0 1 0 24 44c11 0 20-9 20-20 0-1.3-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8A12 12 0 0 1 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7A20 20 0 0 0 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A12 12 0 0 1 12.7 28l-6.6 5.1A20 20 0 0 0 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C39.9 35.6 44 30.3 44 24c0-1.3-.1-2.3-.4-3.5z" />
    </svg>
  );
}
