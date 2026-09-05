import assert from 'node:assert/strict';
import test from 'node:test';
import { attachRecentsToHome, isPublicRailsVector } from './lists.js';

test('SPA accepts Worker/Supabase rails and rejects Flutter hydrate', () => {
  assert.equal(
    isPublicRailsVector({
      source: 'supabase',
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
  const payload = { cards: [{ id: '1' }], sections: {} };
  const next = attachRecentsToHome(payload, ['2'], [{ id: '2', name: 'Dawn', price: 3450 }]);
  assert.deepEqual(next.sections.recentlySeenIds, ['2']);
  assert.deepEqual(next.missingRecentIds, []);
  assert.equal(next.cards.find((card) => card.id === '2').name, 'Dawn');
});
