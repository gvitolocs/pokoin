import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { C1Error } from './compact.js';

// api.js imports browser-only modules; run its actual c1 reader with injected I/O.
const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function getJsonC1(');
const end = source.indexOf('\nfunction isViteDev()', start);
assert.ok(start >= 0 && end > start, 'the c1 reader is present');
const readerSource = source.slice(start, end).replace('export async function', 'async function');
const routes = source.match(/const C1_READS = new Set\(\[([^\]]*)\]\)/);
assert.ok(routes, 'C1_READS lists its routes');
const C1_READS = new Set([...routes[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]));

function reader(getJsonLocal) {
  return new Function('getJsonLocal', 'C1Error', 'C1_READS', `${readerSource}\nreturn getJsonC1;`)(getJsonLocal, C1Error, C1_READS);
}

test('c1 is read only on the routes where it measured smaller after brotli', () => {
  assert.deepEqual([...C1_READS].sort(), [
    'marketplace-artist-cards',
    'marketplace-card-versions',
    'marketplace-expansion-page',
    'marketplace-search-page',
  ]);
});

test('other routes keep plain JSON', async () => {
  const asked = [];
  const getJsonC1 = reader(async (path) => {
    asked.push(path);
    return { ok: true };
  });
  await getJsonC1('/api/marketplace-version-set?cardId=1');
  await getJsonC1('/api/marketplace-card-page?cardId=1&lang=en');
  assert.deepEqual(asked, ['/api/marketplace-version-set?cardId=1', '/api/marketplace-card-page?cardId=1&lang=en']);
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

test('a c1 document still decodes to exactly the default JSON (decoder contract)', async () => {
  const { decodeC1, isC1 } = await import('./compact.js');
  const doc = { c1: 1, b: { cards: [{ id: '7' }], total: 1 } };
  assert.equal(isC1(doc), true);
  assert.deepEqual(decodeC1(doc), { cards: [{ id: '7' }], total: 1 });
});
