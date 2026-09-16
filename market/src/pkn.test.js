import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DKK_PER_EUR,
  LIST_CURRENCIES,
  applyLastMedianPrices,
  fiatFromPkn,
  formatPkn,
  formatPknNumber,
  idsMissingTilePrice,
  lastMedianFromSales,
  lastMedianMapFromBatch,
  listPriceHint,
  listingPriceToPkn,
  pknFromEur,
  tilePricePkn,
} from './pkn.js';

test('PKN prices are digits only so a comma cannot look like a decimal', () => {
  assert.equal(formatPkn(2642), '2642 PKN');
  assert.equal(formatPkn(22126), '22126 PKN');
  assert.equal(formatPknNumber(2642), '2642');
  assert.equal(formatPkn(12.5), '12.5 PKN');
  assert.equal(formatPkn(0), '');
  assert.doesNotMatch(formatPkn(2642), /,/);
});

test('EUR and USDT asks use 1 PKN = 0.005', () => {
  assert.equal(pknFromEur(62.29), 12458);
  assert.equal(listingPriceToPkn(1, 'USD'), 200);
  assert.equal(listingPriceToPkn(1, 'EUR'), 200);
  assert.equal(listingPriceToPkn(DKK_PER_EUR, 'DKK'), 200);
  assert.equal(listingPriceToPkn(489235, 'PKN'), 489235);
  assert.deepEqual(LIST_CURRENCIES, ['PKN', 'EUR', 'USD', 'DKK']);
});

test('list form hint converts the PKN suggestion into the selected currency', () => {
  assert.equal(listPriceHint(12458, 'EUR'), '62.29');
  assert.equal(listPriceHint(200, 'USD'), '1');
  assert.equal(listPriceHint(200, 'DKK'), '7.5');
  assert.equal(listPriceHint(489235, 'PKN'), '489235');
  assert.equal(fiatFromPkn(200, 'EUR'), 1);
});

test('EUR placeholder round-trips the PKN suggestion', () => {
  const pkn = 12458;
  const hint = listPriceHint(pkn, 'EUR');
  assert.equal(hint, '62.29');
  assert.equal(listingPriceToPkn(hint, 'EUR'), pkn);
  assert.equal(listingPriceToPkn('489,235', 'PKN'), 489235);
});

test('last-day sold median fills version tiles that have no catalog price', () => {
  assert.deepEqual(
    lastMedianMapFromBatch({
      prices: [
        { card_id: '600692', median_pkn: 982 },
        { card_id: '612610', median_pkn: 0 },
        { card_id: 'nope', median_pkn: 12 },
      ],
    }),
    { 600692: 982 },
  );
  assert.equal(lastMedianFromSales({ series: { lastMedianPkn: 982 } }), 982);
  assert.equal(lastMedianFromSales({ series: { lastMedianPkn: null } }), null);
  const rows = applyLastMedianPrices(
    [{ id: '600692', name: 'Castform Sunny Form' }, { id: '612610', name: 'Castform Sunny Form' }],
    { 600692: 982 },
  );
  assert.equal(tilePricePkn(rows[0]), 982);
  assert.equal(tilePricePkn(rows[1]), null);
  assert.deepEqual(
    idsMissingTilePrice(rows),
    ['612610'],
  );
});
