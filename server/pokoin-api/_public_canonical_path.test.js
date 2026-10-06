'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { publicCanonicalPath } = require('./_public_canonical_path');

test('satellite canonical paths keep the game slug once', () => {
  assert.equal(
    publicCanonicalPath('/marketplace/en/cards/598560/chopper', 'one-piece'),
    '/one-piece/marketplace/en/cards/598560/chopper',
  );
  assert.equal(
    publicCanonicalPath('/one-piece/marketplace/en/cards/598560/chopper', 'one-piece'),
    '/one-piece/marketplace/en/cards/598560/chopper',
  );
  assert.equal(
    publicCanonicalPath('/marketplace/en/cards/239000/charizard', ''),
    '/marketplace/en/cards/239000/charizard',
  );
  assert.equal(
    publicCanonicalPath('/marketplace/en/cards/795832/student', 'star-wars'),
    '/star-wars/marketplace/en/cards/795832/student',
  );
});
