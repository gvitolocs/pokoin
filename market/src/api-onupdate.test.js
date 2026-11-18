import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// api.js imports browser-only modules; run the real fetchCard / fetchArtist
// bodies with injected I/O (same approach as api-c1.test.js).
const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');

function slice(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} is present`);
  return source.slice(start, end).replace(/^export function/, 'function');
}

const cardSource = slice('export function fetchCard(', '\nexport function fetchVersionSet(');
const artistSource = slice('export function fetchArtist(', '\n/** Artist index');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function cardReader({ fresh = () => true } = {}) {
  const reads = [];
  const accepted = [];
  const deps = {
    cardCacheKey: (id, lang) => `${lang}:${id}`,
    getJson: async () => assert.fail('offers are not read here'),
    assertCardPageIdentity: () => {},
    game: () => ({ id: 'pokemon' }),
    hasNeighborArrows: () => false,
    rememberNeighbors: () => {},
    cardCache: new Map(),
    cachedFresh: () => true,
    cardInflight: new Map(),
    localUrl: (path) => `https://api.pokoin.com${path}`,
    getJsonLocal: (path, options) => {
      const read = { path, options, ...deferred() };
      reads.push(read);
      return read.promise;
    },
    staleLimit: ({ onUpdate, prefetch } = {}) => (onUpdate || prefetch ? 'MAX_STALE_MS' : 'FRESH_MS'),
    acceptCardPage: (id, data, { persist }) => {
      accepted.push(persist);
      return data;
    },
    markStored: (value) => value,
    localReader: { fresh },
  };
  const fetchCard = new Function(...Object.keys(deps), `${cardSource}\nreturn fetchCard;`)(...Object.values(deps));
  return { fetchCard, reads, accepted };
}

test('a desk read that takes updates does not wait on the route preload in flight, nor is it adopted', async () => {
  const { fetchCard, reads } = cardReader();
  const preload = fetchCard('7', { lang: 'en' });
  const desk = fetchCard('7', { lang: 'en', onUpdate: () => {} });
  assert.equal(reads.length, 2, 'the desk asks local-read itself (it joins the request there)');
  assert.equal(reads[0].options.maxStaleMs, 'FRESH_MS');
  assert.equal(reads[1].options.maxStaleMs, 'MAX_STALE_MS');
  // A later plain read adopts the plain one, never the desk's (it may be an old copy).
  const later = fetchCard('7', { lang: 'en' });
  assert.equal(reads.length, 2);
  reads[1].resolve({ card: { id: '7' }, from: 'store' });
  reads[0].resolve({ card: { id: '7' }, from: 'network' });
  assert.equal((await desk).from, 'store');
  assert.equal((await preload).from, 'network');
  assert.equal((await later).from, 'network');
});

test('a fresh desk read with onUpdate is still the read others adopt', async () => {
  const { fetchCard, reads } = cardReader();
  const desk = fetchCard('7', { lang: 'en', fresh: true, onUpdate: () => {} });
  const other = fetchCard('7', { lang: 'en' });
  assert.equal(reads.length, 1);
  reads[0].resolve({ card: { id: '7' } });
  assert.equal(await other, await desk);
});

test('only a copy fresh from the network goes to the localStorage desk cache', async () => {
  let isFresh = false;
  const { fetchCard, reads, accepted } = cardReader({ fresh: () => isFresh });
  const stored = fetchCard('7', { lang: 'en', onUpdate: () => {} });
  reads[0].resolve({ card: { id: '7' } });
  await stored;
  isFresh = true;
  const network = fetchCard('8', { lang: 'en' });
  reads[1].resolve({ card: { id: '8' } });
  await network;
  const prefetch = fetchCard('9', { lang: 'en', prefetch: true });
  reads[2].resolve({ card: { id: '9' } });
  await prefetch;
  assert.deepEqual(accepted, [false, true, false]);
});

test('an artist read that takes updates neither adopts nor is adopted by a plain one', async () => {
  const snapshots = [];
  const deps = {
    artistPageKey: (slug, limit) => `${slug}:${limit}`,
    artistPageCache: new Map(),
    cachedFresh: () => true,
    artistPageInflight: new Map(),
    cardFromCatalogRow: (row) => row,
    fetchListSnapshot: (kind, key, options) => {
      const read = { options, ...deferred() };
      snapshots.push(read);
      return read.promise;
    },
    staleLimit: ({ onUpdate, prefetch } = {}) => (onUpdate || prefetch ? 'MAX_STALE_MS' : 'FRESH_MS'),
    markStored: (value) => value,
    localUrl: (path) => path,
    listSnapshotPath: (kind, key) => `/api/marketplace-list?kind=${kind}&key=${key}`,
    getJsonC1: async () => assert.fail('the snapshot answers'),
  };
  const fetchArtist = new Function(...Object.keys(deps), `${artistSource}\nreturn fetchArtist;`)(...Object.values(deps));
  const plain = fetchArtist('arita', { limit: 5000 });
  const desk = fetchArtist('arita', { limit: 5000, onUpdate: () => {} });
  const later = fetchArtist('arita', { limit: 5000 });
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].options.maxStaleMs, 'MAX_STALE_MS');
  snapshots[0].resolve({ cards: [{ id: '1' }, { id: '2' }] });
  snapshots[1].resolve({ cards: [{ id: '1' }] });
  assert.equal((await desk).cards.length, 1);
  assert.equal((await later), await plain);
});
