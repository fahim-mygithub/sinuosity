-- Sinuosity: per-rider saved rides + scan history.
--
-- Both tables are owner-scoped by Row Level Security: a rider can only ever see or change their
-- own rows (auth.uid() = user_id). Client-facing timestamps are stored as bigint epoch-millis to
-- round-trip the app's local models exactly (no timezone drift); created_at is a server-side
-- timestamptz for ordering/debugging. user_id defaults to auth.uid() so inserts never have to
-- trust a client-supplied owner.

-- ---- saved_rides ----------------------------------------------------------------------------
create table if not exists public.saved_rides (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  route_id   text        not null,
  route      jsonb       not null,
  saved_at   bigint      not null,
  created_at timestamptz not null default now(),
  primary key (user_id, route_id)
);

alter table public.saved_rides enable row level security;

create policy "saved_rides: owner reads"   on public.saved_rides
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "saved_rides: owner inserts" on public.saved_rides
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "saved_rides: owner updates" on public.saved_rides
  for update to authenticated using ((select auth.uid()) = user_id)
                                  with check ((select auth.uid()) = user_id);
create policy "saved_rides: owner deletes" on public.saved_rides
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ---- scan_history ---------------------------------------------------------------------------
create table if not exists public.scan_history (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,           -- client-generated scan id (scan_<ts>_<suffix>)
  center     jsonb       not null,           -- { label, lat, lon }
  radius_km  int         not null,
  bias       jsonb       not null,           -- BiasWeights snapshot
  ride_count int         not null,
  rides      jsonb       not null,           -- the built ScenicRoute[] so history re-opens
  scanned_at bigint      not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.scan_history enable row level security;

create policy "scan_history: owner reads"   on public.scan_history
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "scan_history: owner inserts" on public.scan_history
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "scan_history: owner updates" on public.scan_history
  for update to authenticated using ((select auth.uid()) = user_id)
                                  with check ((select auth.uid()) = user_id);
create policy "scan_history: owner deletes" on public.scan_history
  for delete to authenticated using ((select auth.uid()) = user_id);

-- scanned_at index for the newest-first history query.
create index if not exists scan_history_user_scanned_idx
  on public.scan_history (user_id, scanned_at desc);
