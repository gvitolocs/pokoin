import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchExactNameCards, prefetchCardDesk } from './api.js';

// PH-C038 client point 3: `build_names` runs for `game == "pokemon"` only
// (pokoin-rust/apps/api/src/lists.rs:441), so no satellite TCG name is ever a
// `kind=name` key. A One Piece desk asked the Pokémon catalogue for the hex of
// its own title and could only be told the list is not built.
//
// The page decides which catalogue it reads (`market/src/game.js`): the desk
// URL carries the game prefix, and the scan desk's Game picker navigates to it.
// Both places therefore ask about the card of the page they are on, so this
// runs the real reads over a stubbed `window.location` and a recording `fetch`
// and compares the request log. A Pokémon page must look exactly like today.

const LIST_ROWS = (name, from, count) => Array.from(
  { length: count },
  (_, i) => ({ id: String(from + i), name, set: 'Scarlet & Violet', card_number: `${i + 1}/100` }),
);

function usePage({ hostname = 'pokoin.com', pathname = '/marketplace/en/cards/1', scanGame = '' } = {}) {
  const items = new Map(scanGame ? [['pokoin.scanGame', scanGame]] : []);
  const storage = {
    getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
    setItem: (key, value) => items.set(String(key), String(value)),
    removeItem: (key) => items.delete(String(key)),
  };
  globalThis.localStorage = storage;
  globalThis.window = {
    localStorage: storage,
    location: {
      hostname,
      pathname,
      search: '',
      hash: '',
      protocol: 'https:',
      origin: `https://${hostname}`,
      href: `https://${hostname}${pathname}`,
    },
  };
  return () => {
    delete globalThis.window;
    delete globalThis.localStorage;
  };
}

/** Every route answers 200: what a page asks is the observation here. */
function stubNetwork({ name, listId, searchId, cardId }) {
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    asked.push(href);
    const body = href.includes('/api/marketplace-list?')
      ? { cards: LIST_ROWS(name, listId, 3), hasMore: false, count: 3 }
      : href.includes('/api/marketplace-search-page')
        ? { cards: LIST_ROWS(name, searchId, 2), hasMore: false, count: 2 }
        : {
          cardId,
          card: { id: cardId, name, set: 'Scarlet & Violet', card_number: '1/100' },
          neighbors: { prev: [], next: [] },
          listings: [],
          total: 0,
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    asked,
    lists: () => asked.filter((href) => href.includes('/api/marketplace-list?')),
    nameLists: () => asked.filter((href) => href.includes('/api/marketplace-list?') && href.includes('kind=name')),
    searches: () => asked.filter((href) => href.includes('/api/marketplace-search-page')),
    pages: () => asked.filter((href) => href.includes('/api/marketplace-card-page')),
    restore: () => { globalThis.fetch = original; },
  };
}

test('a One Piece desk asks no kind=name list and takes the live search', async () => {
  const NAME = 'Monkey D. Luffy';
  const restorePage = usePage({ pathname: '/one-piece/marketplace/en/cards/900001' });
  const net = stubNetwork({ name: NAME, listId: 900100, searchId: 900200, cardId: '900001' });
  try {
    const cards = await fetchExactNameCards(NAME, { lang: 'en' });
    assert.deepEqual(net.nameLists(), [], 'no name snapshot request for a name no builder keys');
    assert.ok(net.searches().length >= 1, 'the live exact-name search answers instead');
    assert.deepEqual(cards.map((card) => card.id), ['900200', '900201'], 'the fallback rows are the result');
    assert.equal(net.lists().length, 0, 'and no list of any kind was asked for it');
  } finally {
    net.restore();
    restorePage();
  }
});

test('the One Piece desk warm asks the page and no name snapshot', async () => {
  const NAME = 'Roronoa Zoro';
  const restorePage = usePage({ pathname: '/one-piece/marketplace/en/cards/900002' });
  const net = stubNetwork({ name: NAME, listId: 900300, searchId: 900400, cardId: '900002' });
  try {
    await prefetchCardDesk({ id: '900002', name: NAME }, { names: true, art: false });
    assert.equal(net.pages().length, 1, 'the desk page is still warmed');
    assert.deepEqual(net.lists(), [], 'the name snapshot is not');
  } finally {
    net.restore();
    restorePage();
  }
});

test('a scanned One Piece batch asks no name list either', async () => {
  const NAME = 'Yonko Shanks';
  const restorePage = usePage({ pathname: '/dashboard/scan', scanGame: 'one_piece' });
  const net = stubNetwork({ name: NAME, listId: 900500, searchId: 900600, cardId: '900003' });
  try {
    const cards = await fetchExactNameCards(NAME, {});
    assert.deepEqual(net.nameLists(), [], 'the scan desk Game picker is the catalogue');
    assert.deepEqual(cards.map((card) => card.id), ['900600', '900601'], 'the scanned card still gets its printings');
  } finally {
    net.restore();
    restorePage();
  }
});

test('a Pokemon desk asks the same requests as today: the snapshot, no search', async () => {
  const NAME = 'Charizard ex';
  const restorePage = usePage({ pathname: '/marketplace/en/cards/900004' });
  const net = stubNetwork({ name: NAME, listId: 900700, searchId: 900800, cardId: '900004' });
  try {
    const cards = await fetchExactNameCards(NAME, { lang: 'en' });
    assert.equal(net.nameLists().length, 1, 'the one name read the desk makes today');
    assert.match(net.nameLists()[0], /kind=name&key=/);
    assert.deepEqual(net.searches(), [], 'the snapshot answers, so no search goes out');
    assert.deepEqual(cards.map((card) => card.id), ['900700', '900701', '900702']);
  } finally {
    net.restore();
    restorePage();
  }
});

test('a Pokemon desk warm still warms the name snapshot', async () => {
  const NAME = 'Blastoise ex';
  const restorePage = usePage({ pathname: '/marketplace/en/cards/900005' });
  const net = stubNetwork({ name: NAME, listId: 900900, searchId: 901000, cardId: '900005' });
  try {
    await prefetchCardDesk({ id: '900005', name: NAME }, { names: true, art: false });
    assert.equal(net.pages().length, 1);
    assert.equal(net.nameLists().length, 1, 'the warm keeps the copy the next desk reads back');
  } finally {
    net.restore();
    restorePage();
  }
});
