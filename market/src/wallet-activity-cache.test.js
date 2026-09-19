import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITY_CACHE_PREFIX,
  activityCacheIsFresh,
  activityCacheStorageKey,
  activityFingerprint,
  activityNewestMs,
  activityRowsSince,
  readActivityCache,
  reviveActivityRows,
  serializeActivityRows,
  writeActivityCache,
} from './wallet-activity-cache.js';

function memoryStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

test('serialize / revive round-trips Date and amount', () => {
  const at = new Date('2026-09-19T12:00:00.000Z');
  const rows = serializeActivityRows([
    { key: 'ledger:1', title: 'Sent 5 PKN', detail: '', kind: 'outbound', amountPkn: -5, at },
  ]);
  assert.equal(rows[0].at, '2026-09-19T12:00:00.000Z');
  const revived = reviveActivityRows(rows);
  assert.equal(revived[0].at.toISOString(), at.toISOString());
  assert.equal(revived[0].amountPkn, -5);
});

test('fingerprint is stable for the same feed and changes when a row is added', () => {
  const a = [{ key: 'a', title: 'x', amountPkn: 1, at: new Date('2026-09-01T00:00:00Z') }];
  const b = [...a, { key: 'b', title: 'y', amountPkn: 2, at: new Date('2026-09-02T00:00:00Z') }];
  assert.equal(activityFingerprint(a), activityFingerprint(serializeActivityRows(a)));
  assert.notEqual(activityFingerprint(a), activityFingerprint(b));
});

test('localStorage cache read/write and freshness', () => {
  globalThis.localStorage = memoryStore();
  const uid = 'user-1';
  const rows = [
    { key: 'a', title: 'Top up', kind: 'inbound', amountPkn: 10, at: new Date('2026-05-21T10:00:00Z') },
  ];
  assert.equal(activityCacheStorageKey(uid, ''), `${ACTIVITY_CACHE_PREFIX}:user-1:site`);
  assert.equal(writeActivityCache(uid, '', rows), true);
  const cached = readActivityCache(uid, '');
  assert.equal(cached.rows[0].title, 'Top up');
  assert.equal(cached.rows[0].at.toISOString(), '2026-05-21T10:00:00.000Z');
  assert.equal(activityCacheIsFresh(cached, { now: cached.fetchedAt + 1_000 }), true);
  assert.equal(activityCacheIsFresh(cached, { now: cached.fetchedAt + 60_000 }), false);
  delete globalThis.localStorage;
});

test('newest ms and since filter pick only newer rows', () => {
  const rows = [
    { key: 'old', at: new Date('2026-05-17T00:00:00Z') },
    { key: 'new', at: new Date('2026-05-21T00:00:00Z') },
  ];
  assert.equal(activityNewestMs(rows), Date.parse('2026-05-21T00:00:00Z'));
  assert.deepEqual(
    activityRowsSince(rows, Date.parse('2026-05-17T00:00:00Z')).map((r) => r.key),
    ['new'],
  );
});
