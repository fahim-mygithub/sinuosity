/**
 * Account seam. The app is currently localStorage-only — there is no backend — so there is no
 * signed-in user. This module is the SINGLE place the rest of the app asks "who's signed in?",
 * so wiring a real provider later (Supabase / Firebase Google OAuth + a cloud `saved_routes`
 * table) is a localized swap: implement these three functions and nothing else changes its imports.
 *
 * Until then `getAccount()` returns null and `signInWithGoogle()` reports the feature isn't live.
 */

export interface Account {
  id: string;
  name: string;
  email: string;
  /** Avatar URL, when the provider supplies one. */
  avatarUrl?: string;
}

/** Whether a real auth backend is wired. False today (localStorage-only build). */
export const AUTH_ENABLED = false;

/** The signed-in rider, or null when none / no backend. */
export function getAccount(): Account | null {
  return null;
}

/**
 * Begin Google sign-in. No-op until a backend is wired — returns a reason the UI can surface so
 * the disabled button stays honest about why it can't sign you in yet.
 */
export function signInWithGoogle(): { ok: false; reason: string } {
  return {
    ok: false,
    reason: 'Google sign-in isn’t live yet — it arrives when cloud sync is enabled.',
  };
}

/** Sign out. No-op today. */
export function signOut(): void {
  /* no backend session to clear */
}
