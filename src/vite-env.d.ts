/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_MAPS_KEY?: string;
  /** Supabase project URL — when set (with the anon key) it enables sign-in + cloud ride sync. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon/publishable key. Safe to ship; access is gated by Row Level Security. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
