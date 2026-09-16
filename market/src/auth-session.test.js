import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTH_SESSION_KEY,
  accountHeading,
  accountLede,
  clearAuthSession,
  profileFromSession,
  readAuthSession,
  writeAuthSession,
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
  assert.equal(accountLede(null), 'Signed in');
  assert.equal(accountLede({ email: 'a@b.c' }), 'a@b.c');
});
