import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The Supabase client — or `null` when the app is built without backend credentials.
 *
 * Sinuosity ships as a static SPA on GitHub Pages. A fork (or a PR build with no repo secrets)
 * must still build and run, just localStorage-only. So the client is created ONLY when both
 * `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are present at build time; otherwise this is
 * `null` and the rest of the app degrades to its original local-only behavior. Auth + cloud sync
 * are strictly additive — nothing here is required for the core ride finder to work.
 *
 * The anon/publishable key is safe to ship in client code: it only grants what Row Level Security
 * policies allow (every table is owner-scoped to `auth.uid()`).
 */

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // Magic-link redirects land back on the SPA with the token in the URL; let the client
          // pick it up and then clean the address bar.
          detectSessionInUrl: true,
        },
      })
    : null;

/** True when a real backend is wired into this build. */
export const HAS_BACKEND = supabase != null;
