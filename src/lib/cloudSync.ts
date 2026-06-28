import { supabase } from './supabase';
import { getAccount } from './account';
import type { SavedRoute } from './savedRoutes';
import type { ScanRecord } from './scanHistory';
import type { ScenicRoute } from '../data/types';

/** A ride published to the community gallery (public-read). `mine` = the viewer is its author. */
export interface PublicRide {
  id: string;
  authorName: string;
  route: ScenicRoute;
  likeCount: number;
  saveCount: number;
  publishedAt: number;
  mine: boolean;
}

export type ReactionKind = 'like' | 'save';

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

// ---- Community rides (public) -----------------------------------------------------------------
// These tables are PUBLIC-READ (anyone can browse the gallery, even signed out), so the reads here
// don't require a session — only publishing / reacting does. Everything still degrades to empty /
// no-op without a backend. See supabase/migrations/20260628000001_community_rides.sql.

interface PublicRideRow {
  id: string;
  author_id: string;
  author_name: string;
  route: ScenicRoute;
  like_count: number;
  save_count: number;
  published_at: number;
}

function toPublicRide(row: PublicRideRow): PublicRide {
  return {
    id: row.id,
    authorName: row.author_name,
    route: row.route,
    likeCount: Number(row.like_count) || 0,
    saveCount: Number(row.save_count) || 0,
    publishedAt: Number(row.published_at) || 0,
    mine: row.author_id === uid(),
  };
}

/** Browse the community gallery, newest-first or most-liked. Public read — works signed out. */
export async function pullPublicRides(sort: 'new' | 'top' = 'new'): Promise<PublicRide[]> {
  if (!supabase) return [];
  const col = sort === 'top' ? 'like_count' : 'published_at';
  const { data, error } = await supabase
    .from('public_rides')
    .select('id, author_id, author_name, route, like_count, save_count, published_at')
    .order(col, { ascending: false })
    .limit(200);
  if (error || !data) return [];
  return (data as PublicRideRow[])
    .filter((r) => r.route && typeof r.route.id === 'string')
    .map(toPublicRide);
}

/** Publish (or re-publish) a ride to the community gallery. Returns the public row, or null. */
export async function publishRide(route: ScenicRoute): Promise<PublicRide | null> {
  const user_id = uid();
  if (!supabase || !user_id) return null;
  const author_name = getAccount()?.name ?? 'Rider';
  const { data, error } = await supabase
    .from('public_rides')
    .upsert(
      {
        author_id: user_id,
        author_name,
        route_id: route.id,
        route,
        name: route.name,
        theme: route.theme,
        region: route.region,
        distance_km: route.distanceKm,
        score: route.score,
        curvature: route.rubric.curvature,
        grade_drama: route.rubric.gradeDrama ?? null,
        published_at: Date.now(),
      },
      { onConflict: 'author_id,route_id' },
    )
    .select('id, author_id, author_name, route, like_count, save_count, published_at')
    .single();
  if (error || !data) return null;
  return toPublicRide(data as PublicRideRow);
}

/** Remove a ride the rider published (RLS enforces author-only). */
export async function unpublishRide(id: string): Promise<void> {
  const user_id = uid();
  if (!supabase || !user_id) return;
  await supabase.from('public_rides').delete().eq('id', id).eq('author_id', user_id);
}

/** Map of the rider's own published rides: client route id → server public-ride id (for the cruise
 *  page's Publish/Unpublish toggle). Empty without a session. */
export async function pullMyPublished(): Promise<Map<string, string>> {
  const user_id = uid();
  const out = new Map<string, string>();
  if (!supabase || !user_id) return out;
  const { data, error } = await supabase
    .from('public_rides')
    .select('id, route_id')
    .eq('author_id', user_id);
  if (error || !data) return out;
  for (const row of data as { id: string; route_id: string }[]) out.set(row.route_id, row.id);
  return out;
}

/** Add or remove the rider's reaction (👍 like / 💾 save) on a published ride. */
export async function toggleReaction(publicRideId: string, kind: ReactionKind, on: boolean): Promise<void> {
  const user_id = uid();
  if (!supabase || !user_id) return;
  if (on) {
    await supabase
      .from('ride_reactions')
      .upsert({ public_ride_id: publicRideId, user_id, kind }, { onConflict: 'public_ride_id,user_id,kind', ignoreDuplicates: true });
  } else {
    await supabase
      .from('ride_reactions')
      .delete()
      .eq('public_ride_id', publicRideId)
      .eq('user_id', user_id)
      .eq('kind', kind);
  }
}

/** The rider's own reactions, as sets of public-ride ids per kind, for instant toggle state. */
export async function pullMyReactions(): Promise<{ likes: Set<string>; saves: Set<string> }> {
  const user_id = uid();
  const likes = new Set<string>();
  const saves = new Set<string>();
  if (!supabase || !user_id) return { likes, saves };
  const { data, error } = await supabase
    .from('ride_reactions')
    .select('public_ride_id, kind')
    .eq('user_id', user_id);
  if (error || !data) return { likes, saves };
  for (const row of data as { public_ride_id: string; kind: ReactionKind }[]) {
    (row.kind === 'like' ? likes : saves).add(row.public_ride_id);
  }
  return { likes, saves };
}
