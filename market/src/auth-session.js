/** Last-known marketplace session. Same idea as Flutter SharedPreferences
 * `pokoin_user_profile` / `pokoin_account_balance`: paint Silver tools from
 * this browser's previous snapshot instead of waiting on Firebase. */

export const AUTH_SESSION_KEY = 'pokoin.auth.session';

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

export function readAuthSession(overrideStore) {
  const storage = store(overrideStore);
  if (!storage?.getItem) {
    return null;
  }
  try {
    const parsed = JSON.parse(storage.getItem(AUTH_SESSION_KEY) || 'null');
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
    };
  } catch (_) {
    return null;
  }
}

export function writeAuthSession(session, overrideStore) {
  const storage = store(overrideStore);
  const uid = String(session?.uid || '').trim();
  if (!storage?.setItem || !uid) {
    return;
  }
  const silverUntil = readDate(session.silverUntil);
  try {
    storage.setItem(AUTH_SESSION_KEY, JSON.stringify({
      uid,
      signedIn: true,
      admin: session.admin === true,
      silver: session.silver === true,
      silverUntil: silverUntil ? silverUntil.toISOString() : null,
      availablePkn: Number(session.availablePkn) || 0,
    }));
  } catch (_) {
    /* quota / private mode */
  }
}

export function clearAuthSession(overrideStore) {
  const storage = store(overrideStore);
  try {
    storage?.removeItem?.(AUTH_SESSION_KEY);
  } catch (_) {
    /* private mode */
  }
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
  };
}

/** Side-panel desks inject uid without a Firebase `user`. Never read user.displayName bare. */
export function accountHeading(user, profile) {
  return String(user?.displayName || user?.email || profile?.username || '').trim() || 'Collector';
}

export function accountLede(user) {
  return String(user?.email || '').trim() || 'Signed in';
}
