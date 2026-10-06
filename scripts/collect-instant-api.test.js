'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { validate, loadManifest } = require('./collect-instant-api');

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
  const manifest = loadManifest();
  assert.deepEqual(
    result.files.map((file) => path.basename(file)).sort(),
    [...manifest.ship].sort(),
  );
  assert.ok(result.files.includes('server/pokoin-api/_valkey.js'));
});

test('deploy-instant-api runs test files that exist', () => {
  const script = fs.readFileSync(path.join(__dirname, 'deploy-instant-api.sh'), 'utf8');
  const files = [...script.matchAll(/"\$STAGE\/([^"]+)"/g)]
    .map((match) => match[1])
    .filter((file) => file.endsWith('.js'));
  assert.ok(files.includes('server/pokoin-api/_redis_cache.test.js'));
  assert.equal(files.includes('server/pokoin-api/_valkey.test.js'), false);
  for (const file of files) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', file)), true, file);
  }
});
