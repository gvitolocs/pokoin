import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, initializeAuth, inMemoryPersistence, onAuthStateChanged, onIdTokenChanged } from 'firebase/auth';
import { doc, getFirestore, onSnapshot } from 'firebase/firestore';
import {
  clearAuthSession,
  profileFromSession,
  readAuthSession,
  readAuthToken,
  writeAuthSession,
  writeAuthToken,
  sellerNameOf,
} from './auth-session.js';
import {
  EXTENSION_DESK_SESSION_REQUEST,
  framedByChromeExtension,
  isExtensionDeskSession,
} from './extension-auth-bridge.js';
import { fetchDeskUserDocuments } from './firestore-rest.js';

export { sellerNameOf };

/** Same public web config as Flutter `DefaultFirebaseOptions.web`. */
const firebaseApp = initializeApp({
  apiKey: 'AIzaSyDlbKXeR0R3aAATZtCG6dhEPUw39DhXQpU',
  authDomain: 'pokoin.firebaseapp.com',
  projectId: 'pokoin',
  storageBucket: 'pokoin.firebasestorage.app',
  messagingSenderId: '36941064114',
  appId: '1:36941064114:web:e6ca84f2723df9ee71e6ab',
});

function createFirebaseAuth(app) {
  if (typeof window !== 'undefined' && framedByChromeExtension()) {
    try {
      return initializeAuth(app, { persistence: inMemoryPersistence });
    } catch (_) {
      return getAuth(app);
    }
  }
  return getAuth(app);
}

export const firebaseAuth = createFirebaseAuth(firebaseApp);
export const firestore = getFirestore(firebaseApp);

let injectedDeskSession = { token: '', uid: '', expiresAt: 0 };

function isTrustedDeskSessionEvent(event) {
  const origin = String(event?.origin || '');
  if (origin.startsWith('chrome-extension:')) {
    return true;
  }
  try {
    return origin === window.location.origin;
  } catch (_) {
    return false;
  }
}

function applyInjectedDeskSession(data = {}) {
  const token = String(data.token || '').trim();
  const uid = String(data.uid || '').trim();
  const expiresAt = Number(data.expiresAt) || 0;
  if (token.length <= 20 || !uid) {
    return false;
  }
  injectedDeskSession = { token, uid, expiresAt };
  return true;
}

function isPrivateDevHost(hostname = '') {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === 'nezopt'
    || /^100\.\d+\.\d+\.\d+$/.test(host);
}

/** Vite `/__dev/bearer` — Tailscale/local only. Never hits production. */
async function bootstrapPrivateDevBearer() {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return false;
  }
  if (!isPrivateDevHost(window.location.hostname)) {
    return false;
  }
  if (injectedDeskSession.token && injectedDeskSession.uid) {
    return true;
  }
  try {
    const res = await fetch('/__dev/bearer', { cache: 'no-store' });
    if (!res.ok) {
      return false;
    }
    const data = await res.json();
    if (!applyInjectedDeskSession(data)) {
      return false;
    }
    writeAuthToken({
      token: data.token,
      uid: data.uid,
      expiresAt: Number(data.expiresAt) || 0,
    });
    writeAuthSession({ uid: data.uid, signedIn: true });
    return true;
  } catch (_) {
    return false;
  }
}

export async function getBearer(forceRefresh = false) {
  const injected = String(injectedDeskSession.token || '').trim();
  const expiresAt = Number(injectedDeskSession.expiresAt) || 0;
  if (injected && (!expiresAt || expiresAt > Date.now() + 60 * 1000)) {
    return injected;
  }
  const user = firebaseAuth.currentUser;
  if (!user) {
    // The injected desk token is expired and there is no Firebase session to
    // mint a fresh one — return nothing so callers get a clean 401 / sign-in
    // state instead of a guaranteed token-expired rejection.
    return '';
  }
  return user.getIdToken(forceRefresh);
}

function readDate(value) {
  if (!value) {
    return null;
  }
  if (typeof value.toDate === 'function') {
    return value.toDate();
  }
  if (typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function profileFrom(data = {}, uid = '') {
  const role = String(data.role || '').trim().toLowerCase();
  const roles = Array.isArray(data.roles) ? data.roles.map((row) => String(row).toLowerCase()) : [];
  const admin = data.admin === true || data.isAdmin === true || role === 'admin' || roles.includes('admin');
  const silverUntil = readDate(data.silverUntil);
  const silver = admin || role === 'silver' || (silverUntil && silverUntil.getTime() > Date.now());
  return {
    uid,
    username: data.username || '',
    role: data.role || '',
    admin,
    silver,
    silverUntil,
  };
}

const AuthContext = createContext({
  user: null,
  ready: false,
  signedIn: false,
  sellerName: 'Pokoin seller',
  profile: null,
  availablePkn: 0,
  admin: false,
  silver: false,
  getBearer,
});

export function AuthProvider({ children }) {
  const hint = useMemo(() => {
    const cached = readAuthToken();
    if (cached) {
      applyInjectedDeskSession(cached);
    }
    return readAuthSession();
  }, []);
  const [user, setUser] = useState(() => firebaseAuth.currentUser);
  const [ready, setReady] = useState(false);
  const [extensionUid, setExtensionUid] = useState(() => injectedDeskSession.uid || '');
  const [profile, setProfile] = useState(() => profileFromSession(hint));
  const [availablePkn, setAvailablePkn] = useState(() => hint?.availablePkn || 0);
  const persistRef = useRef({
    uid: hint?.uid || '',
    admin: Boolean(hint?.admin),
    silver: Boolean(hint?.silver),
    silverUntil: hint?.silverUntil || null,
    availablePkn: hint?.availablePkn || 0,
  });
  // Distinguishes cold-start on dashboard (adopt .pokoin.com cookie) from an
  // explicit Firebase sign-out on this origin (wipe the shared cookie).
  const hadFirebaseUserRef = useRef(Boolean(firebaseAuth.currentUser));

  function persistSession(partial) {
    persistRef.current = { ...persistRef.current, ...partial };
    const next = persistRef.current;
    if (!next.uid) {
      return;
    }
    writeAuthSession(next);
  }

  async function hydrateInjectedDeskProfile() {
    const uid = injectedDeskSession.uid;
    const token = injectedDeskSession.token;
    if (!uid || String(token || '').length <= 20) {
      return;
    }
    try {
      const docs = await fetchDeskUserDocuments(uid, token);
      if (injectedDeskSession.uid !== uid) {
        return;
      }
      const next = profileFrom(docs.user || {}, uid);
      const nextPkn = Number(docs.balance?.availablePkn || 0);
      setProfile(next);
      setAvailablePkn(nextPkn);
      persistSession({
        uid,
        admin: next.admin,
        silver: next.silver,
        silverUntil: next.silverUntil,
        availablePkn: nextPkn,
      });
    } catch (_) {
      if (injectedDeskSession.uid !== uid) {
        return;
      }
      setProfile((current) => current?.uid === uid ? current : profileFrom({}, uid));
    }
  }

  useEffect(() => {
    function requestDeskSession() {
      const payload = { type: EXTENSION_DESK_SESSION_REQUEST, source: 'pokoin-web' };
      window.postMessage(payload, window.location.origin);
      try {
        window.parent?.postMessage(payload, '*');
      } catch (_) {
        /* credentialless / sandboxed parent */
      }
    }

    function onMessage(event) {
      if (!isTrustedDeskSessionEvent(event) || !isExtensionDeskSession(event.data)) {
        return;
      }
      if (!applyInjectedDeskSession(event.data)) {
        return;
      }
      const uid = injectedDeskSession.uid;
      setExtensionUid(uid);
      persistSession({ uid });
      const hinted = persistRef.current.admin || persistRef.current.silver
        ? profileFromSession({
          uid,
          signedIn: true,
          admin: persistRef.current.admin,
          silver: persistRef.current.silver,
          silverUntil: persistRef.current.silverUntil,
        })
        : null;
      setProfile((current) => (current?.uid === uid && current?.silver ? current : hinted));
      setReady(true);
      void hydrateInjectedDeskProfile();
    }

    window.addEventListener('message', onMessage);
    requestDeskSession();
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await bootstrapPrivateDevBearer();
      if (cancelled || !ok) return;
      const uid = injectedDeskSession.uid;
      if (!uid) return;
      setExtensionUid(uid);
      persistSession({ uid });
      void hydrateInjectedDeskProfile();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => onAuthStateChanged(firebaseAuth, (next) => {
    setUser(next);
    if (!next) {
      if (hadFirebaseUserRef.current) {
        hadFirebaseUserRef.current = false;
        injectedDeskSession = { token: '', uid: '', expiresAt: 0 };
        persistRef.current = {
          uid: '',
          admin: false,
          silver: false,
          silverUntil: null,
          availablePkn: 0,
        };
        setExtensionUid('');
        setProfile(null);
        setAvailablePkn(0);
        clearAuthSession();
        setReady(true);
        return;
      }
      // Cold start with no Firebase user on this origin (typical for
      // dashboard.pokoin.com): adopt the sibling-host token cookie.
      const shared = readAuthToken();
      if (shared && applyInjectedDeskSession(shared)) {
        setExtensionUid(shared.uid);
        persistSession({ uid: shared.uid });
        setReady(true);
        void hydrateInjectedDeskProfile();
        return;
      }
      if (injectedDeskSession.token && injectedDeskSession.uid) {
        setExtensionUid(injectedDeskSession.uid);
        persistSession({ uid: injectedDeskSession.uid });
        setReady(true);
        return;
      }
      if (framedByChromeExtension()) {
        setReady(true);
        return;
      }
      persistRef.current = {
        uid: '',
        admin: false,
        silver: false,
        silverUntil: null,
        availablePkn: 0,
      };
      setExtensionUid('');
      setProfile(null);
      setAvailablePkn(0);
      clearAuthSession();
      setReady(true);
      return;
    }
    hadFirebaseUserRef.current = true;
    persistRef.current = {
      ...persistRef.current,
      uid: next.uid,
    };
    setProfile((current) => (current?.uid && current.uid !== next.uid ? null : current));
    persistSession({ uid: next.uid });
    setReady(true);
  }), []);

  // Keep a Domain=.pokoin.com ID-token cookie fresh so dashboard.pokoin.com
  // can call getBearer without a second Google sign-in.
  useEffect(() => onIdTokenChanged(firebaseAuth, async (next) => {
    if (!next) {
      return;
    }
    try {
      const result = await next.getIdTokenResult();
      const expiresAt = Date.parse(result.expirationTime) || (Date.now() + 55 * 60 * 1000);
      writeAuthToken({ token: result.token, uid: next.uid, expiresAt });
      injectedDeskSession = { token: result.token, uid: next.uid, expiresAt };
    } catch (_) {
      /* ignore transient token errors */
    }
  }), []);

  useEffect(() => {
    if (framedByChromeExtension()) {
      if (extensionUid && injectedDeskSession.token) {
        void hydrateInjectedDeskProfile();
      }
      return undefined;
    }
    if (!user?.uid && extensionUid && injectedDeskSession.token) {
      void hydrateInjectedDeskProfile();
      return undefined;
    }
    if (!user?.uid) {
      return undefined;
    }
    const unsubUser = onSnapshot(doc(firestore, 'users', user.uid), (snap) => {
      const next = profileFrom(snap.data() || {}, user.uid);
      setProfile(next);
      persistSession({
        uid: user.uid,
        admin: next.admin,
        silver: next.silver,
        silverUntil: next.silverUntil,
      });
    }, () => {
      const next = profileFrom({}, user.uid);
      setProfile(next);
      persistSession({
        uid: user.uid,
        admin: next.admin,
        silver: next.silver,
        silverUntil: next.silverUntil,
      });
    });
    const unsubBal = onSnapshot(doc(firestore, 'balances', user.uid), (snap) => {
      const nextPkn = Number(snap.data()?.availablePkn || 0);
      setAvailablePkn(nextPkn);
      persistSession({ uid: user.uid, availablePkn: nextPkn });
    }, () => {
      setAvailablePkn(0);
      persistSession({ uid: user.uid, availablePkn: 0 });
    });
    return () => {
      unsubUser();
      unsubBal();
    };
  }, [user?.uid, extensionUid]);

  const value = useMemo(() => ({
    user,
    ready,
    signedIn: Boolean(user) || Boolean(extensionUid) || (!ready && Boolean(hint?.signedIn)),
    sellerName: sellerNameOf(user, profile),
    profile,
    availablePkn,
    admin: Boolean(profile?.admin),
    silver: Boolean(profile?.silver),
    getBearer,
  }), [user, ready, hint, profile, availablePkn, extensionUid]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
