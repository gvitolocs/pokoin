import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { C1_DICTIONARY, C1Error, decodeC1, isC1 } from './compact.js';
import { localStorable } from './local-read.js';

// api.js imports browser-only modules; run its actual c1 reader and local
// router with injected I/O.
const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');

function slice(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} is present`);
  return source.slice(start, end).replace(/^export (async )?function/, (m, a) => `${a || ''}function`);
}

const readerSource = slice('export async function getJsonC1(', '\nfunction isViteDev()');
const localSource = slice('function getJsonLocal(', '\n/** Run `fn(value)`');

function reader(getJsonLocal, enabled = true) {
  return new Function('getJsonLocal', 'C1Error', 'C1_READS', `${readerSource}\nreturn getJsonC1;`)(getJsonLocal, C1Error, enabled);
}

function localRouter({ getJson, read, refresh = async () => false }) {
  const deps = {
    publicApiUrl: (path) => `https://api.pokoin.com${path}`,
    withGameQuery: (path) => path,
    localUrl: (path) => `https://api.pokoin.com${path}`,
    localStorable,
    getJson,
    isC1,
    decodeC1,
    c1Dictionary: C1_DICTIONARY,
    localReader: { read },
    C1Error,
    refreshC1Dictionary: refresh,
  };
  return new Function(...Object.keys(deps), `${localSource}\nreturn getJsonLocal;`)(...Object.values(deps));
}

const C1_DOC = { c1: 1, b: { cards: [{ id: '7' }], total: 1 } };

test('c1 reads are on, and a reader with them off asks for plain JSON', async () => {
  assert.match(source, /const C1_READS = true;/);
  const asked = [];
  const getJsonC1 = reader(async (path) => {
    asked.push(path);
    return { ok: true };
  }, false);
  await getJsonC1('/api/marketplace-search-page?q=mew');
  assert.deepEqual(asked, ['/api/marketplace-search-page?q=mew']);
});

test('getJsonC1 asks for format=c1 and passes the options through', async () => {
  const asked = [];
  const getJsonC1 = reader(async (path, options) => {
    asked.push([path, options.signal]);
    return { cards: [{ id: '7' }], total: 1 };
  });
  assert.deepEqual(await getJsonC1('/api/marketplace-search-page?q=mew', { signal: 'sig' }), { cards: [{ id: '7' }], total: 1 });
  assert.deepEqual(asked, [['/api/marketplace-search-page?q=mew&format=c1', 'sig']]);
  await getJsonC1('/api/marketplace-expansion-page');
  assert.equal(asked[1][0], '/api/marketplace-expansion-page?format=c1');
});

test('getJsonC1 reads the route again as JSON when the document cannot be decoded', async () => {
  for (const failure of [new C1Error('dictionary games has no code 9999'), new TypeError('bad column')]) {
    const asked = [];
    const getJsonC1 = reader(async (path) => {
      asked.push(path);
      if (path.includes('format=c1')) throw failure;
      return { ok: true };
    });
    assert.deepEqual(await getJsonC1('/api/marketplace-artist-cards?slug=x'), { ok: true });
    assert.deepEqual(asked, ['/api/marketplace-artist-cards?slug=x&format=c1', '/api/marketplace-artist-cards?slug=x']);
  }
});

test('getJsonC1 lets request failures surface like getJson', async () => {
  const asked = [];
  const getJsonC1 = reader(async (path) => {
    asked.push(path);
    throw Object.assign(new Error('nope'), { status: 404 });
  });
  await assert.rejects(getJsonC1('/api/marketplace-expansion-page?slug=missing'), { status: 404 });
  assert.equal(asked.length, 1);
});

test('a c1 answer from a route that is not stored still decodes to the default JSON', async () => {
  const getJsonLocal = localRouter({
    getJson: async () => C1_DOC,
    read: () => assert.fail('search pages are never stored'),
  });
  assert.deepEqual(await getJsonLocal('/api/marketplace-search-page?query=mew&format=c1'), { cards: [{ id: '7' }], total: 1 });
  const plain = { cards: [] };
  const passthrough = localRouter({ getJson: async () => plain, read: () => assert.fail('not stored') });
  assert.equal(await passthrough('/api/marketplace-suggest?q=m&format=c1'), plain);
});

test('stored routes go through the local reader; personal or option-bearing reads never do', async () => {
  const reads = [];
  const gets = [];
  const getJsonLocal = localRouter({
    getJson: async (path) => { gets.push(path); return {}; },
    read: async (url, options) => { reads.push([url, options.prefetch]); return { ok: true }; },
  });
  await getJsonLocal('/api/marketplace-list?kind=set&key=x&format=c1v2', { prefetch: true });
  await getJsonLocal('/api/marketplace-card-page?cardId=1&lang=en');
  await getJsonLocal('/api/marketplace-card-page?cardId=1&includeOffers=1');
  await getJsonLocal('/api/marketplace-listings?cardId=1');
  await getJsonLocal('/api/marketplace-version-set?cardId=1', { headers: { Authorization: 'Bearer x' } });
  assert.deepEqual(reads, [
    ['https://api.pokoin.com/api/marketplace-list?kind=set&key=x&format=c1v2', true],
    ['https://api.pokoin.com/api/marketplace-card-page?cardId=1&lang=en', undefined],
  ]);
  assert.deepEqual(gets, [
    '/api/marketplace-card-page?cardId=1&includeOffers=1',
    '/api/marketplace-listings?cardId=1',
    '/api/marketplace-version-set?cardId=1',
  ]);
});

test('a stored read that hits an unknown dictionary code retries fresh once a newer dictionary is adopted', async () => {
  const reads = [];
  const getJsonLocal = localRouter({
    getJson: async () => assert.fail('stored route'),
    read: async (url, options) => {
      reads.push(options.fresh === true);
      if (reads.length === 1) throw new C1Error('dictionary games has no code 99');
      return { ok: true };
    },
    refresh: async () => true,
  });
  assert.deepEqual(await getJsonLocal('/api/marketplace-list?kind=set&key=x&format=c1v2'), { ok: true });
  assert.deepEqual(reads, [false, true]);
});
