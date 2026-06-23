import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadSavedRoutes,
  writeSavedRoutes,
  isRouteSaved,
  toggleSavedRoute,
  removeSavedRoute,
  type SavedRoute,
} from './savedRoutes';
import type { ScenicRoute } from '../data/types';

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

const route = (id: string): ScenicRoute => ({
  id,
  name: `Ride ${id}`,
  theme: 'Backroad',
  region: 'WNY',
  distanceKm: 30,
  drivingTime: '40 min',
  summary: '',
  whyRide: '',
  rubric: { curvature: 5, scenery: 5, greenery: 5, water: 5, notability: 5 },
  score: 60,
  color: '#10b981',
  coords: [[42.7, -78.8], [42.71, -78.79]],
  stops: [],
});

describe('savedRoutes', () => {
  it('starts empty', () => {
    expect(loadSavedRoutes()).toEqual([]);
  });

  it('round-trips a saved list', () => {
    const list: SavedRoute[] = [{ route: route('a'), savedAt: 1000 }];
    expect(writeSavedRoutes(list)).toBe(true);
    expect(loadSavedRoutes()).toEqual(list);
  });

  it('toggle adds newest-first then removes', () => {
    let list: SavedRoute[] = [];
    list = toggleSavedRoute(list, route('a'), 1000);
    list = toggleSavedRoute(list, route('b'), 2000);
    expect(list.map((s) => s.route.id)).toEqual(['b', 'a']); // newest first
    expect(isRouteSaved(list, 'a')).toBe(true);

    list = toggleSavedRoute(list, route('a'), 3000); // toggle a off
    expect(list.map((s) => s.route.id)).toEqual(['b']);
    expect(isRouteSaved(list, 'a')).toBe(false);
  });

  it('removeSavedRoute drops by id without mutating the input', () => {
    const list: SavedRoute[] = [
      { route: route('a'), savedAt: 1 },
      { route: route('b'), savedAt: 2 },
    ];
    const next = removeSavedRoute(list, 'a');
    expect(next.map((s) => s.route.id)).toEqual(['b']);
    expect(list.length).toBe(2); // original untouched
  });

  it('drops corrupt/partial entries on load', () => {
    localStorage.setItem(
      'sinuosity.savedRoutes.v1',
      JSON.stringify([{ route: { id: 'ok', name: 'x', coords: [] }, savedAt: 5 }, { nope: true }, 42]),
    );
    const loaded = loadSavedRoutes();
    expect(loaded.length).toBe(1);
    expect(loaded[0].route.id).toBe('ok');
  });

  it('returns [] on corrupt JSON or unavailable storage', () => {
    localStorage.setItem('sinuosity.savedRoutes.v1', '{not json');
    expect(loadSavedRoutes()).toEqual([]);
    vi.stubGlobal('localStorage', undefined);
    expect(loadSavedRoutes()).toEqual([]);
    expect(writeSavedRoutes([])).toBe(false);
  });
});
