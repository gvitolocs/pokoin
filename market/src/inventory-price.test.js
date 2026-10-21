import assert from 'node:assert/strict';
import test from 'node:test';
import {
  gamePrices, inventoryMarketLabel, inventoryMarketValue, priceCheckGroups, priceCheckItem, priceCheckKey, priceGame,
} from './inventory-price.js';

const row = { cardId: '824942' };
const daily = { days: [
  { day: '2026-10-02', lowestAskPkn: 11128, sourceTimestamp: '2026-10-02T02:27:50Z' },
  { day: '2026-09-30', lowestAskPkn: 13128, sourceTimestamp: '2026-09-30T15:57:44Z' },
] };

test('CardTrader price is only the professional seller with the same condition, language and finish', () => {
  const value = inventoryMarketValue({ 824942: { ctMatchedPkn: 14000, ctCheapestPkn: 11128, cardtraderListed: daily } }, row, 'cardtrader');
  assert.equal(value.value, 14000);
  assert.match(value.title, /professional CardTrader seller with the same condition, language and finish/);
  assert.equal(inventoryMarketLabel(value), '14000 PKN');
});

test('no matching professional offer means no CardTrader price, never another facet or a private ask', () => {
  assert.equal(inventoryMarketValue({ 824942: { ctCheapestPkn: 11128, cardtraderListed: daily } }, row, 'cardtrader'), null);
});

test('a reverse or first-edition copy reads its own comp', () => {
  const prices = {
    824942: { ctMatchedPkn: 64 },
    '824942:NM:EN:': { ctMatchedPkn: 64 },
    '824942:NM:EN:R': { ctMatchedPkn: 590 },
  };
  assert.equal(priceCheckKey({ cardId: '824942', condition: 'nm', language: 'en', foilState: 'reverse' }), '824942:NM:EN:R');
  assert.equal(priceCheckKey({ card_id: '824942', condition: 'NM', language: 'EN', first_edition: true }), '824942:NM:EN:F');
  assert.equal(priceCheckKey({ cardId: '1', condition: 'LP', language: 'IT' }), '1:SP:IT:');
  assert.equal(priceCheckKey({ cardId: '1', condition: 'HP', language: 'IT' }), '1:PL:IT:');
  assert.equal(priceCheckKey({ cardId: '1', condition: 'PO', language: 'IT' }), '1:Poor:IT:');
  assert.equal(inventoryMarketValue(prices, { cardId: '824942', condition: 'NM', language: 'EN', reverse: true }, 'cardtrader').value, 590);
  assert.equal(inventoryMarketValue(prices, { cardId: '824942', condition: 'NM', language: 'EN' }, 'cardtrader').value, 64);
});

test('graded, signed, altered and foil copies carry their own flags in the server order', () => {
  assert.equal(priceCheckKey({ cardId: '1', condition: 'NM', language: 'EN', graded: true }), '1:NM:EN:G');
  assert.equal(priceCheckKey({ cardId: '1', condition: 'NM', language: 'EN', signed: true, altered: true }), '1:NM:EN:SA');
  assert.equal(priceCheckKey({ cardId: '1', condition: 'NM', language: 'EN', foil_state: 'foil' }), '1:NM:EN:H');
  assert.equal(priceCheckKey({
    cardId: '1', condition: 'NM', language: 'EN', reverse: true, firstEdition: true, foil: true, graded: true, signed: true, altered: true,
  }), '1:NM:EN:RFHGSA');
  // An item keys like the row it came from (fetchPriceCheck sends items).
  const item = priceCheckItem({ card_id: '7', condition: 'LP', language: 'it', foilState: 'reverse', graded: true });
  assert.equal(priceCheckKey(item), '7:SP:IT:RG');
  // A graded copy never reads the raw copy's comp.
  const prices = { 7: { ctMatchedPkn: 50 }, '7:NM:EN:': { ctMatchedPkn: 50 }, '7:NM:EN:G': { ctMatchedPkn: null } };
  assert.equal(inventoryMarketValue(prices, { cardId: '7', condition: 'NM', language: 'EN', graded: true }, 'cardtrader'), null);
});

test('rows price against their own game', () => {
  assert.equal(priceGame({ marketplaceGame: 'riftbound' }), 'riftbound');
  assert.equal(priceGame({ marketplace_game: 'magic' }, 'pokemon'), 'magic');
  assert.equal(priceGame({}, 'one_piece'), 'one_piece');
  assert.equal(priceGame({ marketplaceGame: '' }), 'pokemon');
});

test('price checks group rows by their own game, the desk game for rows without one', () => {
  const rows = [
    { cardId: '824942', condition: 'NM', language: 'EN' },
    { cardId: '801148', condition: 'LP', language: 'EN', marketplaceGame: 'riftbound' },
    { card_id: '5001', condition: 'NM', language: 'IT', marketplace_game: 'magic', foil: true },
    { cardId: '801149', condition: 'NM', language: 'EN', marketplaceGame: 'riftbound' },
    { cardId: 'sealed-box', marketplaceGame: 'riftbound' },
  ];
  const groups = priceCheckGroups(rows, 'pokemon');
  assert.deepEqual(groups.map((group) => [group.game, group.items.map(priceCheckKey)]), [
    ['pokemon', ['824942:NM:EN:']],
    ['riftbound', ['801148:SP:EN:', '801149:NM:EN:']],
    ['magic', ['5001:NM:IT:H']],
  ]);
  // On the Riftbound desk, a row without a game is a Riftbound card.
  assert.deepEqual(priceCheckGroups([{ cardId: '1' }], 'riftbound').map((group) => group.game), ['riftbound']);
  assert.deepEqual(priceCheckGroups([], 'pokemon'), []);
  assert.deepEqual(priceCheckGroups([{ cardId: '' }, { cardId: 'abc' }], 'pokemon'), []);
});

test('price checks hold at most 100 priceable rows across games', () => {
  const rows = [{ cardId: 'x' }, ...Array.from({ length: 150 }, (_, index) => ({
    cardId: String(index + 1), marketplaceGame: index % 2 ? 'riftbound' : 'pokemon',
  }))];
  const groups = priceCheckGroups(rows, 'pokemon');
  assert.equal(groups.reduce((sum, group) => sum + group.items.length, 0), 100);
  assert.equal(groups.at(-1).items.at(-1).cardId, '100');
  assert.equal(priceCheckGroups(rows, 'pokemon', { limit: 3 }).flatMap((group) => group.items).length, 3);
});

test('a row reads the comp of its own game, never a colliding card id of another game', () => {
  const byGame = {
    pokemon: { '801148:NM:EN:': { ctMatchedPkn: 900 } },
    riftbound: { '801148:NM:EN:': { ctMatchedPkn: 240, ctBasis: 'zero' } },
    magic: null,
  };
  const rift = { cardId: '801148', condition: 'NM', language: 'EN', marketplaceGame: 'riftbound' };
  assert.equal(inventoryMarketValue(gamePrices(byGame, rift, 'pokemon'), rift, 'cardtrader').value, 240);
  const poke = { cardId: '801148', condition: 'NM', language: 'EN' };
  assert.equal(inventoryMarketValue(gamePrices(byGame, poke, 'pokemon'), poke, 'cardtrader').value, 900);
  assert.equal(inventoryMarketValue(gamePrices(byGame, poke, 'riftbound'), poke, 'cardtrader').value, 240);
  // A game whose check failed, or was never asked, has no comp.
  assert.deepEqual(gamePrices(byGame, { cardId: '1', marketplaceGame: 'magic' }, 'pokemon'), {});
  assert.deepEqual(gamePrices(byGame, { cardId: '1', marketplaceGame: 'one_piece' }, 'pokemon'), {});
  assert.deepEqual(gamePrices(undefined, poke, 'pokemon'), {});
});

test('other games read the CardTrader Zero price file', () => {
  const value = inventoryMarketValue({ 801148: { ctMatchedPkn: 240, ctBasis: 'zero' } }, { cardId: '801148' }, 'cardtrader');
  assert.equal(value.value, 240);
  assert.match(value.title, /CardTrader Zero seller with the same language and finish, in this condition or better/);
});

test('TCGplayer variants retain USD and source timestamps without PKN conversion', () => {
  const value = inventoryMarketValue({ 824942: { tcgplayer: [
    { marketPrice: '59.2700', subtype: 'Holofoil', sourceTimestamp: '2026-09-30T20:05:12Z' },
    { marketPrice: '70.10', subtype: 'Reverse Holofoil', sourceTimestamp: '2026-09-30T20:05:12Z' },
  ] } }, row, 'tcgplayer');
  assert.equal(value.currency, 'USD');
  assert.equal(inventoryMarketLabel(value), '$59.27–$70.10 USD');
  assert.match(value.title, /Holofoil: \$59.2700/);
  assert.match(value.title, /condition is unspecified/);
});

test('missing, null, zero and invalid TCGplayer quotes stay unavailable', () => {
  assert.equal(inventoryMarketValue({ 824942: { tcgplayer: [
    { marketPrice: null }, { marketPrice: '0' }, { marketPrice: '-1' }, { marketPrice: 'unknown' },
  ] } }, row, 'tcgplayer'), null);
  assert.equal(inventoryMarketValue({}, row, 'cardtrader'), null);
  assert.equal(inventoryMarketLabel(null), '—');
});

test('Pokoin sold fallback is explicitly attributed to CardTrader inferred sales', () => {
  const value = inventoryMarketValue({ 824942: { soldMedianPkn: 20000 } }, row, 'pokoin');
  assert.equal(value.value, 20000);
  assert.match(value.title, /CardTrader 30-day inferred-sale median/);
  assert.equal(inventoryMarketLabel(value), '20000 PKN');
});
