/**
 * App-wide rider preferences — distance units, the Scan bias preset the app opens with, and the
 * UI theme. Persisted in localStorage (one key) so they survive reloads, and degrade silently to
 * {@link DEFAULT_PREFERENCES} whenever storage is unavailable or corrupt (same defensive pattern
 * as settings.ts). The saved DEFAULT LOCATION lives in settings.ts; this module owns everything else.
 */

export type Units = 'mi' | 'km';
export type Theme = 'dark' | 'light';

export interface Preferences {
  /** Distance display unit. WNY default is miles. */
  units: Units;
  /** Which Scan bias preset id the app starts on (matches a BIAS_PRESETS id, or 'custom'). */
  defaultBiasPreset: string;
  /** UI chrome theme. */
  theme: Theme;
}

export const DEFAULT_PREFERENCES: Preferences = {
  units: 'mi',
  defaultBiasPreset: 'balanced',
  theme: 'dark',
};

const STORAGE_KEY = 'sinuosity.preferences.v1';

/** localStorage if it's usable (absent under node tests, throws in some privacy modes). */
function store(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__sinuosity_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/** Coerce arbitrary parsed JSON into a valid Preferences, filling any missing/invalid field. */
function coerce(raw: unknown): Preferences {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Preferences>;
  return {
    units: r.units === 'km' || r.units === 'mi' ? r.units : DEFAULT_PREFERENCES.units,
    defaultBiasPreset:
      typeof r.defaultBiasPreset === 'string' && r.defaultBiasPreset
        ? r.defaultBiasPreset
        : DEFAULT_PREFERENCES.defaultBiasPreset,
    theme: r.theme === 'light' || r.theme === 'dark' ? r.theme : DEFAULT_PREFERENCES.theme,
  };
}

/** The rider's saved preferences, or {@link DEFAULT_PREFERENCES} if none/invalid. */
export function loadPreferences(): Preferences {
  const s = store();
  if (!s) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    return coerce(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Persist a full preferences object. Returns true if it was actually saved. */
export function savePreferences(prefs: Preferences): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(coerce(prefs)));
    return true;
  } catch {
    return false;
  }
}

/** Merge a partial update onto the saved prefs and persist; returns the merged result. */
export function updatePreferences(patch: Partial<Preferences>): Preferences {
  const merged = coerce({ ...loadPreferences(), ...patch });
  savePreferences(merged);
  return merged;
}

/**
 * Apply the theme to the document root so the light-mode CSS overrides (index.css) take effect.
 * No-op outside the browser. Dark is the default look and needs no overrides.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
}
