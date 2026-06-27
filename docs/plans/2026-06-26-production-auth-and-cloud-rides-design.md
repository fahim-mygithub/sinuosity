# Production-ready Sinuosity: sign-on + cloud-stored rides

**Date:** 2026-06-26
**Goal:** Turn Sinuosity from a localStorage-only WNY scenic ride finder into a
more production-ready, *general* ride finder with user sign-on and rides stored
in a free cloud database.

## Decisions (confirmed with user)

- **Auth:** Email **magic link** via Supabase Auth (passwordless, zero external
  OAuth setup, works on GitHub Pages immediately).
- **Database:** **Hosted free-tier Supabase** was the chosen target. Because
  provisioning a hosted project requires the user to sign into Supabase (which
  hadn't happened at build time), the implementation was **stood up and verified
  end-to-end against a LOCAL Supabase stack** (`supabase start`, Docker) — which
  the user explicitly green-lit ("a local or some type of free database for
  testing"). The app code is identical for local vs hosted; going live is just
  swapping the two `VITE_SUPABASE_*` env vars and running the same migration
  against the hosted project (see README → "Sign-in & cloud sync").
- **Sync scope:** **Saved rides _and_ scan history** per signed-in user.
- **Generalization:** Drop the WNY framing in copy/branding. The Scan tab and
  location search already work anywhere; this is mostly product copy.

## Why Supabase (architecture already anticipates it)

The codebase was built with the swap in mind:

- `src/lib/account.ts` is the single "who's signed in?" seam and its own doc
  comment names *"Supabase / Firebase Google OAuth + a cloud `saved_routes`
  table"* as the intended backend.
- `src/lib/savedRoutes.ts` is localStorage today with a documented
  "cloud sync is a future swap behind account.ts" note.

So wiring a real backend is a *localized* change behind those seams, not a
rewrite. The app stays a static SPA on GitHub Pages; Supabase is reached
entirely client-side via `@supabase/supabase-js`.

## Graceful degradation (critical for the static build)

The GitHub Pages build must never break when Supabase env vars are absent (e.g.
a fork, a PR build without secrets). So:

- `src/lib/supabase.ts` returns `null` when `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` are not set.
- `AUTH_ENABLED = supabase != null`. With no backend the app behaves exactly as
  it does today — localStorage-only, sign-in button disabled with an honest
  reason. Auth and cloud sync are strictly additive.

## Data model

Two tables in `public`, both RLS-protected, owner-only.

### `saved_rides`
| column     | type          | notes                                  |
|------------|---------------|----------------------------------------|
| id         | uuid pk       | `gen_random_uuid()`                    |
| user_id    | uuid          | `references auth.users(id)` on delete cascade |
| route_id   | text          | the `ScenicRoute.id` (dedupe key per user) |
| route      | jsonb         | the full `ScenicRoute` (re-opens through the same review path) |
| saved_at   | timestamptz   | rider's save time                      |
| created_at | timestamptz   | default `now()`                        |

Unique `(user_id, route_id)` so a ride saves once per user.

### `scan_history`
| column     | type        | notes                                   |
|------------|-------------|-----------------------------------------|
| id         | uuid pk     | `gen_random_uuid()`                     |
| user_id    | uuid        | `references auth.users(id)` on delete cascade |
| center     | jsonb       | `{ label, lat, lon }`                   |
| radius_km  | int         |                                         |
| bias       | jsonb       | `BiasWeights` snapshot                  |
| ride_count | int         | number of rides built                  |
| rides      | jsonb       | the built `ScenicRoute[]` (so history re-opens) |
| scanned_at | timestamptz | default `now()`                        |

### RLS (every table)
- Enable RLS.
- `select` / `insert` / `update` / `delete` policies: `TO authenticated`,
  `using ((select auth.uid()) = user_id)`, and `update` adds
  `with check ((select auth.uid()) = user_id)`.

## Client layers

```
supabase.ts        -> the client (or null)
account.ts         -> getAccount / signInWithEmail / signOut / onAuthChange
ridesStore.ts      -> load/save/remove saved rides + record/list scan history,
                      Supabase-backed when signed in, localStorage when not
savedRoutes.ts     -> stays as the pure local model + merge helpers (tested)
scanHistory.ts     -> pure local model + helpers (tested)
```

- **First sign-in merge:** when a user signs in, local saved rides are merged
  up to the cloud (dedupe by `route_id`, keep newest `saved_at`). Pure merge
  logic is unit-tested.
- The existing `savedRoutes` pure functions (`toggleSavedRoute`, etc.) are
  reused; only the *persistence* target changes with auth state.

## Auth UX (SettingsMenu `AccountSection`)

- Signed out: email field → "Send sign-in link". On submit, magic link sent
  with `emailRedirectTo` = current origin + Vite base. Friendly "check your
  inbox" state.
- Signed in: avatar/initial, email, "Sign out". A new **Scan history** section
  lists recent scans (re-open or clear).
- Subscribes to `onAuthChange` so the whole app reacts to sign-in/out.

## Generalization

- Header: drop the `WNY` badge; subtitle becomes location-agnostic
  ("Twisty + scenic backroads, anywhere you scan").
- `package.json` description, `index.html` title/meta, README: reframe as a
  general ride finder. Scenic/Curated stay as curated examples.

## Testing & deploy

- Pure logic (merge, dedupe, history helpers) via Vitest TDD.
- `.env.example` documents `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`;
  GitHub Actions build passes them from repo secrets (optional — absent ⇒
  localStorage-only build still green).
- End-to-end sign-in + ride-sync verified via Claude Chrome against dev/live.

## Out of scope (YAGNI)

- Google/social OAuth (revisit later; button stays, honest disabled reason
  unless magic link chosen path covers it).
- Realtime sync, sharing rides between users, server-side ride generation.
