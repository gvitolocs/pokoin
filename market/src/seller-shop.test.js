import assert from 'node:assert/strict';
import test from 'node:test';
import { sellerShopEmptyCopy, sellerShopErrorState } from './seller-shop.js';

test('seller shop errors never show the api message', () => {
  const leaked = 'error returned from database: relation "public.marketplace_user_listings" does not exist';
  const missing = sellerShopErrorState({ status: 404, message: leaked });
  assert.equal(missing.kind, 'not_found');
  assert.equal(missing.title, 'Seller not found');
  assert.equal(missing.lede, 'No Pokoin seller uses this username.');
  assert.equal(JSON.stringify(missing).includes('marketplace_user_listings'), false);
  assert.equal(JSON.stringify(missing).includes(leaked), false);

  const down = sellerShopErrorState({ status: 503, message: `The one_piece marketplace catalog is unavailable: ${leaked}` });
  assert.equal(down.kind, 'unavailable');
  assert.equal(down.title, 'Shop unavailable');
  assert.equal(down.lede, 'This shop could not be loaded right now. Try again in a moment.');
  assert.equal(down.title.includes('Seller not found'), false);
  assert.equal(JSON.stringify(down).includes('does not exist'), false);

  const gateway = sellerShopErrorState({ status: 502, message: 'Bad gateway' });
  assert.equal(gateway.kind, 'unavailable');
  assert.equal(gateway.lede.includes('Bad gateway'), false);

  const network = sellerShopErrorState(new TypeError('Failed to fetch'));
  assert.equal(network.kind, 'unavailable');
  assert.equal(network.title, 'Shop unavailable');
  assert.equal(network.lede.includes('Failed to fetch'), false);
});

test('empty shop copy names the satellite game only when nothing is filtered', () => {
  const open = sellerShopEmptyCopy({
    gameName: 'One Piece',
    displayName: 'Red',
    pokemon: false,
    narrowed: false,
  });
  assert.equal(open.title, 'No One Piece listings yet');
  assert.equal(open.lede, 'Red has no One Piece listings yet.');

  const filtered = sellerShopEmptyCopy({
    gameName: 'One Piece',
    displayName: 'Red',
    pokemon: false,
    narrowed: true,
  });
  assert.equal(filtered.title, 'No listings');
  assert.equal(filtered.lede, 'Red has no live asks for these filters.');

  const pokemon = sellerShopEmptyCopy({
    gameName: 'Pokémon',
    displayName: 'Red',
    pokemon: true,
    narrowed: false,
  });
  assert.equal(pokemon.title, 'No listings');
  assert.equal(pokemon.lede, 'Red has no live asks.');

  const pokemonFiltered = sellerShopEmptyCopy({
    gameName: 'Pokémon',
    displayName: 'Red',
    pokemon: true,
    narrowed: true,
  });
  assert.equal(pokemonFiltered.title, 'No listings');
  assert.equal(pokemonFiltered.lede, 'Red has no live asks for these filters.');
});
