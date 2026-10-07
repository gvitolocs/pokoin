'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PROVIDERS,
  getProvider,
  isAvailable,
  partnerActive,
  publicProvider,
} = require('./_platform_providers');

const EXPECTED_IDS = [
  'shopify',
  'binderpos',
  'tcgplayer',
  'cardmarket',
  'ccgseller',
  'storepass',
  'sortswift',
  'magus',
];

test('the registry lists exactly the generalised providers in order', () => {
  assert.deepEqual(PROVIDERS.map((row) => row.id), EXPECTED_IDS);
  // CardTrader keeps its own routes, webhook and reconcile; it is not a registry row.
  assert.equal(getProvider('cardtrader'), null);
});

test('every provider declares the shape the API and adapters rely on', () => {
  for (const provider of PROVIDERS) {
    assert.match(provider.id, /^[a-z]+$/);
    assert.ok(provider.label, `${provider.id} needs a label`);
    assert.ok(
      ['token_panel', 'fields', 'oauth_redirect', 'partner'].includes(provider.authType),
      `${provider.id} authType`,
    );
    assert.ok(provider.adapter, `${provider.id} needs an adapter`);
    assert.ok(Array.isArray(provider.fields), `${provider.id} fields`);
    assert.ok(provider.capabilities && typeof provider.capabilities === 'object');
    assert.ok(Array.isArray(provider.requiredEnv), `${provider.id} requiredEnv`);
  }
});

test('secret fields are marked password and never carry a value', () => {
  const shopify = getProvider('shopify');
  assert.deepEqual(shopify.fields.map((field) => field.name), ['shopDomain', 'accessToken', 'apiSecretKey']);
  for (const field of shopify.fields) {
    assert.equal(field.value, undefined, `${field.name} must not include a value`);
  }
  assert.equal(shopify.fields.find((field) => field.name === 'accessToken').type, 'password');
  assert.equal(shopify.fields.find((field) => field.name === 'apiSecretKey').type, 'password');
});

test('binderpos reuses the shopify adapter and capabilities', () => {
  const binderpos = getProvider('binderpos');
  const shopify = getProvider('shopify');
  assert.equal(binderpos.adapter, 'shopify');
  assert.deepEqual(binderpos.capabilities, shopify.capabilities);
  assert.deepEqual(binderpos.fields, shopify.fields);
});

test('cardmarket is an OAuth redirect and the four partners are partner requests', () => {
  assert.equal(getProvider('cardmarket').authType, 'oauth_redirect');
  assert.deepEqual(getProvider('cardmarket').fields, []);
  for (const id of ['ccgseller', 'storepass', 'sortswift', 'magus']) {
    assert.equal(getProvider(id).authType, 'partner');
    assert.equal(getProvider(id).capabilities.poll, false);
  }
});

test('isAvailable gates a provider on its Pokoin env, shopify needs none', () => {
  const empty = {};
  assert.equal(isAvailable(getProvider('shopify'), empty), true);
  assert.equal(isAvailable(getProvider('binderpos'), empty), true);
  assert.equal(isAvailable(getProvider('tcgplayer'), empty), false);
  assert.equal(isAvailable(getProvider('cardmarket'), empty), false);
  assert.equal(isAvailable(null, empty), false);
  assert.equal(isAvailable(getProvider('tcgplayer'), { TCGPLAYER_PUBLIC_KEY: 'a' }), false);
  assert.equal(
    isAvailable(getProvider('tcgplayer'), { TCGPLAYER_PUBLIC_KEY: 'a', TCGPLAYER_PRIVATE_KEY: 'b' }),
    true,
  );
  // A blank env var is not configured.
  assert.equal(
    isAvailable(getProvider('cardmarket'), { CARDMARKET_APP_TOKEN: '  ', CARDMARKET_APP_SECRET: 'x' }),
    false,
  );
  assert.equal(
    isAvailable(getProvider('ccgseller'), { PLATFORM_CCGSELLER_API_BASE: 'https://api.example' }),
    true,
  );
});

test('partnerActive is true only for a partner provider with its base configured', () => {
  const env = { PLATFORM_MAGUS_API_BASE: 'https://api.example' };
  assert.equal(partnerActive(getProvider('magus'), env), true);
  assert.equal(partnerActive(getProvider('magus'), {}), false);
  assert.equal(partnerActive(getProvider('shopify'), env), false);
  assert.equal(partnerActive(null, env), false);
});

test('publicProvider exposes derived availability and never leaks requiredEnv', () => {
  const publicShopify = publicProvider(getProvider('shopify'), {});
  assert.equal(publicShopify.available, true);
  assert.equal(publicShopify.partnerActive, false);
  assert.equal(publicShopify.requiredEnv, undefined);
  const publicTcg = publicProvider(getProvider('tcgplayer'), {});
  assert.equal(publicTcg.available, false);
  assert.equal(publicTcg.requiredEnv, undefined);
  assert.equal(publicProvider(null, {}), null);
});
