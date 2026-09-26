/** Last-known marketplace session. Same idea as Flutter SharedPreferences
 * `pokoin_user_profile` / `pokoin_account_balance`: paint Silver tools from
 * this browser's previous snapshot instead of waiting on Firebase.
 *
 * Firebase Auth persistence is origin-scoped. The paint hint is a
 * Domain=.pokoin.com cookie. The ID token stays host-only so a script on
 * another Pokoin host cannot read it. */

import { safeAvatarUrl } from './avatar.js';

export const AUTH_SESSION_KEY = 'pokoin.auth.session';
export const AUTH_TOKEN_COOKIE = 'pokoin.auth.token';
export const AUTH_SESSION_COOKIE = 'pokoin.auth.session.cookie';

function store(override) {
  if (override) {
    return override;
  }
  try {
    return globalThis.localStorage;
  } catch (_) {
    return null;
  }
}

function readDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Cookie Domain for shared Pokoin hosts. Empty = host-only (localhost). */
export function authCookieDomain(hostname = '') {
  const host = String(hostname || '').toLowerCase();
  if (host === 'pokoin.com' || host.endsWith('.pokoin.com')) {
    return '.pokoin.com';
  }
  return '';
}

function cookieJar(override) {
  if (override && typeof override === 'object' && 'cookie' in override) {
    return override;
  }
  try {
    return globalThis.document || null;
  } catch (_) {
    return null;
  }
}

function readCookie(name, jar) {
  const raw = String(jar?.cookie || '');
  if (!raw) return null;
  const parts = raw.split(';');
  for (const part of parts) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim());
    } catch (_) {
      return part.slice(at + 1).trim();
    }
  }
  return null;
}

function writeCookie(name, value, { maxAgeSec = 60 * 60, jar, hostname, shared = true } = {}) {
  const doc = cookieJar(jar);
  if (!doc || typeof doc !== 'object') return;
  const domain = shared
    ? authCookieDomain(hostname || (typeof location !== 'undefined' ? location.hostname : ''))
    : '';
  const encoded = encodeURIComponent(String(value || ''));
  let cookie = `${name}=${encoded}; Path=/; Max-Age=${Math.max(0, Number(maxAgeSec) || 0)}; SameSite=Lax`;
  if (typeof location !== 'undefined' && location.protocol === 'https:') {
    cookie += '; Secure';
  }
  if (domain) {
    cookie += `; Domain=${domain}`;
  }
  try {
    doc.cookie = cookie;
  } catch (_) {
    /* private mode */
  }
}

function clearCookie(name, { jar, hostname, shared = true } = {}) {
  writeCookie(name, '', { maxAgeSec: 0, jar, hostname, shared });
}

export function readAuthSession(overrideStore) {
  const storage = store(overrideStore);
  let raw = null;
  if (storage?.getItem) {
    try {
      raw = storage.getItem(AUTH_SESSION_KEY);
    } catch (_) {
      raw = null;
    }
  }
  if (!raw) {
    raw = readCookie(AUTH_SESSION_COOKIE, cookieJar(overrideStore));
  }
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const uid = String(parsed?.uid || '').trim();
    if (!parsed || parsed.signedIn !== true || !uid) {
      return null;
    }
    const silverUntil = readDate(parsed.silverUntil);
    const untilLive = Boolean(silverUntil && silverUntil.getTime() > Date.now());
    const admin = parsed.admin === true;
    const silver = admin || parsed.silver === true || untilLive;
    return {
      uid,
      signedIn: true,
      admin,
      silver,
      silverUntil: untilLive ? silverUntil : null,
      availablePkn: Number(parsed.availablePkn) || 0,
      photoUrl: safeAvatarUrl(parsed.photoUrl),
    };
  } catch (_) {
    return null;
  }
}

export function writeAuthSession(session, overrideStore) {
  const storage = store(overrideStore);
  const uid = String(session?.uid || '').trim();
  if (!uid) {
    return;
  }
  const silverUntil = readDate(session.silverUntil);
  const payload = JSON.stringify({
    uid,
    signedIn: true,
    admin: session.admin === true,
    silver: session.silver === true,
    silverUntil: silverUntil ? silverUntil.toISOString() : null,
    availablePkn: Number(session.availablePkn) || 0,
    photoUrl: safeAvatarUrl(session.photoUrl),
  });
  if (storage?.setItem) {
    try {
      storage.setItem(AUTH_SESSION_KEY, payload);
    } catch (_) {
      /* quota / private mode */
    }
  }
  writeCookie(AUTH_SESSION_COOKIE, payload, {
    maxAgeSec: 60 * 60 * 24 * 30,
    jar: cookieJar(overrideStore),
  });
}

export function clearAuthSession(overrideStore) {
  const storage = store(overrideStore);
  try {
    storage?.removeItem?.(AUTH_SESSION_KEY);
  } catch (_) {
    /* private mode */
  }
  clearCookie(AUTH_SESSION_COOKIE, { jar: cookieJar(overrideStore) });
  clearAuthToken(overrideStore);
}

/** Live Firebase ID token mirrored for sibling Pokoin hosts. */
export function readAuthToken(overrideStore) {
  const raw = readCookie(AUTH_TOKEN_COOKIE, cookieJar(overrideStore));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const token = String(parsed?.token || '').trim();
    const uid = String(parsed?.uid || '').trim();
    const expiresAt = Number(parsed?.expiresAt) || 0;
    if (token.length <= 20 || !uid) return null;
    if (expiresAt && expiresAt <= Date.now() + 30 * 1000) return null;
    return { token, uid, expiresAt };
  } catch (_) {
    return null;
  }
}

export function writeAuthToken(session, overrideStore) {
  const token = String(session?.token || '').trim();
  const uid = String(session?.uid || '').trim();
  const expiresAt = Number(session?.expiresAt) || 0;
  if (token.length <= 20 || !uid) return;
  const maxAgeSec = expiresAt > Date.now()
    ? Math.max(60, Math.floor((expiresAt - Date.now()) / 1000))
    : 55 * 60;
  writeCookie(AUTH_TOKEN_COOKIE, JSON.stringify({ token, uid, expiresAt }), {
    maxAgeSec,
    jar: cookieJar(overrideStore),
    shared: false,
  });
}

export function clearAuthToken(overrideStore) {
  const jar = cookieJar(overrideStore);
  clearCookie(AUTH_TOKEN_COOKIE, { jar, shared: false });
  clearCookie(AUTH_TOKEN_COOKIE, { jar, shared: true });
}

export function profileFromSession(session) {
  if (!session?.uid) {
    return null;
  }
  return {
    uid: session.uid,
    username: '',
    role: session.admin ? 'admin' : session.silver ? 'silver' : '',
    admin: Boolean(session.admin),
    silver: Boolean(session.silver),
    silverUntil: session.silverUntil || null,
    photoUrl: safeAvatarUrl(session.photoUrl),
  };
}


/** Public/listing seller label. Prefer real displayName, then username — never email. */
export function sellerNameOf(user, profile) {
  const stored = String(profile?.displayName || '').trim();
  if (stored && !stored.includes('@')) return stored;
  const display = String(user?.displayName || '').trim();
  if (display && !display.includes('@')) {
    return display;
  }
  const username = String(profile?.username || '').trim().replace(/^@/, '');
  if (username && !username.includes('@')) {
    return username;
  }
  return 'Pokoin seller';
}

/** Side-panel desks inject uid without a Firebase `user`. Never read user.displayName bare. */
export function accountHeading(user, profile) {
  const stored = String(profile?.displayName || '').trim();
  if (stored) return stored;
  return String(user?.displayName || user?.email || profile?.username || '').trim() || 'Collector';
}

export function accountLede(user) {
  return String(user?.email || '').trim() || 'Signed in';
}
