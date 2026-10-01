'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readTcgplayerPrices, groupPrices } = require('./_tcgcsv_prices');

test('different printings and null/zero quotes retain exact decimals and raw fields', () => {
  const rows = ['Normal', 'Holofoil'].map((subtype, i) => ({ card_id:'42',
    product_id:'100',category_id:3,subtype,market_price:i ? null : '0.00',
    high_price:'123456789.123456',raw_data:{futureField:'retained'},snapshot_timestamp:'2026-09-30T20:05:12+0000' }));
  const prices = groupPrices(rows)['42'];
  assert.equal(prices.length,2);
  assert.equal(prices[0].marketPrice,'0.00');
  assert.equal(prices[1].marketPrice,null);
  assert.equal(prices[0].highPrice,'123456789.123456');
  assert.deepEqual(prices[0].rawData,{futureField:'retained'});
  assert.equal(prices[0].currency,'USD');
  assert.equal(prices[0].conditionSpecific,false);
});

test('same public id in different games is queried with an explicit game', async () => {
  await readTcgplayerPrices('magic',['42'],async (sql, values) => {
    assert.match(sql,/game=\$1/);
    assert.deepEqual(values,['magic',['42']]);
    return {rows:[]};
  });
});

test('missing configuration never falls back to marketplace database or invented prices', async () => {
  const previous = process.env.TCGCSV_DATABASE_URL;
  delete process.env.TCGCSV_DATABASE_URL;
  try { assert.deepEqual(await readTcgplayerPrices('pokemon',['42']),{status:'unconfigured',prices:{}}); }
  finally { if (previous !== undefined) process.env.TCGCSV_DATABASE_URL = previous; }
});
