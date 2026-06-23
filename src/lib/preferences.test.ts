import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  updatePreferences,
} from './preferences';

// In-memory localStorage stand-in (vitest runs in node — no DOM).
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

beforeEach(() => vi.stubGlobal('localStorage', fakeStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('preferences', () => {
  it('returns the factory defaults when nothing is saved', () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('round-trips a full preferences object', () => {
    const prefs = { units: 'km', defaultBiasPreset: 'twisty', theme: 'light' } as const;
    expect(savePreferences(prefs)).toBe(true);
    expect(loadPreferences()).toEqual(prefs);
  });

  it('updatePreferences merges a partial onto the saved prefs', () => {
    savePreferences({ units: 'km', defaultBiasPreset: 'scenic', theme: 'dark' });
    const merged = updatePreferences({ theme: 'light' });
    expect(merged).toEqual({ units: 'km', defaultBiasPreset: 'scenic', theme: 'light' });
    expect(loadPreferences().theme).toBe('light');
  });

  it('coerces unknown/invalid fields back to defaults', () => {
    localStorage.setItem(
      'sinuosity.preferences.v1',
      JSON.stringify({ units: 'furlongs', defaultBiasPreset: 42, theme: 'neon' }),
    );
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('falls back to defaults on corrupt JSON', () => {
    localStorage.setItem('sinuosity.preferences.v1', '{not json');
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('degrades to defaults when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    expect(savePreferences(DEFAULT_PREFERENCES)).toBe(false);
  });
});
