import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTH_SESSION_KEY,
  AUTH_TOKEN_COOKIE,
  accountHeading,
  accountLede,
  authCookieDomain,
  clearAuthSession,
  clearAuthToken,
  profileFromSession,
  readAuthSession,
  readAuthToken,
  writeAuthSession,
  writeAuthToken,
} from './auth-session.js';

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.hasOwn(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

test('auth session round-trips silver so Best Deal can paint logged-in', () => {
  const store = memoryStore();
  writeAuthSession({
    uid: 'user-1',
    silver: true,
    admin: false,
    silverUntil: new Date('2030-01-15T00:00:00Z'),
    availablePkn: 1200,
  }, store);
  const cached = readAuthSession(store);
  assert.equal(cached.uid, 'user-1');
  assert.equal(cached.signedIn, true);
  assert.equal(cached.silver, true);
  assert.equal(cached.availablePkn, 1200);
  assert.equal(profileFromSession(cached).silver, true);
  assert.equal(store.getItem(AUTH_SESSION_KEY).includes('user-1'), true);
});

test('expired silverUntil does not keep CT/CM/VT unlocked', () => {
  const store = memoryStore();
  writeAuthSession({
    uid: 'user-1',
    silver: false,
    silverUntil: new Date('2020-01-01T00:00:00Z'),
    availablePkn: 0,
  }, store);
  const cached = readAuthSession(store);
  assert.equal(cached.silver, false);
  assert.equal(cached.silverUntil, null);
});

test('sign-out clears the paint hint', () => {
  const store = memoryStore();
  writeAuthSession({ uid: 'user-1', silver: true }, store);
  clearAuthSession(store);
  assert.equal(readAuthSession(store), null);
});

test('unsigned or empty blobs do not count as signed in', () => {
  assert.equal(readAuthSession(memoryStore()), null);
  assert.equal(readAuthSession(memoryStore({
    [AUTH_SESSION_KEY]: JSON.stringify({ signedIn: true, uid: '' }),
  })), null);
  assert.equal(readAuthSession(memoryStore({
    [AUTH_SESSION_KEY]: 'not-json',
  })), null);
});

test('account heading survives a side-panel session with no Firebase user', () => {
  assert.equal(accountHeading(null, { username: 'giuseppe' }), 'giuseppe');
  assert.equal(accountHeading(null, { uid: 'x' }), 'Collector');
  assert.equal(accountHeading({ displayName: 'Giuseppe', email: 'a@b.c' }, null), 'Giuseppe');
  assert.equal(accountHeading({ displayName: 'vitologiuseeppe17', email: 'a@b.c' }, { displayName: 'Giuseppe' }), 'Giuseppe');
  assert.equal(accountLede(null), 'Signed in');
  assert.equal(accountLede({ email: 'a@b.c' }), 'a@b.c');
});


test('auth cookie domain is shared across pokoin.com hosts', () => {
  assert.equal(authCookieDomain('pokoin.com'), '.pokoin.com');
  assert.equal(authCookieDomain('dashboard.pokoin.com'), '.pokoin.com');
  assert.equal(authCookieDomain('www.pokoin.com'), '.pokoin.com');
  assert.equal(authCookieDomain('localhost'), '');
  assert.equal(authCookieDomain('evilpokoin.com'), '');
});

function cookieDoc(initial = '') {
  let cookie = initial;
  return {
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      const [pair] = String(value).split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const raw = pair.slice(at + 1);
      const parts = cookie ? cookie.split('; ') : [];
      const next = parts.filter((row) => !row.startsWith(`${name}=`));
      if (!String(value).includes('Max-Age=0')) {
        next.push(`${name}=${raw}`);
      }
      cookie = next.join('; ');
    },
  };
}

test('ID token cookie is host-only on pokoin.com', () => {
  const writes = [];
  const jar = {
    get cookie() {
      return '';
    },
    set cookie(value) {
      writes.push(String(value));
    },
  };
  const previous = globalThis.location;
  globalThis.location = { hostname: 'pokoin.com', protocol: 'https:' };
  try {
    writeAuthToken({
      token: 'x'.repeat(40),
      uid: 'user-9',
      expiresAt: Date.now() + 60 * 60 * 1000,
    }, jar);
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
  assert.equal(writes.length, 1);
  assert.equal(writes[0].includes('Domain='), false);
  assert.match(writes[0], /Secure/);
});

test('ID token cookie round-trips for sibling-host handoff', () => {
  const jar = cookieDoc();
  writeAuthToken({
    token: 'x'.repeat(40),
    uid: 'user-9',
    expiresAt: Date.now() + 60 * 60 * 1000,
  }, jar);
  const cached = readAuthToken(jar);
  assert.equal(cached.uid, 'user-9');
  assert.equal(cached.token.length, 40);
  assert.equal(jar.cookie.includes(AUTH_TOKEN_COOKIE), true);
  clearAuthToken(jar);
  assert.equal(readAuthToken(jar), null);
});

test('expired ID token cookie is ignored', () => {
  const jar = cookieDoc();
  writeAuthToken({
    token: 'y'.repeat(40),
    uid: 'user-9',
    expiresAt: Date.now() - 1000,
  }, jar);
  // Max-Age becomes 60s minimum in writeAuthToken when expiresAt is in the past
  // — force an expired payload directly.
  jar.cookie = `${AUTH_TOKEN_COOKIE}=${encodeURIComponent(JSON.stringify({
    token: 'y'.repeat(40),
    uid: 'user-9',
    expiresAt: Date.now() - 1000,
  }))}`;
  assert.equal(readAuthToken(jar), null);
});

test('writeAuthSession also mirrors into the shared cookie jar', () => {
  const store = memoryStore();
  const jar = cookieDoc();
  // Combine: storage for localStorage API, cookie via jar — pass jar with getItem?
  // writeAuthSession uses store(override) for localStorage and cookieJar(override)
  // which only uses override when it has a `cookie` property. Use jar alone and
  // skip localStorage by making jar also look like storage? Simpler: dual object.
  const dual = {
    ...jar,
    getItem: store.getItem.bind(store),
    setItem: store.setItem.bind(store),
    removeItem: store.removeItem.bind(store),
  };
  writeAuthSession({ uid: 'user-2', silver: true, availablePkn: 5 }, dual);
  assert.equal(readAuthSession(dual).uid, 'user-2');
  assert.equal(dual.cookie.includes('user-2'), true);
});
