'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanLimit,
  cleanOffset,
  cleanUsername,
  conditionSql,
  sortSql,
  shopSellerFromProfile,
  listingRow,
} = require('./marketplace-seller-shop.js')._test;

test('cleanLimit caps at 100 for shop pages', () => {
  assert.equal(cleanLimit('100'), 100);
  assert.equal(cleanLimit('999'), 100);
  assert.equal(cleanLimit(''), 100);
  assert.equal(cleanLimit('0'), 1);
});

test('cleanOffset floors negatives', () => {
  assert.equal(cleanOffset('-3'), 0);
  assert.equal(cleanOffset('200'), 200);
});

test('cleanUsername rejects junk', () => {
  assert.equal(cleanUsername('redshakkio'), 'redshakkio');
  assert.equal(cleanUsername('...'), '');
});

test('conditionSql maps CT codes', () => {
  assert.deepEqual(conditionSql('NM').codes, ['NM', 'M']);
  assert.deepEqual(conditionSql('SP').codes, ['SP', 'LP']);
  assert.deepEqual(conditionSql('LP').codes, ['SP', 'LP']);
  assert.deepEqual(conditionSql('MP').codes, ['MP']);
  assert.deepEqual(conditionSql('PL').codes, ['PL', 'HP']);
  assert.deepEqual(conditionSql('HP').codes, ['PL', 'HP']);
  assert.deepEqual(conditionSql('Poor').codes, ['PO', 'POOR', 'D', 'DMG']);
  assert.equal(conditionSql(''), null);
});

test('a nickname or email change keeps the listing on the Firebase user', () => {
  const current = shopSellerFromProfile({
    uid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
    queried: 'redshakkio',
    via: 'firebase',
    profile: { username: 'redshakkio', displayName: 'Red' },
  });
  assert.equal(current.uid, 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2');
  assert.equal(current.username, 'redshakkio');

  const staleEmail = shopSellerFromProfile({
    uid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
    queried: 'redshakkio@gmail.com',
    via: 'listing-name',
    profile: { username: 'redshakkio', displayName: 'Red' },
  });
  assert.equal(staleEmail, null);

  const row = listingRow({
    id: '1',
    card_id: '9',
    seller_uid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
    seller_name: 'oldname@gmail.com',
    price_pkn: 18,
    card_name: 'Drifloon',
  }, current);
  assert.equal(row.sellerUid, 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2');
  assert.equal(row.sellerUsername, 'redshakkio');
  assert.equal(row.sellerName, 'Red');
  assert.equal(row.sellerName.includes('@'), false);
});

test('sortSql defaults to price asc', () => {
  assert.match(sortSql(''), /price_pkn asc/);
  assert.match(sortSql('price-desc'), /price_pkn desc/);
});
