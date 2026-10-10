import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createExpansionCardsFetcher } from './expansion-cards.js';

// api.js also imports the browser's JSX auth module. Execute its actual
// adapter with injected I/O instead of importing those unrelated dependencies.
const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const start = source.indexOf('export function fetchExpansion(');
const end = source.indexOf('export const fetchExpansionCards', start);
assert.ok(start >= 0 && end > start, 'the expansion adapter is present');
const adapterSource = source.slice(start, end).replace('export function', 'function');

function expansionAdapter(getJson, fetchExpansionFromLists = async () => null, fetchListSnapshot = async () => null) {
  const dependencies = {
    fetchListSnapshot,
    expansionCache: new Map(),
    expansionInflight: new Map(),
    expansionCacheKey: (identity) => JSON.stringify(identity),
    fetchExpansionFromLists,
    getJson,
    // The adapter reads its pages through the c1 reader; same payloads here.
    getJsonC1: getJson,
    mapExpansionCards: (payload) => payload && { ...payload, cards: payload.cards || [] },
    overlayCatalogTilePrices: async (cards) => cards,
    mergeExpansionPayload: (_, page) => page,
  };
  return new Function(...Object.keys(dependencies), `${adapterSource}\nreturn fetchExpansion;`)(
    ...Object.values(dependencies),
  );
}

test('the real expansion adapter completes sets with an exact multiple of the page size', async () => {
  for (const count of [48, 96]) {
    const offsets = [];
    let complete = false;
    const fetchPage = expansionAdapter(async (path) => {
      const params = new URL(path, 'https://example.test').searchParams;
      const offset = Number(params.get('offset'));
      const limit = Number(params.get('limit'));
      offsets.push(offset);
      return {
        cards: Array.from({ length: Math.min(limit, Math.max(0, count - offset)) }, (_, index) => ({
          id: String(offset + index + 1), name: 'Mewtwo',
        })),
        expansion: { name: 'Example', cardCount: count },
        hasMore: false,
      };
    });
    const fetchCards = createExpansionCardsFetcher({
      fetchPage,
      rememberComplete: (_, data) => { complete = true; return data; },
    });
    const result = await fetchCards({ slug: `example-${count}` });
    assert.equal(result.cards.length, count);
    assert.equal(result.hasMore, false);
    assert.equal(complete, true);
    assert.deepEqual(offsets, count === 48 ? [0, 48] : [0, 48, 96]);
  }
});

test('the expansion adapter rejects absent or malformed later-page payloads', async () => {
  for (const payload of [null, {}, { error: 'unavailable' }, { cards: null }]) {
    const fetchPage = expansionAdapter(async () => payload);
    await assert.rejects(fetchPage({ slug: 'example', offset: 48 }), /Expansion failed/);
  }
});

test('an empty rail cannot turn a failed SQL page into a complete catalog', async () => {
  const fetchPage = expansionAdapter(
    async () => { throw new Error('network failed'); },
    async () => ({ cards: [] }),
  );
  await assert.rejects(fetchPage({ slug: 'example', offset: 48 }), /Expansion failed/);
});

test('an empty first page still rejects an unknown set', async () => {
  const fetchPage = expansionAdapter(async () => ({ cards: [] }));
  await assert.rejects(fetchPage({ slug: 'unknown-set' }), /Expansion failed/);
});

test('a built set snapshot is the whole set and skips the live routes', async () => {
  const live = [];
  const fetchPage = expansionAdapter(
    async (path) => { live.push(path); return { cards: [] }; },
    async () => null,
    async (kind, key) => (kind === 'set' && key === 'storm-emeralda'
      ? { cards: Array.from({ length: 113 }, (_, i) => ({ id: String(i + 1) })), expansion: { name: 'Storm Emeralda' }, hasMore: false }
      : null),
  );
  const data = await fetchPage({ slug: 'storm-emeralda', limit: 400, offset: 0 });
  assert.equal(data.cards.length, 113);
  assert.equal(data.hasMore, false);
  assert.equal(data.fromSnapshot, true);
  assert.deepEqual(live, []);
});
