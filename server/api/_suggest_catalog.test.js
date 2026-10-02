'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { catalogSqlNeeded } = require('./_suggest_catalog');

test('ordinary English suggest with nationality does not need SQL', () => {
  const need = catalogSqlNeeded([{ printings: [{ nationality: 'western' }] }], 'en');
  assert.deepEqual(need, { nationality: false, title: false });
});

test('a printing without nationality still needs the expansion lookup', () => {
  assert.equal(catalogSqlNeeded([{ printings: [{ name: 'Pikachu' }] }], 'en').nationality, true);
});

test('a non-English title still needs the catalog overlay', () => {
  assert.equal(catalogSqlNeeded([{ printings: [{ nationality: 'japanese' }] }], 'ja').title, true);
});
