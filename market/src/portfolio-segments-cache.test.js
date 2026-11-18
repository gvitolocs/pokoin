import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forgetSegments,
  peekSegments,
  rememberSegments,
  resetSegmentsCacheForTests,
  segmentsEpoch,
  subscribeSegments,
} from './portfolio-segments-cache.js';

const DAY_MS = 86400000;
const TODAY = '2026-11-18';
const YESTERDAY = '2026-11-17';

function storageKeyFor(uid) {
  return `pokoin.portfolioSegments.v1.${uid}`;
}

/** localStorage stand-in; `values` lets a test read exactly what was stored. */
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

function answer(value = 900, defs = true) {
  return {
    ok: true,
    days: [
      { date: YESTERDAY, cardsValuePkn: value - 100, segments: { 'game:pokemon': [value - 100, 9, 30] } },
      { date: TODAY, cardsValuePkn: value, segments: { 'game:pokemon': [value, 10, 30] } },
    ],
    ...(defs ? { segmentDefs: [{ key: 'game:pokemon', group: 'game', game: 'pokemon' }] } : {}),
  };
}

test('rememberSegments keeps the normalized model and persists it per user', () => {
  globalThis.localStorage = memoryStorage();
  try {
    resetSegmentsCacheForTests();
    const model = rememberSegments('user-1', answer());
    assert.ok(model);
    assert.deepEqual(model.days.map((day) => day.date), [YESTERDAY, TODAY]);
    assert.deepEqual(model.days[1].segments['game:pokemon'], { valuePkn: 900, priced: 10, held: 30 });
    assert.equal(peekSegments('user-1'), model);

    const stored = JSON.parse(globalThis.localStorage.getItem(storageKeyFor('user-1')));
    assert.ok(Date.now() - stored.savedAt < DAY_MS, 'the copy carries its timestamp');
    assert.deepEqual(stored.model.defs, [{ key: 'game:pokemon', group: 'game', game: 'pokemon', label: '' }]);

    // Another account never sees this one's pile.
    assert.equal(peekSegments('user-2'), null);
  } finally {
    resetSegmentsCacheForTests();
    delete globalThis.localStorage;
  }
});

test('a null model stores nothing and clears nothing', () => {
  globalThis.localStorage = memoryStorage();
  try {
    resetSegmentsCacheForTests();
    const first = rememberSegments('user-1', answer());
    // An old server without segments must not blank the painted table.
    assert.equal(rememberSegments('user-1', { ok: true, days: [{ date: TODAY, cardsValuePkn: 5 }] }), null);
    assert.equal(rememberSegments('user-1', null), null);
    assert.equal(rememberSegments('user-1', 'junk'), null);
    assert.equal(peekSegments('user-1'), first);
    assert.ok(globalThis.localStorage.getItem(storageKeyFor('user-1')));
    // Nothing remembered for a signed-out uid.
    assert.equal(rememberSegments('', answer()), null);
    assert.equal(peekSegments(''), null);
    assert.equal(globalThis.localStorage.getItem(storageKeyFor('')), null);
  } finally {
    resetSegmentsCacheForTests();
    delete globalThis.localStorage;
  }
});

test('peek falls back to a stored copy that is still worth painting', () => {
  const fresh = { savedAt: Date.now() - 3 * DAY_MS, model: { defs: [{ key: 'k', group: 'game', game: 'pokemon' }], days: [{ date: TODAY, cardsValuePkn: 7, segments: { k: { valuePkn: 7, priced: 1, held: 1 } } }] } };
  globalThis.localStorage = memoryStorage({
    [storageKeyFor('fresh')]: JSON.stringify(fresh),
    [storageKeyFor('stale')]: JSON.stringify({ ...fresh, savedAt: Date.now() - 31 * DAY_MS }),
    [storageKeyFor('junk')]: '{"model":{"defs":[],"days":[]}}',
    [storageKeyFor('broken')]: 'not json',
    [storageKeyFor('foreign')]: JSON.stringify({ savedAt: Date.now(), model: { defs: [{}], days: [{ nope: 1 }] } }),
  });
  try {
    resetSegmentsCacheForTests();
    const model = peekSegments('fresh');
    assert.deepEqual(model.defs.map((def) => def.key), ['k']);
    // The stored copy is read once and then handed out as the same object.
    assert.equal(peekSegments('fresh'), model);
    assert.equal(peekSegments('stale'), null);
    assert.equal(peekSegments('junk'), null);
    assert.equal(peekSegments('broken'), null);
    assert.equal(peekSegments('foreign'), null);
    assert.equal(peekSegments(''), null);
  } finally {
    resetSegmentsCacheForTests();
    delete globalThis.localStorage;
  }
});

test('subscribers hear every later model and forget stops them', () => {
  globalThis.localStorage = memoryStorage();
  try {
    resetSegmentsCacheForTests();
    const seen = [];
    const unsubscribe = subscribeSegments('user-1', (model) => seen.push(model));
    const later = rememberSegments('user-1', answer(1200));
    assert.deepEqual(seen, [later]);
    assert.equal(peekSegments('user-1'), later);

    unsubscribe();
    rememberSegments('user-1', answer(1500));
    assert.equal(seen.length, 1, 'an unsubscribed listener stops hearing');

    // A sign-out drops both copies.
    forgetSegments('user-1');
    assert.equal(peekSegments('user-1'), null);
    assert.equal(globalThis.localStorage.getItem(storageKeyFor('user-1')), null);
    const afterForget = [];
    const again = subscribeSegments('user-1', (model) => afterForget.push(model));
    rememberSegments('user-1', answer());
    assert.deepEqual(afterForget, [peekSegments('user-1')]);
    again();
    forgetSegments('');
    forgetSegments(null);
  } finally {
    resetSegmentsCacheForTests();
    delete globalThis.localStorage;
  }
});

test('private mode keeps the session copy and never throws', () => {
  const full = memoryStorage();
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  globalThis.localStorage = full;
  try {
    resetSegmentsCacheForTests();
    const model = rememberSegments('user-1', answer());
    assert.equal(peekSegments('user-1'), model);
    assert.equal(full.values.size, 0);
    forgetSegments('user-1');
    assert.equal(peekSegments('user-1'), null);
  } finally {
    resetSegmentsCacheForTests();
    delete globalThis.localStorage;
  }

  // Some private modes throw on touching localStorage itself.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => { throw new Error('SecurityError'); },
  });
  try {
    resetSegmentsCacheForTests();
    const model = rememberSegments('blocked', answer());
    assert.equal(peekSegments('blocked'), model);
    forgetSegments('blocked');
    assert.equal(peekSegments('blocked'), null);
    const blockedListener = () => {};
    assert.equal(typeof subscribeSegments('blocked', blockedListener), 'function');
  } finally {
    resetSegmentsCacheForTests();
    delete globalThis.localStorage;
  }
});

test('an answer that crossed a sign-out is not filed under that uid', () => {
  globalThis.localStorage = memoryStorage();
  try {
    resetSegmentsCacheForTests();
    // The page reads the epoch when it starts the request and hands it to
    // `rememberSegments`; a follow-up retry reads it again, so only an answer
    // from before the sign-out is dropped.
    const epoch = segmentsEpoch('user-1');
    forgetSegments('user-1');
    assert.notEqual(segmentsEpoch('user-1'), epoch, 'signing out moves the epoch');
    assert.equal(rememberSegments('user-1', answer(), epoch), null);
    assert.equal(peekSegments('user-1'), null);
    assert.equal(globalThis.localStorage.getItem(storageKeyFor('user-1')), null);

    const fresh = segmentsEpoch('user-1');
    const model = rememberSegments('user-1', answer(1200), fresh);
    assert.ok(model, 'an answer of the current session is kept');
    assert.deepEqual(peekSegments('user-1'), model);

    // A caller that starts no request keeps writing (the preview fixture).
    assert.ok(rememberSegments('user-2', answer()));
    assert.ok(peekSegments('user-2'));
    assert.equal(segmentsEpoch(''), 0);
    assert.equal(rememberSegments('', answer(), 0), null);
  } finally {
    resetSegmentsCacheForTests();
    delete globalThis.localStorage;
  }
});
