import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSpeciesCards } from './api.js';

// PH-C030 / CARD-08: the species hub lists every single of the National Dex
// number, not only the cards named exactly after it. This runs the real
// `fetchSpeciesCards` (market/src/api.js) over a stubbed `fetch`, so "which list
// answers the hub, and what happens when it does not" is an observed request log.
// Every case asks its own dex number and name: the local-first reader caches by
// URL for the whole process, so a repeated key would answer from memory.
//
// The hub is the UNION of the species list and the exact-name result: a species
// snapshot is only as fresh as the last nightly build, so a stale or partial one
// must never leave the page showing fewer cards than the old path showed.

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

/** The three printings a species list cycles through: the plain name plus the
 *  V / VSTAR titles an exact-name read drops (the CARD-08 gap). */
const SUFFIXES = ['', 'V', 'VSTAR'];

const speciesRows = (title, from, count) => Array.from(
  { length: count },
  (_, i) => row(from + i, `${title} ${SUFFIXES[i % 3]}`.trim()),
);

/** Rows of a `name` list: every one of them named exactly `title`. */
const nameRows = (title, from, count) => Array.from(
  { length: count },
  (_, i) => row(from + i, title),
);

/** A stored list body: `kind=species` carries `dex`, `kind=name` carries `name`. */
const listBody = (kind, key, cards) => ({
  [kind === 'species' ? 'dex' : 'name']: kind === 'species' ? Number(key) : String(key),
  cards,
});

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

/**
 * fetch stub keyed by route. `answers.list(kind)` decides what a prebuilt list
 * answers: a body, `'missing'` (the 404 of a list the job has not built) or an
 * Error (no route at all). `answers.search(page, params)` hands back the pages of
 * the live exact-name search, or an Error when that route is down.
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
      const body = answers.search?.(page, params);
      if (body instanceof Error) throw body;
      return response(body ?? { cards: [], hasMore: false });
    }
    asked.push('other');
    return response({});
  };
  return asked;
}

/** The routes asked, ignoring the order the two parallel reads were logged in. */
const askedSet = (asked) => [...new Set(asked)].sort();

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

test('the species list and the exact-name result union into one list', async () => {
  const { cards, asked } = await run([487, { name: 'Giratina', lang: 'en' }], {
    list: (kind) => (kind === 'species'
      ? listBody('species', 487, speciesRows('Giratina', 4871, 86))
      : listBody('name', 'Giratina', nameRows('Giratina', 4871, 25))),
  });
  assert.equal(cards.length, 86, 'every single of dex 487, not the 25 named exactly "Giratina"');
  assert.deepEqual(cards.map((card) => card.id), Array.from({ length: 86 }, (_, i) => String(4871 + i)));
  assert.ok(cards.some((card) => card.name === 'Giratina VSTAR'), 'the VSTAR printings are on the hub now');
  assert.equal(new Set(cards.map((card) => card.id)).size, 86, 'a card the two lists share appears once');
  assert.deepEqual(askedSet(asked), ['list:name', 'list:species'], 'both reads run, at the same time');
});

test('a partial species list never hides the exact-name result', async () => {
  // The review's sequence: the 487 snapshot is stale (one row) while the name
  // snapshot has since been rebuilt with 25. The hub must show the 25.
  const { cards } = await run([505, { name: 'Mamoswine', lang: 'en' }], {
    list: (kind) => (kind === 'species'
      ? listBody('species', 505, speciesRows('Mamoswine', 5051, 1))
      : listBody('name', 'Mamoswine', nameRows('Mamoswine', 5051, 25))),
  });
  assert.equal(cards.length, 25, 'the one species row is already among them');
  assert.equal(cards[0].id, '5051', 'species rows come first');
});

test('a single the species list cannot hold still shows on the hub', async () => {
  // A card named exactly after the species whose dex column is 0 or the trainer
  // sentinel is never in a species list; the name result carries it.
  const { cards } = await run([506, { name: 'Togekiss', lang: 'en' }], {
    list: (kind) => (kind === 'species'
      ? listBody('species', 506, speciesRows('Togekiss', 5101, 1))
      : listBody('name', 'Togekiss', nameRows('Togekiss', 5201, 25))),
  });
  assert.equal(cards.length, 26, 'the species row plus the 25 exact-name rows');
  assert.deepEqual(cards.map((card) => card.id)[0], '5101', 'species rows first, then the name rows');
  assert.equal(new Set(cards.map((card) => card.id)).size, 26, 'no id twice');
});

test('an empty species list leaves the exact-name rows', async () => {
  const { cards, asked } = await run([490, { name: 'Darkrai', lang: 'en' }], {
    list: (kind) => (kind === 'species' ? { dex: 490, cards: [] } : listBody('name', 'Darkrai', nameRows('Darkrai', 4901, 3))),
  });
  assert.equal(cards.length, 3, 'the page keeps the cards it shows today');
  assert.deepEqual(askedSet(asked), ['list:name', 'list:species']);
});

test('a species list the job has not built leaves the live search', async () => {
  const { cards, asked } = await run([491, { name: 'Shaymin', lang: 'en' }], {
    list: () => 'missing',
    search: () => ({ cards: [row(4911, 'Shaymin'), row(4912, 'Shaymin')], hasMore: false }),
  });
  assert.deepEqual(cards.map((card) => card.id), ['4911', '4912']);
  assert.deepEqual(askedSet(asked), ['list:name', 'list:species', 'search']);
});

test('a failed species read is not an empty hub', async () => {
  const { cards, asked } = await run([492, { name: 'Arceus', lang: 'en' }], {
    list: (kind) => (kind === 'species' ? new Error('origin down') : listBody('name', 'Arceus', nameRows('Arceus', 4921, 4))),
  });
  assert.equal(cards.length, 4, 'the exact-name rows answer instead of a rejected promise');
  assert.deepEqual(askedSet(asked), ['list:name', 'list:species']);
});

test('a failing exact-name read leaves the species rows', async () => {
  const { cards, asked } = await run([497, { name: 'Dialga', lang: 'en' }], {
    list: (kind) => (kind === 'species'
      ? listBody('species', 497, speciesRows('Dialga', 4971, 40))
      : 'missing'),
    search: () => new Error('search-page down'),
  });
  assert.equal(cards.length, 40, 'one read failing never empties the hub');
  assert.deepEqual(askedSet(asked), ['list:name', 'list:species', 'search']);
});

test('both reads failing rejects, as the name read alone does today', async () => {
  const ask = run([498, { name: 'Palkia', lang: 'en' }], {
    list: () => 'missing',
    search: () => new Error('search-page down'),
  });
  await assert.rejects(ask, 'the page shows the error the old path showed');
});

test('a species wider than one page arrives whole', async () => {
  const { cards } = await run([494, { name: 'Victini', lang: 'en' }], {
    list: (kind) => (kind === 'species'
      ? listBody('species', 494, speciesRows('Victini', 4941, 487))
      : 'missing'),
    search: () => ({ cards: [], hasMore: false }),
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
    list: () => listBody('species', 496, speciesRows('Heracross', 4961, 5)),
    search: () => ({ cards: [row(4961, 'Heracross')], hasMore: false }),
  });
  assert.deepEqual(askedSet(asked), ['search'], 'the snapshots hold English titles only');
});
