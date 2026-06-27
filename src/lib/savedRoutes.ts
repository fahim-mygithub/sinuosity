import type { ScenicRoute } from '../data/types';

/**
 * A rider-saved ride. The full {@link ScenicRoute} is stored (all fields are JSON-serializable),
 * so a saved route re-opens through the very same review path scenic/curated/scan rides use — no
 * re-fetch, no re-derivation. Persisted in localStorage; cloud sync (Google account) is a future
 * swap behind account.ts. Newest-first ordering is maintained on save.
 */
export interface SavedRoute {
  route: ScenicRoute;
  /** Epoch millis the rider saved it. */
  savedAt: number;
}

const STORAGE_KEY = 'sinuosity.savedRoutes.v1';
const MAX_SAVED = 200; // generous cap so localStorage can't grow unbounded

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

/** Minimal structural check — enough to skip a corrupt/partial entry without throwing. */
function isSavedRoute(x: unknown): x is SavedRoute {
  if (!x || typeof x !== 'object') return false;
  const s = x as SavedRoute;
  return (
    !!s.route &&
    typeof s.route === 'object' &&
    typeof s.route.id === 'string' &&
    typeof s.route.name === 'string' &&
    Array.isArray(s.route.coords) &&
    Number.isFinite(s.savedAt)
  );
}

/** All saved routes, newest first. Invalid entries are dropped; returns [] on any failure. */
export function loadSavedRoutes(): SavedRoute[] {
  const s = store();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedRoute);
  } catch {
    return [];
  }
}

/** Persist the list (already ordered). Returns true if it was actually written. */
export function writeSavedRoutes(list: SavedRoute[]): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
    return true;
  } catch {
    return false;
  }
}

/** True when a route with this id is already saved. */
export function isRouteSaved(list: SavedRoute[], id: string): boolean {
  return list.some((s) => s.route.id === id);
}

/**
 * Pure toggle: if the route is saved, remove it; otherwise add it newest-first. Returns a NEW
 * list (does not mutate). `now` is injected so callers (and tests) control the timestamp.
 */
export function toggleSavedRoute(list: SavedRoute[], route: ScenicRoute, now: number): SavedRoute[] {
  if (isRouteSaved(list, route.id)) {
    return list.filter((s) => s.route.id !== route.id);
  }
  return [{ route, savedAt: now }, ...list].slice(0, MAX_SAVED);
}

/** Pure removal by id. Returns a NEW list. */
export function removeSavedRoute(list: SavedRoute[], id: string): SavedRoute[] {
  return list.filter((s) => s.route.id !== id);
}

/**
 * Union two saved lists (e.g. local + cloud at first sign-in), deduped by route id keeping the
 * entry with the newer `savedAt`, ordered newest-first and capped at {@link MAX_SAVED}. Pure —
 * neither input is mutated. Used when a rider signs in to fold their on-device rides into the cloud.
 */
export function mergeSavedRoutes(a: SavedRoute[], b: SavedRoute[]): SavedRoute[] {
  const byId = new Map<string, SavedRoute>();
  for (const entry of [...a, ...b]) {
    const existing = byId.get(entry.route.id);
    if (!existing || entry.savedAt > existing.savedAt) byId.set(entry.route.id, entry);
  }
  return [...byId.values()].sort((x, y) => y.savedAt - x.savedAt).slice(0, MAX_SAVED);
}
