# Community ride platform — v1 "save & publish scan results"

**Date:** 2026-06-28
**Status:** shipped (migration applied to the hosted project via MCP; advisors clean)

## Goal

Let a signed-in rider **publish** a ride (any ScenicRoute they're viewing — a scan result, scenic,
or curated ride) as a **public page** that everyone — even signed-out visitors — can browse in a new
**Community** tab, open in the normal cruise page, and react to with a **👍 like** and a **💾 save**.
This is the first brick of the rider's "make the ride page modular so the community builds their
own" vision; v1 publishes the ride as-is (line editing comes in the later "manual editing" phase).

## Decisions (from the user)

- **Discovery:** a 4th **Community** tab (browsable gallery), alongside Scenic / Curated / Scan.
- **Reactions:** a **👍 like** + a **💾 save count** (lowest abuse surface). No stars, no reviews yet.
- **Auth:** publishing/reacting requires sign-in (existing Supabase magic-link). Browsing is open to
  everyone (public read).

## Data model (Supabase)

Mirrors the existing `saved_rides` / `scan_history` conventions (jsonb route, `bigint` epoch-millis,
`user_id default auth.uid()`), with one change: these tables are **public-read** instead of
owner-only, so RLS is the security boundary that matters here.

### `public_rides` — one row per published ride
- `id uuid pk default gen_random_uuid()` — surrogate key (two riders can publish rides whose
  client `route.id` collides, so we don't key on it).
- `author_id uuid default auth.uid()`, `author_name text` (denormalized for display).
- `route jsonb` — the full ScenicRoute so the cruise page re-opens unchanged.
- Denormalized display columns so the gallery list never parses jsonb: `name, theme, region,
  distance_km, score, curvature, grade_drama`.
- `like_count int`, `save_count int` — denormalized counters maintained by a trigger.
- `published_at bigint`, `created_at timestamptz`.
- **RLS:** `select` to `anon, authenticated` (`using (true)`); `insert/update/delete` only by the
  author (`(select auth.uid()) = author_id`). So anyone can read; only the author can change theirs.

### `ride_reactions` — a rider's 👍/💾 on a ride
- `(public_ride_id, user_id, kind)` composite PK; `kind in ('like','save')` — one row per
  rider-per-ride-per-kind (idempotent toggling).
- **RLS:** `select` public (to count + show the viewer's own reacted state, filtered client-side by
  `user_id`); `insert/delete` only the owner (`(select auth.uid()) = user_id`).

### Count trigger
`bump_ride_reaction_count()` — `after insert or delete on ride_reactions`, updates the affected
ride's `like_count`/`save_count`. It is `security definer` (a reacting user isn't the ride's author,
so it must bump a row it can't otherwise write) with `set search_path = ''` and **`execute`
revoked from public** — it only ever adjusts the one counter for the affected ride id, nothing else.

## Data layer (`src/lib/cloudSync.ts`)

All graceful no-ops without a backend / sign-in, like the existing functions:
- `pullPublicRides(sort: 'new' | 'top'): Promise<PublicRide[]>` — the gallery.
- `publishRide(route): Promise<PublicRide | null>` / `unpublishRide(id)`.
- `pullMyPublished(): Promise<Map<routeId, publicRideId>>` — so the cruise page knows whether the
  open ride is already published (and can unpublish it).
- `toggleReaction(publicRideId, kind, on)` and `pullMyReactions(): { likes, saves }` — the viewer's
  own 👍/💾 state for instant, optimistic toggling.

`PublicRide = { id, authorName, route, likeCount, saveCount, publishedAt, mine }`.

## UI (next step)

- **Community tab:** gallery of `pullPublicRides`, sort New / Top, each card shows
  name · theme · region · distance · score · 👍count · 💾count; tap → cruise page (reuse
  `ScenicRouteReview`), lines drawn via the existing `drawRides`.
- **Cruise page:** a **Publish / Published** toggle (signed-in only) and a 👍 like button with the
  live count; 💾 save reuses the existing save flow but also records a community save when the ride
  is a published one.

## Invariants

- Fully additive + graceful: no backend or signed-out ⇒ Community tab shows the public gallery
  read-only (or an empty/"sign in to publish" state); nothing else changes.
- The migration is the only thing that must be applied to the hosted project; until then the data
  layer degrades to empty/no-op exactly like the current cloud sync.
