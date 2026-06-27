import { supabase } from './supabase';
import { getAccount } from './account';
import type { SavedRoute } from './savedRoutes';
import type { ScanRecord } from './scanHistory';
import type { ScenicRoute } from '../data/types';

/**
 * Supabase persistence for a signed-in rider's saved rides + scan history. Every call is a no-op
 * (resolving empty / void) when there's no backend or nobody is signed in, so callers can invoke
 * these unconditionally and let auth state decide whether anything actually hits the network.
 *
 * Tables are owner-scoped by Row Level Security (`auth.uid() = user_id`); we still send `user_id`
 * explicitly so upserts target the `(user_id, …)` primary key. Client-side timestamps are stored as
 * `bigint` epoch-millis to round-trip the existing local models exactly (no timezone drift).
 */

function uid(): string | null {
  return getAccount()?.id ?? null;
}

// ---- Saved rides -----------------------------------------------------------------------------

/** Pull all of the rider's cloud-saved rides, newest first. Returns [] when unavailable. */
export async function pullSavedRides(): Promise<SavedRoute[]> {
  if (!supabase || !uid()) return [];
  const { data, error } = await supabase
    .from('saved_rides')
    .select('route, saved_at')
    .order('saved_at', { ascending: false });
  if (error || !data) return [];
  return data
    .map((row) => ({ route: row.route as ScenicRoute, savedAt: Number(row.saved_at) }))
    .filter((s) => s.route && typeof s.route.id === 'string');
}

/** Insert/replace one saved ride. */
export async function pushSavedRide(route: ScenicRoute, savedAt: number): Promise<void> {
  const user_id = uid();
  if (!supabase || !user_id) return;
  await supabase
    .from('saved_rides')
    .upsert({ user_id, route_id: route.id, route, saved_at: savedAt }, { onConflict: 'user_id,route_id' });
}

/** Remove one saved ride by its route id. */
export async function deleteSavedRide(routeId: string): Promise<void> {
  const user_id = uid();
  if (!supabase || !user_id) return;
  await supabase.from('saved_rides').delete().eq('user_id', user_id).eq('route_id', routeId);
}

/** Upsert many saved rides at once (used to fold local rides into the cloud at first sign-in). */
export async function pushSavedRides(list: SavedRoute[]): Promise<void> {
  const user_id = uid();
  if (!supabase || !user_id || list.length === 0) return;
  const rows = list.map((s) => ({ user_id, route_id: s.route.id, route: s.route, saved_at: s.savedAt }));
  await supabase.from('saved_rides').upsert(rows, { onConflict: 'user_id,route_id' });
}

// ---- Scan history ----------------------------------------------------------------------------

/** Pull the rider's cloud scan history, newest first. Returns [] when unavailable. */
export async function pullScanHistory(): Promise<ScanRecord[]> {
  if (!supabase || !uid()) return [];
  const { data, error } = await supabase
    .from('scan_history')
    .select('id, center, radius_km, bias, ride_count, rides, scanned_at')
    .order('scanned_at', { ascending: false });
  if (error || !data) return [];
  return data.map((row) => ({
    id: row.id as string,
    center: row.center as ScanRecord['center'],
    radiusKm: Number(row.radius_km),
    bias: row.bias as ScanRecord['bias'],
    rideCount: Number(row.ride_count),
    rides: (row.rides as ScenicRoute[]) ?? [],
    scannedAt: Number(row.scanned_at),
  }));
}

/** Insert one scan record. */
export async function pushScanRecord(record: ScanRecord): Promise<void> {
  const user_id = uid();
  if (!supabase || !user_id) return;
  await supabase.from('scan_history').upsert(
    {
      user_id,
      id: record.id,
      center: record.center,
      radius_km: record.radiusKm,
      bias: record.bias,
      ride_count: record.rideCount,
      rides: record.rides,
      scanned_at: record.scannedAt,
    },
    { onConflict: 'user_id,id' },
  );
}

/** Remove one scan record by id. */
export async function deleteScanRecord(id: string): Promise<void> {
  const user_id = uid();
  if (!supabase || !user_id) return;
  await supabase.from('scan_history').delete().eq('user_id', user_id).eq('id', id);
}
