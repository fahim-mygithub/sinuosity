import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadScanHistory,
  writeScanHistory,
  addScanRecord,
  removeScanRecord,
  makeScanRecord,
  mergeScanHistory,
  type ScanRecord,
} from './scanHistory';
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

const ride = (id: string): ScenicRoute => ({
  id, name: `Ride ${id}`, theme: 'Backroad', region: 'Anywhere', distanceKm: 30,
  drivingTime: '40 min', summary: '', whyRide: '',
  rubric: { curvature: 5, scenery: 5, greenery: 5, water: 5, notability: 5 },
  score: 60, color: '#10b981', coords: [[42.7, -78.8]], stops: [],
});

const rec = (id: string, scannedAt: number): ScanRecord => ({
  id,
  center: { label: 'Test', lat: 42.7, lon: -78.8 },
  radiusKm: 12,
  bias: { curvature: 1, scenery: 0.5, greenery: 0.5, water: 0.5, notability: 0.5 },
  rideCount: 1,
  rides: [ride('a')],
  scannedAt,
});

describe('scanHistory', () => {
  it('starts empty', () => {
    expect(loadScanHistory()).toEqual([]);
  });

  it('round-trips a list', () => {
    const list = [rec('1', 1000)];
    expect(writeScanHistory(list)).toBe(true);
    expect(loadScanHistory()).toEqual(list);
  });

  it('addScanRecord prepends newest-first without mutating input', () => {
    const list: ScanRecord[] = [rec('1', 1000)];
    const next = addScanRecord(list, rec('2', 2000));
    expect(next.map((r) => r.id)).toEqual(['2', '1']);
    expect(list.length).toBe(1);
  });

  it('addScanRecord caps the history length', () => {
    let list: ScanRecord[] = [];
    for (let i = 0; i < 60; i++) list = addScanRecord(list, rec(`${i}`, i));
    expect(list.length).toBe(40); // MAX_HISTORY
    expect(list[0].id).toBe('59'); // newest kept
    expect(list.some((r) => r.id === '0')).toBe(false); // oldest dropped
  });

  it('removeScanRecord drops by id', () => {
    const list = [rec('1', 1), rec('2', 2)];
    expect(removeScanRecord(list, '1').map((r) => r.id)).toEqual(['2']);
  });

  it('makeScanRecord builds a record with a stable id from the timestamp', () => {
    const r = makeScanRecord(
      { center: { label: 'X', lat: 1, lon: 2 }, radiusKm: 10, bias: rec('x', 0).bias, rides: [ride('a'), ride('b')] },
      1700000000000,
    );
    expect(r.scannedAt).toBe(1700000000000);
    expect(r.rideCount).toBe(2);
    expect(typeof r.id).toBe('string');
    expect(r.id.length).toBeGreaterThan(0);
  });

  it('mergeScanHistory unions, dedupes by id, newest-first, capped', () => {
    const local = [rec('1', 1000), rec('2', 2000)];
    const cloud = [rec('2', 2000), rec('3', 3000)];
    const merged = mergeScanHistory(local, cloud);
    expect(merged.map((r) => r.id)).toEqual(['3', '2', '1']);
  });

  it('drops corrupt entries on load', () => {
    localStorage.setItem(
      'sinuosity.scanHistory.v1',
      JSON.stringify([rec('ok', 5), { nope: true }, 42]),
    );
    const loaded = loadScanHistory();
    expect(loaded.length).toBe(1);
    expect(loaded[0].id).toBe('ok');
  });
});
