import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSellerSnapshot, listSnapshotPath, sellerSnapshotKey } from './api.js';
import { localStorable } from './local-read.js';
import { sellerFreshAction, sellerFromPayload } from './seller-shop.js';

const BOOK = {
  book: true,
  maxUpdatedAt: '2026-10-14T10:00:00.000Z',
  seller: { uid: 'u1', username: 'redshakkio', displayName: 'Red Shakkio', photoUrl: 'https://x.test/p.png', country: 'it' },
  listings: [{ id: 'l1', cardId: '10', pricePkn: 4, quantityAvailable: 2 }],
  unique: 1,
  copies: 2,
};

/** fetch stub: every request is recorded; `answer(url)` returns [status, body]. */
function stubFetch(answer) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const [status, body] = answer(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return asked;
}

test('a seller snapshot key is the lowercase handle, and only list-key characters', () => {
  assert.equal(sellerSnapshotKey(' @RedShakkio '), 'redshakkio');
  assert.equal(sellerSnapshotKey('e2e'), 'e2e');
  assert.equal(sellerSnapshotKey('Raffaella Sabatino'), '');
  assert.equal(sellerSnapshotKey(''), '');
  assert.equal(sellerSnapshotKey('x'.repeat(65)), '');
  // The snapshot is a list snapshot: the local store keeps it.
  assert.ok(localStorable(`https://api.pokoin.com${listSnapshotPath('seller', 'redshakkio')}`));
});

test('the snapshot is one c1v2 list read; a handle with no key asks nothing', async () => {
  const asked = stubFetch(() => [200, BOOK]);
  assert.deepEqual(await fetchSellerSnapshot('@SnapA'), BOOK);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /\/api\/marketplace-list\?kind=seller&key=snapa&format=c1v2$/);
  assert.equal(await fetchSellerSnapshot('No Key Here'), null);
  assert.equal(asked.length, 1);
});

test('no snapshot (404) or a body that is not a book reads as null', async () => {
  stubFetch((url) => (url.includes('key=snapb') ? [404, { error: 'List not built yet.', missing: true }] : [200, { cards: [] }]));
  assert.equal(await fetchSellerSnapshot('snapb'), null);
  assert.equal(await fetchSellerSnapshot('snapc'), null);
});

test('a version names a newer stored book: a URL the edge has not cached, read past the store', async () => {
  const asked = stubFetch(() => [200, BOOK]);
  await fetchSellerSnapshot('snapd');
  await fetchSellerSnapshot('snapd', { version: 'abc123' });
  assert.equal(asked.length, 2);
  assert.match(asked[1], /kind=seller&key=snapd&format=c1v2&v=abc123$/);
});

test('fresh=1 decides: current, read the newer stored book, or wait for it', () => {
  const book = { maxUpdatedAt: 'T1' };
  assert.equal(sellerFreshAction(book, { maxUpdatedAt: 'T1', book: { stamp: 'T1', version: 'v1' } }), 'current');
  assert.equal(sellerFreshAction(book, { maxUpdatedAt: 'T2', book: { stamp: 'T2', version: 'v2' } }), 'refetch');
  assert.equal(sellerFreshAction(book, { maxUpdatedAt: 'T3', book: { stamp: 'T2', version: 'v2' } }), 'refetch', 'newer than ours, even if not the newest');
  assert.equal(sellerFreshAction(book, { maxUpdatedAt: 'T2', book: { stamp: 'T1', version: 'v1' } }), 'wait');
  assert.equal(sellerFreshAction(book, { maxUpdatedAt: 'T2', book: null }), 'wait', 'no stored book: the live route');
  assert.equal(sellerFreshAction(book, null), 'current', 'an unanswered check changes nothing');
  assert.equal(sellerFreshAction(book, { maxUpdatedAt: '' }), 'current');
});

test('the shop header keeps the snapshot country and photo', () => {
  const seller = sellerFromPayload(BOOK, 'redshakkio', BOOK.listings[0]);
  assert.equal(seller.country, 'IT');
  assert.equal(seller.photoUrl, 'https://x.test/p.png');
  assert.equal(seller.displayName, 'Red Shakkio');
  assert.equal(sellerFromPayload({ seller: {} }, 'x', {}, seller).country, 'IT', 'a later payload without it keeps it');
});
