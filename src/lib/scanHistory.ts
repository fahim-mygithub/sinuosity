import type { ScenicRoute } from '../data/types';
import type { BiasWeights } from './composite';

/**
 * A record of one Scan the rider ran — the inputs (where, how wide, what bias) plus the rides it
 * built. The full {@link ScenicRoute}s are kept so a history entry re-opens through the very same
 * review/cruise path live scans use, with no re-query. Persisted in localStorage; mirrored to the
 * rider's account (Supabase `scan_history`) when signed in. Newest-first.
 */
export interface ScanRecord {
  /** Client-generated id (also the Supabase row id when synced). */
  id: string;
  center: { label: string; lat: number; lon: number };
  radiusKm: number;
  /** The bias weights in effect when the scan ran. */
  bias: BiasWeights;
  rideCount: number;
  /** The rides this scan produced, so the entry re-opens without a re-scan. */
  rides: ScenicRoute[];
  /** Epoch millis the scan ran. */
  scannedAt: number;
}

const STORAGE_KEY = 'sinuosity.scanHistory.v1';
const MAX_HISTORY = 40; // keep the most recent scans; older ones fall off (localStorage stays bounded)

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
function isScanRecord(x: unknown): x is ScanRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as ScanRecord;
  return (
    typeof r.id === 'string' &&
    !!r.center && typeof r.center === 'object' &&
    Number.isFinite(r.center.lat) && Number.isFinite(r.center.lon) &&
    Number.isFinite(r.radiusKm) &&
    Array.isArray(r.rides) &&
    Number.isFinite(r.scannedAt)
  );
}

/** All scan records, newest first. Invalid entries are dropped; returns [] on any failure. */
export function loadScanHistory(): ScanRecord[] {
  const s = store();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isScanRecord);
  } catch {
    return [];
  }
}

/** Persist the list (already ordered). Returns true if it was actually written. */
export function writeScanHistory(list: ScanRecord[]): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
    return true;
  } catch {
    return false;
  }
}

/** Prepend a record newest-first, capped at {@link MAX_HISTORY}. Pure — returns a NEW list. */
export function addScanRecord(list: ScanRecord[], record: ScanRecord): ScanRecord[] {
  return [record, ...list.filter((r) => r.id !== record.id)].slice(0, MAX_HISTORY);
}

/** Pure removal by id. Returns a NEW list. */
export function removeScanRecord(list: ScanRecord[], id: string): ScanRecord[] {
  return list.filter((r) => r.id !== id);
}

/**
 * Union two histories (local + cloud at first sign-in), deduped by id, newest-first, capped at
 * {@link MAX_HISTORY}. Pure — neither input is mutated.
 */
export function mergeScanHistory(a: ScanRecord[], b: ScanRecord[]): ScanRecord[] {
  const byId = new Map<string, ScanRecord>();
  for (const r of [...a, ...b]) {
    const existing = byId.get(r.id);
    if (!existing || r.scannedAt > existing.scannedAt) byId.set(r.id, r);
  }
  return [...byId.values()].sort((x, y) => y.scannedAt - x.scannedAt).slice(0, MAX_HISTORY);
}

/**
 * Build a {@link ScanRecord} from a finished scan. `now` is injected so callers (and tests) control
 * the id + timestamp. The id is timestamp-based with a short random suffix to avoid collisions when
 * two scans land in the same millisecond.
 */
export function makeScanRecord(
  params: {
    center: { label: string; lat: number; lon: number };
    radiusKm: number;
    bias: BiasWeights;
    rides: ScenicRoute[];
  },
  now: number,
): ScanRecord {
  const suffix = Math.abs((params.center.lat * 1000 + params.center.lon * 1000 + params.rides.length) | 0);
  return {
    id: `scan_${now}_${suffix}`,
    center: params.center,
    radiusKm: params.radiusKm,
    bias: params.bias,
    rideCount: params.rides.length,
    rides: params.rides,
    scannedAt: now,
  };
}
