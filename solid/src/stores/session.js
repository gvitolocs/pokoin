import { createSignal } from 'solid-js';
import { AUTH_SESSION_KEY, profileFromSession, readAuthSession } from '@market/auth-session.js';

/**
 * First-paint identity from the session the React AuthProvider persists
 * (`pokoin.auth.session`). It is a cache, never authority: Firebase Auth
 * (loaded lazily, not on the first paint) confirms or clears it, and every
 * write still sends a fresh bearer the API verifies.
 */
const [session, setSession] = createSignal(readAuthSession());

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === AUTH_SESSION_KEY || event.key === null) setSession(readAuthSession());
  });
}

export const authSession = session;
export const profile = () => profileFromSession(session());
export function refreshSession() {
  setSession(readAuthSession());
}
