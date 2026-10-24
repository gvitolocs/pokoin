import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPriceChecksByGame } from './api.js';
import { gamePrices, inventoryMarketValue, priceCheckGroups } from './inventory-price.js';

test('a mixed-game book sends one price check per game and reads each row from its own game', async () => {
  const previous = globalThis.window;
  globalThis.window = { location: { hostname: 'pokoin.com', pathname: '/mypokoin/inventory' } };
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    const params = new URL(href).searchParams;
    const game = params.get('game') || 'pokemon';
    calls.push({ game, items: params.get('items') });
    if (game === 'magic') throw new Error('magic price check down');
    const body = { prices: Object.fromEntries(params.get('items').split(',').map((key) => [key, {
      ctMatchedPkn: game === 'riftbound' ? 240 : 900,
      ...(game === 'riftbound' ? { ctBasis: 'zero' } : {}),
    }])) };
    return {
      ok: true,
      headers: { get: () => '' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  try {
    const rows = [
      { cardId: '801148', condition: 'NM', language: 'EN' },
      { cardId: '801148', condition: 'NM', language: 'EN', marketplaceGame: 'riftbound' },
      { cardId: '5001', condition: 'NM', language: 'EN', marketplaceGame: 'magic' },
    ];
    const byGame = await fetchPriceChecksByGame(priceCheckGroups(rows, 'pokemon'), 'token');
    assert.deepEqual(calls.map((call) => [call.game, call.items]).sort(), [
      ['magic', '5001:NM:EN:'],
      ['pokemon', '801148:NM:EN:'],
      ['riftbound', '801148:NM:EN:'],
    ]);
    // The same card id is a different card in each game.
    assert.equal(inventoryMarketValue(gamePrices(byGame, rows[0], 'pokemon'), rows[0], 'cardtrader').value, 900);
    assert.equal(inventoryMarketValue(gamePrices(byGame, rows[1], 'pokemon'), rows[1], 'cardtrader').value, 240);
    // A failed game is null, and only its rows lack a comp.
    assert.equal(byGame.magic, null);
    assert.equal(inventoryMarketValue(gamePrices(byGame, rows[2], 'pokemon'), rows[2], 'cardtrader'), null);
    assert.deepEqual(await fetchPriceChecksByGame([], 'token'), {});
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.window = previous;
  }
});
