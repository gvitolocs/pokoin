import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSpeciesCards } from './api.js';

// PH-C030 / CARD-08: the species hub lists every single of the National Dex
// number, not only the cards named exactly after it. This runs the real
// `fetchSpeciesCards` (market/src/api.js) over a stubbed `fetch`, so "which list
// answers the hub, and what happens when it does not" is an observed request log.
// Every case asks its own dex number and name: the local-first reader caches by
// URL for the whole process, so a repeated key would answer from memory.

/** One card row of a stored list, as `react_record` writes it. */
const row = (id, name) => ({
  id: String(id),
  card_id: String(id),
  name,
  set: 'Platinum',
  rarity: 'Holo Rare',
  itemKind: 'single',
  productType: 'card',
});

const VARIANTS = ['Giratina', 'Giratina V', 'Giratina VSTAR'];

/** A stored list body: `kind=species` carries `dex`, `kind=name` carries `name`. */
const listBody = (kind, key, from, count) => ({
  [kind]: kind === 'species' ? Number(key) : String(key),
  cards: Array.from({ length: count }, (_, i) => row(from + i, kind === 'species' ? VARIANTS[i % 3] : String(key))),
});

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

/**
 * fetch stub keyed by route. `answers.list(kind)` decides what a prebuilt list
 * answers: a body, `'missing'` (the 404 of a list the job has not built) or an
 * Error (no route at all). `answers.search(page, params)` hands back the pages of
 * the live exact-name search.
 */
function stubFetch(answers) {
  const asked = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    const params = new URL(href).searchParams;
    if (href.includes('/api/marketplace-list?')) {
      const kind = params.get('kind');
      asked.push(`list:${kind}`);
      const body = answers.list?.(kind, params);
      if (body === 'missing') return response({ error: 'List not built yet.', missing: true }, 404);
      if (body instanceof Error) throw body;
      return response(body);
    }
    if (href.includes('/api/marketplace-search-page')) {
      const page = asked.filter((entry) => entry === 'search').length;
      asked.push('search');
      return response(answers.search?.(page, params) ?? { cards: [], hasMore: false });
    }
    asked.push('other');
    return response({});
  };
  return asked;
}

async function run(ask, answers) {
  const items = new Map();
  globalThis.localStorage = {
    getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
    setItem: (key, value) => items.set(String(key), String(value)),
    removeItem: (key) => items.delete(String(key)),
  };
  const original = globalThis.fetch;
  const asked = stubFetch(answers);
  try {
    return { cards: await fetchSpeciesCards(...ask), asked };
  } finally {
    globalThis.fetch = original;
    delete globalThis.localStorage;
  }
}

test('the species list answers the hub, and no exact-name read runs', async () => {
  const { cards, asked } = await run([487, { name: 'Giratina', lang: 'en' }], {
    list: (kind) => (kind === 'species' ? listBody('species', 487, 4871, 86) : 'missing'),
  });
  assert.equal(cards.length, 86, 'every single of dex 487, not the 25 named exactly "Giratina"');
  assert.deepEqual(cards.map((card) => card.id), Array.from({ length: 86 }, (_, i) => String(4871 + i)));
  assert.ok(cards.some((card) => card.name === 'Giratina VSTAR'), 'the VSTAR printings are on the hub now');
  assert.deepEqual(asked, ['list:species'], 'the name list and the live search stay untouched');
});

test('an empty species list falls back to the exact-name path', async () => {
  const { cards, asked } = await run([490, { name: 'Darkrai', lang: 'en' }], {
    list: (kind) => (kind === 'species' ? { dex: 490, cards: [] } : listBody('name', 'Darkrai', 4901, 3)),
  });
  assert.equal(cards.length, 3, 'the page keeps the cards it shows today');
  assert.deepEqual(asked, ['list:species', 'list:name']);
});

test('a species list the job has not built falls back to the live search', async () => {
  const { cards, asked } = await run([491, { name: 'Shaymin', lang: 'en' }], {
    list: () => 'missing',
    search: () => ({ cards: [row(4911, 'Shaymin'), row(4912, 'Shaymin')], hasMore: false }),
  });
  assert.deepEqual(cards.map((card) => card.id), ['4911', '4912']);
  assert.deepEqual(asked, ['list:species', 'list:name', 'search']);
});

test('a failed species read is not an empty hub', async () => {
  const { cards, asked } = await run([492, { name: 'Arceus', lang: 'en' }], {
    list: (kind) => (kind === 'species' ? new Error('origin down') : listBody('name', 'Arceus', 4921, 4)),
  });
  assert.equal(cards.length, 4, 'the exact-name rows answer instead of a rejected promise');
  assert.deepEqual(asked, ['list:species', 'list:name']);
});

test('a species wider than one page arrives whole', async () => {
  const { cards } = await run([494, { name: 'Victini', lang: 'en' }], {
    list: () => listBody('species', 494, 4941, 487),
  });
  assert.equal(cards.length, 487, 'the snapshot is the complete list, not a 96-row page');
});

test('the fallback pages until the species is complete', async () => {
  const search = (page, params) => {
    const offset = Number(params.get('offset') || '0');
    if (offset >= 192) {
      return { cards: [row(4950, 'Snorlax')], hasMore: false };
    }
    return {
      cards: Array.from({ length: 96 }, (_, i) => row(offset + i + 1, 'Snorlax')),
      hasMore: true,
    };
  };
  const { cards, asked } = await run([495, { name: 'Snorlax', lang: 'en' }], {
    list: () => 'missing',
    search,
  });
  assert.equal(asked.filter((entry) => entry === 'search').length, 3, 'it keeps paging while the route says hasMore');
  assert.equal(cards.length, 193, '192 rows of two full pages plus the short last one');
});

test('a page in another title language never asks for the species list', async () => {
  const { asked } = await run([496, { name: 'Heracross', lang: 'ja' }], {
    list: () => listBody('species', 496, 4961, 5),
    search: () => ({ cards: [row(4961, 'Heracross')], hasMore: false }),
  });
  assert.deepEqual(asked, ['search'], 'the snapshots hold English titles only');
});
