import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  clearListingsInflight,
  invalidateListings,
  listingsAgeMs,
  listingsFetchEpoch,
  listingsInflightFor,
  peekListings,
  rememberListings,
  resetListingsCacheForTests,
  setListingsInflight,
} from './listings-cache.js';

// The desk's mount read is the real fetchListings body (market/src/api.js) over
// the real listings cache, with only getJson and the clock injected — the same
// seam as api-onupdate.test.js. CARD-01 P2 asks what that read puts on the wire
// for a card the previous desk already warmed, so the answer must be a URL.
const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const start = source.indexOf('export function fetchListings(');
const end = source.indexOf('\nexport function createListing(', start);
assert.ok(start >= 0 && end > start, 'fetchListings is present in api.js');
const fetchListings = new Function(
  'getJson',
  'peekListings',
  'rememberListings',
  'listingsAgeMs',
  'listingsFetchEpoch',
  'listingsInflightFor',
  'setListingsInflight',
  'clearListingsInflight',
  'Date',
  `${source.slice(start, end).replace(/^export function/, 'function')}
   return fetchListings;`,
)(
  getJson,
  peekListings,
  rememberListings,
  // The real age of the real cache entry, read on the fake clock: fetchListings
  // passes no `now`, so the clock is the only thing this test bends.
  (id) => listingsAgeMs(id, REAL_NOW() + clockOffset),
  listingsFetchEpoch,
  listingsInflightFor,
  setListingsInflight,
  clearListingsInflight,
  FakeDate,
);

const REAL_NOW = Date.now;
let clockOffset = 0;
const asked = [];
let answer = { listings: [{ id: 'live', pricePkn: 40 }] };

function FakeDate() {}
FakeDate.now = () => REAL_NOW() + clockOffset;

async function getJson(path, options = {}) {
  asked.push({ path, options });
  return answer;
}

/** Warm the card the way the hover / intent prefetch does: no `fresh`, no `_=`. */
function warm(cardId, rows) {
  resetListingsCacheForTests();
  asked.length = 0;
  clockOffset = 0;
  rememberListings(cardId, { listings: rows }, listingsFetchEpoch(cardId));
}

const WINDOW_MS = 120_000;

test('a desk mount adopts a listings warm two minutes old and asks nothing', async () => {
  warm('813624', []);
  clockOffset = 110_000;
  const list = await fetchListings('813624', { fresh: true, maxAgeMs: WINDOW_MS });
  assert.deepEqual(list.listings, [], 'the warm copy is the first frame');
  assert.deepEqual(asked, [], 'no marketplace-listings request for a card warmed a moment ago');
});

test('past the window the desk re-reads, and the empty answer is not mistaken for none', async () => {
  warm('813624', []);
  clockOffset = 130_000;
  const list = await fetchListings('813624', { fresh: true, maxAgeMs: WINDOW_MS });
  assert.equal(asked.length, 1);
  assert.match(asked[0].path, /^\/api\/marketplace-listings\?cardId=813624&nativeOnly=1&limit=40&_=\d+$/);
  assert.deepEqual(list, answer, 'the re-read is what the cell reconciles to');
});

test('a ten-second-old warm is inside the window the mount read uses', () => {
  warm('813624', []);
  assert.ok(listingsAgeMs('813624', REAL_NOW() + 10_000) <= WINDOW_MS);
  assert.ok(listingsAgeMs('813624', REAL_NOW() + 130_000) > WINDOW_MS, 'stale is stale');
  assert.equal(listingsAgeMs('999999'), Infinity, 'nothing cached never adopts');
});

test('the visitor own listing change re-reads with no window at all', async () => {
  warm('813624', [{ id: 'mine', pricePkn: 10 }]);
  clockOffset = 1_000;
  invalidateListings('813624');
  const list = await fetchListings('813624', { fresh: true, maxAgeMs: 0 });
  assert.equal(asked.length, 1, 'onListed is a forced re-read');
  assert.match(asked[0].path, /&_=/, 'and it bypasses the edge cache');
  assert.deepEqual(list, answer);
});

test('a listings read already in flight is joined, not duplicated', async () => {
  warm('813624', []);
  clockOffset = 130_000;
  const pending = Promise.resolve({ listings: [{ id: 'inflight' }] });
  setListingsInflight('813624', pending);
  const list = await fetchListings('813624', { fresh: true, maxAgeMs: WINDOW_MS });
  assert.deepEqual(list, { listings: [{ id: 'inflight' }] });
  assert.deepEqual(asked, [], 'the warm that is still running is the fresh read');
  clearListingsInflight('813624');
  assert.equal(peekListings('813624').listings.length, 0);
});
