import type { User } from '@supabase/supabase-js';
import { supabase, HAS_BACKEND } from './supabase';

/**
 * Account seam — the SINGLE place the rest of the app asks "who's signed in?".
 *
 * Backed by Supabase Auth (email magic link) when the build has credentials; otherwise the app is
 * localStorage-only and {@link AUTH_ENABLED} is false, exactly as it shipped before. The current
 * account is held in a module-level cache so callers can read it synchronously ({@link getAccount}),
 * and {@link onAuthChange} lets the UI re-render on sign-in / sign-out across tabs.
 */

export interface Account {
  id: string;
  name: string;
  email: string;
  /** Avatar URL, when the provider supplies one. */
  avatarUrl?: string;
}

/** Whether a real auth backend is wired into this build. */
export const AUTH_ENABLED = HAS_BACKEND;

let current: Account | null = null;
const listeners = new Set<(account: Account | null) => void>();

/** Derive a display name: provider full name, else the email's local part, else "Rider". */
function toAccount(user: User): Account {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const fullName = typeof meta.full_name === 'string' ? meta.full_name : undefined;
  const email = user.email ?? '';
  const name = fullName || (email ? email.split('@')[0] : '') || 'Rider';
  const avatarUrl = typeof meta.avatar_url === 'string' ? meta.avatar_url : undefined;
  return { id: user.id, name, email, avatarUrl };
}

function emit() {
  for (const cb of listeners) cb(current);
}

// Hydrate the cache from any persisted session, then track every auth change. The initial
// getSession resolves the magic-link token if the user just landed back from their email.
if (supabase) {
  supabase.auth.getSession().then(({ data }) => {
    current = data.session ? toAccount(data.session.user) : null;
    emit();
  });
  supabase.auth.onAuthStateChange((_event, session) => {
    current = session ? toAccount(session.user) : null;
    emit();
  });
}

/** The signed-in rider, or null when none / no backend. Synchronous read of the cached session. */
export function getAccount(): Account | null {
  return current;
}

/**
 * Subscribe to sign-in / sign-out. Fires with the new account (or null). Returns an unsubscribe.
 * Note: does not fire immediately — read {@link getAccount} for the current value on mount.
 */
export function onAuthChange(cb: (account: Account | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Send a passwordless magic-link sign-in email. The link returns the rider to this same SPA
 * (origin + Vite base, so it works on both localhost and the GitHub Pages sub-path). Returns a
 * reason the UI can surface on failure (or when no backend is wired).
 */
export async function signInWithEmail(
  email: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!supabase) {
    return { ok: false, reason: 'Sign-in isn’t available in this build (no backend configured).' };
  }
  const trimmed = email.trim();
  if (!trimmed) return { ok: false, reason: 'Enter your email to get a sign-in link.' };

  const emailRedirectTo =
    typeof window !== 'undefined'
      ? new URL(import.meta.env.BASE_URL || '/', window.location.origin).toString()
      : undefined;

  const { error } = await supabase.auth.signInWithOtp({
    email: trimmed,
    options: { emailRedirectTo },
  });
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

/** Sign out and clear the cached session. */
export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
  current = null;
  emit();
}
