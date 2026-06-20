import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  FACTORY_DEFAULT,
  loadDefaultLocation,
  saveDefaultLocation,
  clearDefaultLocation,
  isDefaultLocation,
  toLatLng,
} from './settings';

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

const SAMPLE = { label: 'Ellicottville', lat: 42.277, lon: -78.673 };

describe('default location settings', () => {
  it('returns the factory default when nothing is saved', () => {
    expect(loadDefaultLocation()).toEqual(FACTORY_DEFAULT);
  });

  it('round-trips a saved location', () => {
    expect(saveDefaultLocation(SAMPLE)).toBe(true);
    expect(loadDefaultLocation()).toEqual(SAMPLE);
  });

  it('clear() reverts to the factory default', () => {
    saveDefaultLocation(SAMPLE);
    clearDefaultLocation();
    expect(loadDefaultLocation()).toEqual(FACTORY_DEFAULT);
  });

  it('rejects an invalid location', () => {
    expect(saveDefaultLocation({ label: 'bad', lat: NaN, lon: 0 })).toBe(false);
    expect(loadDefaultLocation()).toEqual(FACTORY_DEFAULT);
  });

  it('falls back to the factory default on corrupt JSON', () => {
    localStorage.setItem('sinuosity.defaultLocation.v1', '{not json');
    expect(loadDefaultLocation()).toEqual(FACTORY_DEFAULT);
  });

  it('isDefaultLocation matches the saved coordinate', () => {
    saveDefaultLocation(SAMPLE);
    expect(isDefaultLocation(SAMPLE)).toBe(true);
    expect(isDefaultLocation({ ...SAMPLE, lat: SAMPLE.lat + 1 })).toBe(false);
  });

  it('degrades to the factory default when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadDefaultLocation()).toEqual(FACTORY_DEFAULT);
    expect(saveDefaultLocation(SAMPLE)).toBe(false);
  });

  it('toLatLng yields the [lat, lon] tuple', () => {
    expect(toLatLng(SAMPLE)).toEqual([42.277, -78.673]);
  });
});
