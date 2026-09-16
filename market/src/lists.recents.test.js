import assert from 'node:assert/strict';
import test from 'node:test';
import { attachRecentsToHome, isPublicRailsVector, FEATURED_LIMIT, NEW_CARDS_LIMIT, sliceExpansionRail } from './lists.js';

test('New cards rail keeps twenty curated ids', () => {
  assert.equal(NEW_CARDS_LIMIT, 20);
});

test('Featured rail keeps thirty 30th Anniversary ids', () => {
  assert.equal(FEATURED_LIMIT, 30);
});

test('SPA accepts Pi rails and rejects Flutter hydrate', () => {
  assert.equal(
    isPublicRailsVector({
      source: 'pi',
      sections: { newArrivalIds: ['1'], featuredIds: ['2'], bestSellerIds: ['3'] },
    }),
    true,
  );
  assert.equal(
    isPublicRailsVector({
      cards: new Array(120).fill({ id: '1' }),
      sections: { recentlySeenIds: ['1'], bestSellerIds: ['2'], featuredIds: ['3'] },
    }),
    false,
  );
  assert.equal(
    isPublicRailsVector({
      sections: { newArrivalIds: ['1'], featuredIds: [], bestSellerIds: [], spotlightIds: ['1'] },
    }),
    false,
  );
});

test('attachRecentsToHome is sync and does not drop public rails while recents are missing', () => {
  const payload = {
    cards: [{ id: '1', name: 'Lucario', price: 10 }],
    sections: { newArrivalIds: ['1'] },
  };
  const next = attachRecentsToHome(payload, ['1', '99']);
  assert.deepEqual(next.sections.recentlySeenIds, ['1']);
  assert.deepEqual(next.missingRecentIds, ['99']);
  assert.equal(next.cards.some((card) => card.id === '1'), true);
});

test('extra tiles fill recents without another network hop in attach', () => {
  const payload = { cards: [{ id: '1', name: 'Lucario' }], sections: {} };
  const next = attachRecentsToHome(payload, ['2'], [{ id: '2', name: 'Dawn', price: 3450 }]);
  assert.deepEqual(next.sections.recentlySeenIds, ['2']);
  assert.deepEqual(next.missingRecentIds, []);
  assert.equal(next.cards.find((card) => card.id === '2').name, 'Dawn');
});

test('cached recents paint without the public rails vector', () => {
  const next = attachRecentsToHome(
    { cards: [], sections: {} },
    ['504094', '790994'],
    [{ id: '504094', name: 'Victini', price: 13318 }],
  );
  assert.deepEqual(next.sections.recentlySeenIds, ['504094']);
  assert.deepEqual(next.missingRecentIds, ['790994']);
  assert.equal(next.sections.newArrivalIds, undefined);
});

test('999 recents collapse onto leftover × 2 and keep the snapshot price', () => {
  const payload = { cards: [{ id: '1', name: 'Lucario', price: 10 }], sections: {} };
  const next = attachRecentsToHome(
    payload,
    ['999806370', '806370'],
    [{
      id: '999806370',
      name: "Zinnia's Trust",
      price: 1810,
      canonicalPath: '/marketplace/en/cards/999806370/card-zinnia-s-trust-ultra-rare-102-076-storm-emeralda',
    }],
  );
  assert.deepEqual(next.sections.recentlySeenIds, ['806370']);
  assert.deepEqual(next.missingRecentIds, []);
  const zinnia = next.cards.find((card) => card.id === '806370');
  assert.equal(zinnia.name, "Zinnia's Trust");
  assert.equal(zinnia.price, 1810);
  assert.equal(
    zinnia.canonicalPath,
    '/marketplace/en/cards/806370/card-zinnia-s-trust-ultra-rare-102-076-storm-emeralda',
  );
});

test('nameless extra recents stay missing so home can fetchCard', () => {
  const payload = { cards: [{ id: '1', name: 'Lucario', price: 10 }], sections: {} };
  const next = attachRecentsToHome(
    payload,
    ['798876'],
    [{ id: '798876', name: '', imageUrl: '/card-images/798876_thievul.jpg' }],
  );
  assert.deepEqual(next.sections.recentlySeenIds, []);
  assert.deepEqual(next.missingRecentIds, ['798876']);
  assert.equal(next.cards.some((card) => String(card.id) === '798876'), false);
});

test('nameless extra does not wipe a named rail card', () => {
  const payload = {
    cards: [{ id: '798876', name: 'Thievul', set: 'Pitch Black', price: 100 }],
    sections: {},
  };
  const next = attachRecentsToHome(payload, ['798876'], [{ id: '798876', name: '' }]);
  const thievul = next.cards.find((card) => String(card.id) === '798876');
  assert.equal(thievul.name, 'Thievul');
  assert.equal(thievul.price, 100);
  assert.deepEqual(next.missingRecentIds, []);
});

test('set rail load more slices priced cards and keeps hasMore from cardCount', () => {
  const cards = Array.from({ length: 120 }, (_, i) => ({ id: String(i + 1), price: 10 + i }));
  const first = sliceExpansionRail(cards, { limit: 48, offset: 0, cardCount: 172 });
  assert.equal(first.cards.length, 48);
  assert.equal(first.cards[0].id, '1');
  assert.equal(first.hasMore, true);
  const second = sliceExpansionRail(cards, { limit: 48, offset: 48, cardCount: 172 });
  assert.equal(second.cards[0].id, '49');
  assert.equal(second.hasMore, true);
  const pastRail = sliceExpansionRail(cards, { limit: 48, offset: 120, cardCount: 172 });
  assert.equal(pastRail.cards.length, 0);
  assert.equal(pastRail.hasMore, true);
});
