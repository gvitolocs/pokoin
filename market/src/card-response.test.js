import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCardPageIdentity, cardPageMatchesId } from './card-response.js';

test('public Pokoin id binds the desk and every canonical link', () => {
  const expected = '806342';
  assert.equal(cardPageMatchesId(expected, { card: { id: expected } }), true);
  for (const data of [
    { card: { id: '511164' } },
    { card: { id: '403171' } },
    { card: { id: expected, canonicalPath: '/marketplace/en/cards/511164/other' } },
    { card: { id: expected }, canonicalPath: '/marketplace/en/cards/403171/blueprint' },
  ]) assert.throws(() => assertCardPageIdentity(expected, data), { code: 'card_identity_mismatch' });
});

test('same numeric id in another game cannot change the catalog', () => {
  const data = { game: 'lorcana', card: { id: '806390', canonicalPath: '/lorcana/marketplace/en/cards/806390/megara' } };
  assert.equal(cardPageMatchesId('806390', data), false);
  assert.equal(cardPageMatchesId('806390', data, { gameId: 'lorcana' }), true);
});
