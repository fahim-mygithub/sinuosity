-- Sinuosity community ride platform (v1: "save & publish scan results").
--
-- Unlike saved_rides / scan_history (owner-only), these tables are PUBLIC-READ: anyone — even a
-- signed-out visitor — can browse the community gallery. RLS is therefore the security boundary:
-- read is open, but only a row's author/owner can change it. Timestamps follow the app's convention
-- (bigint epoch-millis for client round-trip; created_at timestamptz for ordering/debugging).

-- ---- public_rides ---------------------------------------------------------------------------
create table if not exists public.public_rides (
  id           uuid        not null default gen_random_uuid() primary key,
  author_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  author_name  text        not null,
  route_id     text        not null,                 -- client ScenicRoute.id, for "already published?" + idempotent re-publish
  route        jsonb       not null,                 -- the full ScenicRoute, so the cruise page re-opens
  -- denormalized display fields so the gallery list never has to parse jsonb
  name         text        not null,
  theme        text        not null,
  region       text        not null,
  distance_km  numeric     not null,
  score        int         not null,
  curvature    numeric     not null,
  grade_drama  numeric,
  like_count   int         not null default 0,
  save_count   int         not null default 0,
  published_at bigint      not null,
  created_at   timestamptz not null default now(),
  unique (author_id, route_id)                       -- a rider re-publishing the same ride upserts, not duplicates
);

alter table public.public_rides enable row level security;

-- Anyone (incl. anon) may browse the gallery; only the author may write their own rows.
create policy "public_rides: anyone reads"    on public.public_rides
  for select to anon, authenticated using (true);
create policy "public_rides: author inserts"  on public.public_rides
  for insert to authenticated with check ((select auth.uid()) = author_id);
create policy "public_rides: author updates"  on public.public_rides
  for update to authenticated using ((select auth.uid()) = author_id)
                                    with check ((select auth.uid()) = author_id);
create policy "public_rides: author deletes"  on public.public_rides
  for delete to authenticated using ((select auth.uid()) = author_id);

create index if not exists public_rides_published_idx on public.public_rides (published_at desc);
create index if not exists public_rides_likes_idx     on public.public_rides (like_count desc);
create index if not exists public_rides_author_idx    on public.public_rides (author_id);

-- ---- ride_reactions -------------------------------------------------------------------------
create table if not exists public.ride_reactions (
  public_ride_id uuid        not null references public.public_rides (id) on delete cascade,
  user_id        uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind           text        not null check (kind in ('like', 'save')),
  created_at     timestamptz not null default now(),
  primary key (public_ride_id, user_id, kind)
);

alter table public.ride_reactions enable row level security;

-- Reaction rows are world-readable (counts + the viewer's own reacted state, filtered client-side by
-- user_id); only the owner may add or remove their own reaction.
create policy "ride_reactions: anyone reads"  on public.ride_reactions
  for select to anon, authenticated using (true);
create policy "ride_reactions: owner inserts" on public.ride_reactions
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "ride_reactions: owner deletes" on public.ride_reactions
  for delete to authenticated using ((select auth.uid()) = user_id);

create index if not exists ride_reactions_ride_idx on public.ride_reactions (public_ride_id);
create index if not exists ride_reactions_user_idx on public.ride_reactions (user_id);

-- ---- denormalized counters -------------------------------------------------------------------
-- Keep public_rides.like_count / save_count in sync as reactions are added/removed. SECURITY DEFINER
-- because a reacting rider is NOT the ride's author and so cannot write public_rides under RLS; the
-- function is deliberately minimal — it only adjusts the two counters for the one affected ride id,
-- runs with an empty search_path, and has EXECUTE revoked so it cannot be called as a public RPC.
create or replace function public.bump_ride_reaction_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT') then
    update public.public_rides
       set like_count = like_count + (new.kind = 'like')::int,
           save_count = save_count + (new.kind = 'save')::int
     where id = new.public_ride_id;
    return new;
  elsif (tg_op = 'DELETE') then
    update public.public_rides
       set like_count = greatest(0, like_count - (old.kind = 'like')::int),
           save_count = greatest(0, save_count - (old.kind = 'save')::int)
     where id = old.public_ride_id;
    return old;
  end if;
  return null;
end;
$$;

-- Supabase grants EXECUTE on new public functions to anon/authenticated by default; revoke from all
-- so this definer function is never callable as an RPC. A trigger fires regardless of EXECUTE grants.
revoke execute on function public.bump_ride_reaction_count() from public, anon, authenticated;

drop trigger if exists ride_reactions_count_aiud on public.ride_reactions;
create trigger ride_reactions_count_aiud
  after insert or delete on public.ride_reactions
  for each row execute function public.bump_ride_reaction_count();
