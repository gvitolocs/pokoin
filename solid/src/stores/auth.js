import { createSignal } from 'solid-js';
import { readAuthToken, writeAuthToken } from '@market/auth-session.js';
import { setBearerProvider } from '@market/auth-bearer.js';
import { authSession } from './session.js';

/**
 * Firebase Auth is not on the first paint: the header and price labels start
 * from the cached session (`pokoin.auth.session`), and the SDK loads on idle
 * or on the first bearer request, whichever comes first. The token cache
 * (`pokoin.auth.token`) is shared with the React UI, so a fresh token can be
 * sent without loading Firebase at all.
 *
 * Not ported yet (React auth.jsx keeps them): sign-in flows, the extension
 * desk-session handshake, and the Firestore profile/balance listeners. Pages
 * that need them are not migrated.
 */
const [firebaseUser, setFirebaseUser] = createSignal(undefined);
let authPromise = null;

export function loadAuth() {
  if (!authPromise) {
    authPromise = import('@market/firebase-client.js').then(
      ({ firebaseAuth, onAuthStateChanged, onIdTokenChanged }) => {
        onAuthStateChanged(firebaseAuth, (user) => setFirebaseUser(() => user || null));
        onIdTokenChanged(firebaseAuth, async (user) => {
          if (!user) return;
          try {
            const result = await user.getIdTokenResult();
            const expiresAt = Date.parse(result.expirationTime) || (Date.now() + 55 * 60 * 1000);
            writeAuthToken({ token: result.token, uid: user.uid, expiresAt });
          } catch (_) {
            /* transient token errors: the next request retries */
          }
        });
        return firebaseAuth;
      },
      (err) => {
        authPromise = null;
        throw err;
      },
    );
  }
  return authPromise;
}

/** Same contract as auth.jsx getBearer: a token, or '' when signed out. */
export async function getBearer(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = readAuthToken();
    if (cached?.token && cached.uid && cached.uid === authSession()?.uid
      && (Number(cached.expiresAt) || 0) > Date.now() + 60 * 1000) {
      return cached.token;
    }
  }
  const auth = await loadAuth();
  const user = auth.currentUser;
  return user ? user.getIdToken(forceRefresh) : '';
}

setBearerProvider(getBearer);

/** True once Firebase confirmed a user; before that, the cached session decides. */
export function signedIn() {
  const user = firebaseUser();
  return user === undefined ? Boolean(authSession()?.uid) : Boolean(user);
}

/** Load the SDK when the page is idle so later writes do not wait on it. */
export function warmAuthWhenIdle() {
  if (!authSession()?.uid || typeof window === 'undefined') return;
  const run = () => loadAuth().catch(() => {});
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 4000 });
  else window.setTimeout(run, 1500);
}
