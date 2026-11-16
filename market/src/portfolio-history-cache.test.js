import assert from 'node:assert/strict';
import test from 'node:test';
import { addUtcDays, utcDayKey } from './portfolio-history.js';
import {
  clearPortfolioHistory,
  loadPortfolioHistory,
  peekPortfolioHistory,
  resetPortfolioHistoryCacheForTests,
  subscribePortfolioHistory,
} from './portfolio-history-cache.js';

const TODAY = utcDayKey();
const YESTERDAY = addUtcDays(TODAY, -1);
const TWO_DAYS_AGO = addUtcDays(TODAY, -2);
const DAY_MS = 86400000;

function storageKeyFor(uid) {
  return `pokoin.portfolioHistory.v1.${uid}`;
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

/** The follow-up timers, fired by hand. */
function fakeTimers() {
  const pending = new Map();
  let seq = 0;
  return {
    pending,
    delays: () => [...pending.values()].map((row) => row.ms),
    setTimeout: (fn, ms) => {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq;
    },
    clearTimeout: (id) => { pending.delete(id); },
    /** Run the next scheduled follow-up and wait for its answer to land. */
    async fire() {
      const next = pending.entries().next().value;
      if (!next) throw new Error('no follow-up is scheduled');
      const [id, row] = next;
      pending.delete(id);
      row.fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return row.ms;
    },
  };
}

test('dashboard and nav share one normalized history request per user', async () => {
  resetPortfolioHistoryCacheForTests();
  let calls = 0;
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const fetcher = () => {
    calls += 1;
    return response;
  };

  const dashboard = loadPortfolioHistory('user-1', fetcher);
  const preview = loadPortfolioHistory('user-1', fetcher);
  release({ days: [
    { date: '2026-09-25', currencyPkn: 15, cardsKnown: true, cardsValuePkn: 2001981 },
    { date: '2026-09-26', currencyPkn: 15, cardsKnown: false },
  ] });

  const [dashboardDays, previewDays] = await Promise.all([dashboard, preview]);
  assert.equal(calls, 1);
  assert.equal(dashboardDays, previewDays);
  assert.equal(previewDays.at(-1).totalPkn, 15);
  assert.equal(peekPortfolioHistory('user-1'), dashboardDays);

  const again = await loadPortfolioHistory('user-1', fetcher);
  assert.equal(calls, 1);
  assert.equal(again, dashboardDays);
});

test('history cache is scoped by user', async () => {
  resetPortfolioHistoryCacheForTests();
  await loadPortfolioHistory('one', async () => ({ days: [{ date: '2026-09-26', currencyPkn: 1 }] }));
  await loadPortfolioHistory('two', async () => ({ days: [{ date: '2026-09-26', currencyPkn: 2 }] }));
  assert.equal(peekPortfolioHistory('one').at(-1).totalPkn, 1);
  assert.equal(peekPortfolioHistory('two').at(-1).totalPkn, 2);
});

test('a reload peeks the persisted series at once, then fetches its one copy', async () => {
  const store = memoryStorage();
  globalThis.localStorage = store;
  try {
    resetPortfolioHistoryCacheForTests();
    const timers = fakeTimers();
    await loadPortfolioHistory('owner', async () => ({
      days: [
        { date: TWO_DAYS_AGO, currencyPkn: 40, cardsValuePkn: 600, cardsKnown: true, cardsHeld: 12 },
        { date: YESTERDAY, currencyPkn: 42 },
      ],
    }), timers);
    const saved = JSON.parse(store.values.get(storageKeyFor('owner')));
    assert.ok(Number(saved.savedAt) > 0);
    assert.equal(saved.days.length, 2);

    // A reload: memory is gone, the stored copy is what the graph paints.
    resetPortfolioHistoryCacheForTests();
    const peeked = peekPortfolioHistory('owner');
    assert.equal(peeked[0].date, TWO_DAYS_AGO);
    assert.equal(peeked[0].totalPkn, 640);
    assert.equal(peeked[0].assets.cardsValuePkn, 600);
    assert.equal(peeked[0].assets.cardsKnown, true);
    assert.equal(peeked.at(-1).totalPkn, 42);

    // The stored copy does not count as fetched, and the answer replaces it.
    let calls = 0;
    await loadPortfolioHistory('owner', async () => {
      calls += 1;
      return { days: [{ date: TODAY, currencyPkn: 55 }] };
    }, fakeTimers());
    assert.equal(calls, 1);
    assert.equal(peekPortfolioHistory('owner').at(-1).totalPkn, 55);
    assert.equal(JSON.parse(store.values.get(storageKeyFor('owner'))).days.at(-1).totalPkn, 55);
  } finally {
    delete globalThis.localStorage;
  }
});

test('blocked storage falls back to memory only', async () => {
  globalThis.localStorage = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  try {
    resetPortfolioHistoryCacheForTests();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return { days: [{ date: YESTERDAY, currencyPkn: 7 }] };
    };
    await loadPortfolioHistory('private', fetcher, fakeTimers());
    assert.equal(peekPortfolioHistory('private').at(-1).totalPkn, 7);
    resetPortfolioHistoryCacheForTests();
    assert.equal(peekPortfolioHistory('private'), null, 'nothing reached storage');
    await loadPortfolioHistory('private', fetcher, fakeTimers());
    assert.equal(calls, 2, 'memory-only still means one request per SPA lifetime');
  } finally {
    delete globalThis.localStorage;
  }

  // Some private modes throw on touching localStorage itself.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => { throw new Error('SecurityError'); },
  });
  try {
    resetPortfolioHistoryCacheForTests();
    await loadPortfolioHistory('blocked', async () => ({ days: [{ date: YESTERDAY, currencyPkn: 3 }] }), fakeTimers());
    assert.equal(peekPortfolioHistory('blocked').at(-1).totalPkn, 3);
    resetPortfolioHistoryCacheForTests();
    assert.equal(peekPortfolioHistory('blocked'), null);
    clearPortfolioHistory('blocked');
  } finally {
    delete globalThis.localStorage;
  }
});

test('a copy older than 30 days or not a day series is ignored', () => {
  globalThis.localStorage = memoryStorage({
    [storageKeyFor('old')]: JSON.stringify({
      savedAt: Date.now() - 31 * DAY_MS, days: [{ date: '2026-01-04', totalPkn: 9 }],
    }),
    [storageKeyFor('kept')]: JSON.stringify({
      savedAt: Date.now() - 29 * DAY_MS, days: [{ date: YESTERDAY, totalPkn: 9, assets: { currencyPkn: 9 } }],
    }),
    [storageKeyFor('text')]: JSON.stringify({ savedAt: Date.now(), days: 'not-a-series' }),
    [storageKeyFor('rows')]: JSON.stringify({ savedAt: Date.now(), days: [{ totalPkn: 5 }] }),
    [storageKeyFor('none')]: JSON.stringify({ days: [] }),
    [storageKeyFor('broken')]: '{ not json',
  });
  try {
    resetPortfolioHistoryCacheForTests();
    assert.equal(peekPortfolioHistory('old'), null);
    assert.equal(peekPortfolioHistory('text'), null);
    assert.equal(peekPortfolioHistory('rows'), null);
    assert.equal(peekPortfolioHistory('none'), null);
    assert.equal(peekPortfolioHistory('broken'), null);
    assert.equal(peekPortfolioHistory('kept').at(-1).totalPkn, 9);
  } finally {
    delete globalThis.localStorage;
  }
});

test('a stale answer is re-fetched twice at most, then stops', async () => {
  resetPortfolioHistoryCacheForTests();
  const timers = fakeTimers();
  let calls = 0;
  await loadPortfolioHistory('lagging', async () => {
    calls += 1;
    return { days: [{ date: TWO_DAYS_AGO, currencyPkn: 10 }, { date: YESTERDAY, currencyPkn: 11 }] };
  }, timers);
  assert.equal(calls, 1);
  assert.deepEqual(timers.delays(), [5000]);
  assert.equal(await timers.fire(), 5000);
  assert.equal(calls, 2);
  assert.deepEqual(timers.delays(), [10000]);
  assert.equal(await timers.fire(), 10000);
  assert.equal(calls, 3);
  assert.deepEqual(timers.delays(), [], 'two quiet follow-ups at most');

  await loadPortfolioHistory('lagging', async () => { calls += 1; return { days: [] }; }, timers);
  assert.equal(calls, 3, 'the memory copy answers, so no new chain starts');
});

test('the follow-ups stop as soon as the answer reaches today', async () => {
  resetPortfolioHistoryCacheForTests();
  const timers = fakeTimers();
  let round = 0;
  const heard = [];
  const unsubscribe = subscribePortfolioHistory('later', (rows) => heard.push(rows));
  await loadPortfolioHistory('later', async () => {
    round += 1;
    return round === 1
      ? { days: [{ date: TWO_DAYS_AGO, currencyPkn: 20 }, { date: YESTERDAY, currencyPkn: 21 }] }
      : { days: [{ date: TWO_DAYS_AGO, currencyPkn: 20 }, { date: TODAY, currencyPkn: 26 }] };
  }, timers);
  assert.equal(heard.length, 0, 'the first answer came through the awaited load');
  assert.equal(await timers.fire(), 5000);
  assert.deepEqual(heard.map((rows) => rows.at(-1).totalPkn), [26]);
  assert.equal(peekPortfolioHistory('later').at(-1).totalPkn, 26);
  assert.deepEqual(timers.delays(), [], 'today is painted, so no third request');
  unsubscribe();
});

test('an update reaches only that uid, and nothing after unsubscribing', async () => {
  resetPortfolioHistoryCacheForTests();
  const stale = (value) => async () => ({ days: [{ date: YESTERDAY, currencyPkn: value }] });
  const timersA = fakeTimers();
  const timersB = fakeTimers();
  const heardA = [];
  const heardB = [];
  await loadPortfolioHistory('a', stale(1), timersA);
  await loadPortfolioHistory('b', stale(2), timersB);
  const offA = subscribePortfolioHistory('a', (rows) => heardA.push(rows));
  subscribePortfolioHistory('b', (rows) => heardB.push(rows));
  await timersA.fire();
  assert.deepEqual(heardA.map((rows) => rows.at(-1).totalPkn), [1]);
  assert.deepEqual(heardB, [], "another owner's series never crosses over");
  offA();
  await timersB.fire();
  assert.deepEqual(heardB.map((rows) => rows.at(-1).totalPkn), [2]);
  assert.equal(heardA.length, 1, 'no listener fires after cleanup');
  resetPortfolioHistoryCacheForTests();
});

test('clearPortfolioHistory drops both copies and any follow-up', async () => {
  const store = memoryStorage();
  globalThis.localStorage = store;
  try {
    resetPortfolioHistoryCacheForTests();
    const timers = fakeTimers();
    await loadPortfolioHistory('leaver', async () => ({ days: [{ date: YESTERDAY, currencyPkn: 7 }] }), timers);
    assert.equal(store.values.has(storageKeyFor('leaver')), true);
    assert.equal(timers.pending.size, 1);
    clearPortfolioHistory('leaver');
    assert.equal(peekPortfolioHistory('leaver'), null);
    assert.equal(store.values.has(storageKeyFor('leaver')), false);
    assert.equal(timers.pending.size, 0, 'the quiet follow-up goes with it');

    // An answer already in flight must not come back after sign-out.
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const inflight = loadPortfolioHistory('late', () => pending, timers);
    clearPortfolioHistory('late');
    release({ days: [{ date: YESTERDAY, currencyPkn: 3 }] });
    assert.equal((await inflight).at(-1).totalPkn, 3, 'the awaiting view still gets its answer');
    assert.equal(peekPortfolioHistory('late'), null);
    assert.equal(store.values.has(storageKeyFor('late')), false);
  } finally {
    delete globalThis.localStorage;
  }
});

test('a persisted copy belongs to one uid only', async () => {
  const store = memoryStorage();
  globalThis.localStorage = store;
  try {
    resetPortfolioHistoryCacheForTests();
    const timers = fakeTimers();
    await loadPortfolioHistory('alice', async () => ({ days: [{ date: YESTERDAY, currencyPkn: 3 }] }), timers);
    await loadPortfolioHistory('bob', async () => ({ days: [{ date: YESTERDAY, currencyPkn: 4 }] }), timers);
    assert.equal(store.values.has(storageKeyFor('alice')), true);
    assert.equal(store.values.has(storageKeyFor('bob')), true);
    clearPortfolioHistory('alice');
    resetPortfolioHistoryCacheForTests();
    assert.equal(peekPortfolioHistory('alice'), null);
    assert.equal(peekPortfolioHistory('bob').at(-1).totalPkn, 4);
    assert.equal(peekPortfolioHistory('carol'), null);
    assert.equal(peekPortfolioHistory(''), null);
  } finally {
    delete globalThis.localStorage;
  }
});

