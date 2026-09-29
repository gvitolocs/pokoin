'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { cleanQuery, cleanUsername } = require('./marketplace-associate-suggest.js')._test;

test('cleanQuery lowercases and trims the suggest term', () => {
  assert.equal(cleanQuery('  Gianlonji '), 'gianlonji');
  assert.equal(cleanQuery('MI  LO'), 'mi lo');
  assert.equal(cleanQuery(''), '');
  assert.equal(cleanQuery('x'.repeat(80)), 'x'.repeat(64));
});

test('cleanUsername keeps lowercase handles only', () => {
  assert.equal(cleanUsername(' Gianlonji '), 'gianlonji');
  assert.equal(cleanUsername(''), '');
});
