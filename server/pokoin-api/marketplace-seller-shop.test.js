'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanLimit,
  cleanOffset,
  cleanUsername,
  conditionSql,
  sortSql,
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
  assert.equal(conditionSql('NM').value, '%near%');
  assert.equal(conditionSql('SP').value, '%slight%');
});

test('sortSql defaults to price asc', () => {
  assert.match(sortSql(''), /price_pkn asc/);
  assert.match(sortSql('price-desc'), /price_pkn desc/);
});
