import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeC1, isC1 } from './compact.js';

// api.js imports browser-only modules; run its actual c1 reader with injected I/O.
const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function getJsonC1(');
const end = source.indexOf('\nfunction isViteDev()', start);
assert.ok(start >= 0 && end > start, 'the c1 reader is present');
const readerSource = source.slice(start, end).replace('export async function', 'async function');

function reader(getJson, decode = decodeC1, enabled = true) {
  return new Function('getJson', 'isC1', 'decodeC1', 'C1_READS', `${readerSource}\nreturn getJsonC1;`)(getJson, isC1, decode, enabled);
}

test('c1 reads stay off until the edge compresses them', async () => {
  assert.match(source, /const C1_READS = false;/);
  const asked = [];
  const getJsonC1 = reader(async (path) => {
    asked.push(path);
    return { cards: [] };
  }, () => assert.fail('nothing to decode'), false);
  assert.deepEqual(await getJsonC1('/api/marketplace-search-page?q=mew'), { cards: [] });
  assert.deepEqual(asked, ['/api/marketplace-search-page?q=mew']);
});

test('getJsonC1 asks for format=c1 and returns the decoded default JSON', async () => {
  const asked = [];
  const getJsonC1 = reader(async (path, options) => {
    asked.push([path, options.signal]);
    return { c1: 1, b: { cards: [{ id: '7' }], total: 1 } };
  });
  assert.deepEqual(await getJsonC1('/api/marketplace-search-page?q=mew', { signal: 'sig' }), { cards: [{ id: '7' }], total: 1 });
  assert.deepEqual(asked, [['/api/marketplace-search-page?q=mew&format=c1', 'sig']]);
  assert.equal((await reader(async (path) => ({ c1: 1, b: path }))('/api/marketplace-expansion-page')),
    '/api/marketplace-expansion-page?format=c1');
});

test('getJsonC1 passes a plain JSON answer through untouched', async () => {
  const plain = { cards: [{ id: '1' }], hasMore: false };
  const getJsonC1 = reader(async () => plain, () => assert.fail('plain JSON must not be decoded'));
  assert.equal(await getJsonC1('/api/marketplace-expansion-page?slug=x'), plain);
});

test('getJsonC1 reads the route again as JSON when the document cannot be decoded', async () => {
  const asked = [];
  const getJsonC1 = reader(async (path) => {
    asked.push(path);
    // A code from a dictionary newer than this build: decodeC1 throws.
    return path.includes('format=c1') ? { c1: 1, t: [{ n: 1, k: ['game'], c: [['d', 'games', [9999]]] }], b: { $c1: 0 } } : { ok: true };
  });
  assert.deepEqual(await getJsonC1('/api/marketplace-artist-cards?slug=x'), { ok: true });
  assert.deepEqual(asked, ['/api/marketplace-artist-cards?slug=x&format=c1', '/api/marketplace-artist-cards?slug=x']);
});

test('getJsonC1 lets request failures surface like getJson', async () => {
  const getJsonC1 = reader(async () => {
    throw Object.assign(new Error('nope'), { status: 404 });
  });
  await assert.rejects(getJsonC1('/api/marketplace-expansion-page?slug=missing'), { status: 404 });
});
