'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validate } = require('./collect-instant-api');

test('instant API artifact closes over the new runtime modules', () => {
  const result = validate();
  assert.equal(result.ok, true, result.errors.join('\n'));
  const bases = new Set(result.files.map((file) => file.split('/').pop()));
  for (const name of [
    '_outbox.js',
    '_sync_engine.js',
    '_redis_cache.js',
    '_read_model_cache.js',
    '_listing_inventory.js',
    '_request_timing.js',
    '_artist_summary.js',
    '_suggest_catalog.js',
    'marketplace-live.js',
    'marketplace-listings.js',
    'marketplace-card-page.js',
    'marketplace-suggest.js',
  ]) {
    assert.equal(bases.has(name), true, name);
  }
  assert.ok(result.external.includes('_marketplace_db.js'));
  assert.ok(result.external.includes('_marketplace_react_sql.js'));
  assert.equal(result.files.some((file) => file.endsWith('marketplace-autocomplete.js')), false);
  assert.equal(result.files.some((file) => file.endsWith('_firebase.js')), false);
  assert.deepEqual(result.migrations, [
    'scripts/sql/096_marketplace_outbox.sql',
    'scripts/sql/097_marketplace_artist_summary.sql',
  ]);
  assert.ok(result.routes.some((route) => route.path === '/api/marketplace-live' && route.file === 'marketplace-live.js'));
});
