'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { validate, adjustStock } = require('./partner');

test('partner validate accepts a key and marks the request pending', async () => {
  const result = await validate({}, { apiKey: 'partner-key-1234', storeId: 'store-7' });
  assert.deepEqual(result.credentials, { apiKey: 'partner-key-1234' });
  assert.deepEqual(result.metadata, { storeId: 'store-7' });
  assert.equal(result.state, 'pending_activation');
});

test('partner validate defaults an absent store id', async () => {
  const result = await validate({}, { apiKey: 'partner-key-1234' });
  assert.deepEqual(result.metadata, { storeId: '' });
});

test('partner validate rejects a key outside 8..512 characters', async () => {
  await assert.rejects(
    validate({}, { apiKey: 'short' }),
    (error) => error.statusCode === 400 && error.code === 'partner_api_key_invalid',
  );
  await assert.rejects(
    validate({}, { apiKey: 'x'.repeat(513) }),
    (error) => error.statusCode === 400 && error.code === 'partner_api_key_invalid',
  );
});

test('partner adjustStock never writes before activation', async () => {
  const result = await adjustStock({}, { link: { external_id: '1' }, delta: -1 });
  assert.deepEqual(result, { ok: false, skipped: true, reason: 'partner_pending' });
});
