'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { getAdapter } = require('./index');

test('getAdapter returns the module named by the provider registry', () => {
  assert.equal(getAdapter('shopify'), require('./shopify'));
  assert.equal(getAdapter('binderpos'), require('./shopify'));
  assert.equal(getAdapter('cardmarket'), require('./cardmarket'));
  assert.equal(getAdapter('tcgplayer'), require('./tcgplayer'));
  assert.equal(getAdapter('ccgseller'), require('./partner'));
  assert.equal(getAdapter('storepass'), require('./partner'));
  assert.equal(getAdapter('sortswift'), require('./partner'));
  assert.equal(getAdapter('magus'), require('./partner'));
});

test('getAdapter throws 404 platform_unknown for an unknown provider', () => {
  for (const bad of ['nope', '', null, undefined, 'CARDTRADER ']) {
    assert.throws(
      () => getAdapter(bad),
      (error) => error.statusCode === 404 && error.code === 'platform_unknown',
      `expected ${JSON.stringify(bad)} to be unknown`,
    );
  }
});
