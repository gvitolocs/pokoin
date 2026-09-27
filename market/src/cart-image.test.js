import assert from 'node:assert/strict';
import test from 'node:test';
import { cartImageFor, repairCartImage } from './cart-image.js';

const poffin = {
  id: '741644',
  name: 'Buddy-Buddy Poffin',
  canonicalPath: '/marketplace/en/cards/741644/card-buddy-buddy-poffin-184-217-ascended-heroes',
};
const cardTraderPreview = 'https://cardtrader.com/uploads/blueprints/image/370822/preview_buddy-buddy-poffin-184-217-ascended-heroes.jpg';

test('cart image converts a CardTrader preview to Pokoin catalogue art', () => {
  assert.equal(
    cartImageFor(poffin, { cardImageUrl: cardTraderPreview }),
    '/card-images/370822_buddy-buddy-poffin.jpg',
  );
});

test('saved cart rows are repaired on load', () => {
  assert.equal(repairCartImage({
    cardId: poffin.id,
    name: poffin.name,
    href: poffin.canonicalPath,
    image: cardTraderPreview,
  }), '/card-images/370822_buddy-buddy-poffin.jpg');
});
