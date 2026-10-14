import { createSignal } from 'solid-js';
import { clearAuthSession, readAuthSession, readAuthToken, writeAuthSession, writeAuthToken } from '@market/auth-session.js';
import { setBearerProvider } from '@market/auth-bearer.js';
import {
  EXTENSION_DESK_SESSION_REQUEST,
  framedByChromeExtension,
  isExtensionDeskSession,
  isTrustedDeskSessionEvent,
} from '@market/extension-auth-bridge.js';
import { authSession, refreshSession } from './session.js';

/**
 * Firebase Auth is not on the first paint: the header and price labels start
 * from the cached session (`pokoin.auth.session`), and the SDK loads on idle
 * or on the first bearer request, whichever comes first. The token cache
 * (`pokoin.auth.token`) is shared with the React UI, so a fresh token can be
 * sent without loading Firebase at all.
 *
 * The extension side panel frames the SPA in a credentialless iframe with no
 * Firebase persistence: the parent extension posts a desk session (uid + ID
 * token) instead, as in React auth.jsx. Sign-in flows live in pages/Auth.jsx;
 * the users/{uid} + balances/{uid} read is stores/account.js.
 */
const [firebaseUser, setFirebaseUser] = createSignal(undefined);
const [deskUid, setDeskUid] = createSignal('');
let deskSession = { token: '', uid: '', expiresAt: 0 };
let hadFirebaseUser = false;
let authPromise = null;

function applyDeskSession(data = {}) {
  const token = String(data.token || '').trim();
  const uid = String(data.uid || '').trim();
  if (token.length <= 20 || !uid) return false;
  deskSession = { token, uid, expiresAt: Number(data.expiresAt) || 0 };
  return true;
}

function dropSession() {
  deskSession = { token: '', uid: '', expiresAt: 0 };
  setDeskUid('');
  clearAuthSession();
  refreshSession();
}

/** Firebase answered. Same rules as React auth.jsx onAuthStateChanged. */
function onFirebaseUser(user) {
  setFirebaseUser(() => user || null);
  if (user) {
    hadFirebaseUser = true;
    // Firebase mints its own tokens from here on.
    deskSession = { token: '', uid: '', expiresAt: 0 };
    setDeskUid('');
    const cached = readAuthSession();
    writeAuthSession(cached?.uid === user.uid ? cached : { uid: user.uid, signedIn: true });
    refreshSession();
    return;
  }
  if (hadFirebaseUser) {
    // An explicit sign-out on this origin: forget the paint hint and the token.
    hadFirebaseUser = false;
    dropSession();
    return;
  }
  // The side panel has no Firebase user; its desk session (if any) stands.
  if (deskSession.token || framedByChromeExtension()) return;
  // Cold start without a Firebase user: a still-valid token cookie signs in.
  const shared = readAuthToken();
  if (shared && applyDeskSession(shared)) {
    writeAuthSession(readAuthSession()?.uid === shared.uid ? readAuthSession() : { uid: shared.uid, signedIn: true });
    refreshSession();
    setDeskUid(shared.uid);
    return;
  }
  dropSession();
}

/**
 * Extension desk-session handshake: ask the parent extension for its session
 * and adopt every trusted answer. Call once from the app shell; returns the
 * listener cleanup. `onSession` runs after a session was adopted.
 */
export function watchDeskSession(onSession) {
  function onMessage(event) {
    if (!isTrustedDeskSessionEvent(event) || !isExtensionDeskSession(event.data)) return;
    if (!applyDeskSession(event.data)) return;
    const uid = deskSession.uid;
    const cached = readAuthSession();
    writeAuthSession(cached?.uid === uid ? cached : { uid, signedIn: true });
    refreshSession();
    setDeskUid(uid);
    onSession?.(uid);
  }
  window.addEventListener('message', onMessage);
  const payload = { type: EXTENSION_DESK_SESSION_REQUEST, source: 'pokoin-web' };
  window.postMessage(payload, window.location.origin);
  try {
    window.parent?.postMessage(payload, '*');
  } catch (_) {
    /* credentialless / sandboxed parent */
  }
  return () => window.removeEventListener('message', onMessage);
}

export function loadAuth() {
  if (!authPromise) {
    authPromise = import('@market/firebase-client.js').then(
      ({ firebaseAuth, onAuthStateChanged, onIdTokenChanged }) => {
        onAuthStateChanged(firebaseAuth, onFirebaseUser);
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
  if (deskSession.token && (!deskSession.expiresAt || deskSession.expiresAt > Date.now() + 60 * 1000)) {
    return deskSession.token;
  }
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

/** The Firebase user: undefined until the SDK answered, then a user or null. */
export const authUser = firebaseUser;

/**
 * React useAuth().ready: Firebase answered, or there is no cached session to
 * confirm (signed-out visitors never load the SDK here, so they are settled).
 */
export function authReady() {
  return firebaseUser() !== undefined || Boolean(deskUid()) || !authSession()?.uid;
}

/** React useAuth().ready for account pages: Firebase (or the extension desk) answered. */
export function authConfirmed() {
  return firebaseUser() !== undefined || Boolean(deskUid());
}

/** The signed-in uid: the Firebase user, else the extension desk session. */
export function authUid() {
  return String(firebaseUser()?.uid || deskUid() || '');
}

/** True once Firebase confirmed a user; before that, the cached session decides. */
export function signedIn() {
  if (deskUid()) return true;
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
