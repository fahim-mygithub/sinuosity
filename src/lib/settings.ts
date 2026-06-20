import type { LatLng } from './geometry';

/**
 * A user's saved default ride location — the starting point the Scan tab opens to and the
 * origin navigation links route from. Persisted in localStorage so it survives reloads;
 * everything degrades to {@link FACTORY_DEFAULT} when storage is unavailable or corrupt.
 */
export interface SavedLocation {
  label: string;
  lat: number;
  lon: number;
}

/**
 * Factory default: the app's original home base (36 Char Del Way, WNY). Kept in sync with
 * the HOME constant in mapsUrl.ts. Used until the rider sets their own default.
 */
export const FACTORY_DEFAULT: SavedLocation = {
  label: '36 Char Del Way',
  lat: 42.9808,
  lon: -78.7441,
};

const STORAGE_KEY = 'sinuosity.defaultLocation.v1';

/** localStorage if it's usable (absent under SSR/node tests, throws in some privacy modes). */
function store(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    // Touch it — Safari private mode exposes the API but throws on write.
    const probe = '__sinuosity_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

function isValid(l: unknown): l is SavedLocation {
  return (
    !!l &&
    typeof l === 'object' &&
    typeof (l as SavedLocation).label === 'string' &&
    Number.isFinite((l as SavedLocation).lat) &&
    Number.isFinite((l as SavedLocation).lon)
  );
}

/** The rider's saved default location, or {@link FACTORY_DEFAULT} if none/invalid. */
export function loadDefaultLocation(): SavedLocation {
  const s = store();
  if (!s) return FACTORY_DEFAULT;
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return FACTORY_DEFAULT;
    const parsed = JSON.parse(raw);
    return isValid(parsed)
      ? { label: parsed.label, lat: parsed.lat, lon: parsed.lon }
      : FACTORY_DEFAULT;
  } catch {
    return FACTORY_DEFAULT;
  }
}

/** Persist the rider's default location. Returns true if it was actually saved. */
export function saveDefaultLocation(loc: SavedLocation): boolean {
  const s = store();
  if (!s || !isValid(loc)) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify({ label: loc.label, lat: loc.lat, lon: loc.lon }));
    return true;
  } catch {
    return false;
  }
}

/** Forget the saved default (revert to the factory home). */
export function clearDefaultLocation(): void {
  store()?.removeItem(STORAGE_KEY);
}

/** True when `loc` matches the persisted default (same coordinate to ~10m). */
export function isDefaultLocation(loc: SavedLocation): boolean {
  const d = loadDefaultLocation();
  return Math.abs(d.lat - loc.lat) < 1e-4 && Math.abs(d.lon - loc.lon) < 1e-4;
}

export const toLatLng = (l: SavedLocation): LatLng => [l.lat, l.lon];
