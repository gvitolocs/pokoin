import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOME_BROWSE_BLOCK,
  createEnglishBrowseState,
  fillEnglishBrowse,
  westernCatalogExpansions,
} from './home-browse.js';

const keepOrder = () => 0.999;

function cardsFor(slug, count, start = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${slug}-${start + index}`,
    name: `${slug} ${start + index}`,
    nationality: 'western',
  }));
}

function pager(bySlug) {
  return async ({ slug, offset, limit }) => {
    const all = bySlug[slug] || [];
    const cards = all.slice(offset, offset + limit);
    return { cards, hasMore: offset + cards.length < all.length };
  };
}

test('home browse keeps western expansions and drops JP/CN/product', () => {
  const rows = westernCatalogExpansions([
    { slug: '151', nationality: 'western' },
    { slug: 'sv1a', nationality: 'japanese' },
    { slug: 'c', nationality: 'chinese' },
    { slug: 'box', nationality: 'product' },
    { slug: '', nationality: 'western' },
  ]);
  assert.deepEqual(rows.map((row) => row.slug), ['151']);
});

test('home browse serves 14-card blocks then more from the next English set', async () => {
  const expansions = [
    { slug: 'a', name: 'A', nationality: 'western' },
    { slug: 'b', name: 'B', nationality: 'western' },
  ];
  const state = createEnglishBrowseState(expansions, keepOrder);
  const fetchExpansionPage = pager({
    a: cardsFor('a', 20),
    b: cardsFor('b', 20),
  });
  const first = await fillEnglishBrowse(state, { fetchExpansionPage, random: keepOrder });
  assert.equal(first.cards.length, HOME_BROWSE_BLOCK);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.cards.map((card) => card.id), cardsFor('a', 14).map((card) => card.id));

  const second = await fillEnglishBrowse(state, { fetchExpansionPage, random: keepOrder });
  assert.equal(second.cards.length, HOME_BROWSE_BLOCK);
  assert.deepEqual(
    second.cards.map((card) => card.id),
    [...cardsFor('a', 6, 15), ...cardsFor('b', 8)].map((card) => card.id),
  );
  assert.equal(second.hasMore, true);
});

test('home browse skips merch backpacks without collector numbers', async () => {
  const state = createEnglishBrowseState(
    [{ slug: 'league', name: 'League Promos', nationality: 'western' }],
    keepOrder,
  );
  const first = await fillEnglishBrowse(state, {
    fetchExpansionPage: pager({
      league: [
        { id: '1', name: 'Accelgor', number: '012/101', nationality: 'western' },
        {
          id: '2',
          name: 'International Championship 2024 | Pokémon Center Backpack',
          number: 'Europe',
          nationality: 'western',
        },
        { id: '3', name: "Nemona's Backpack", number: '083/091', nationality: 'western' },
      ],
    }),
    random: keepOrder,
  });
  assert.deepEqual(first.cards.map((card) => card.id), ['1', '3']);
});

test('home browse stops when western sets run out', async () => {
  const state = createEnglishBrowseState(
    [{ slug: 'tiny', name: 'Tiny', nationality: 'western' }],
    keepOrder,
  );
  const first = await fillEnglishBrowse(state, {
    fetchExpansionPage: pager({ tiny: cardsFor('tiny', 5) }),
    random: keepOrder,
  });
  assert.equal(first.cards.length, 5);
  assert.equal(first.hasMore, false);
});
