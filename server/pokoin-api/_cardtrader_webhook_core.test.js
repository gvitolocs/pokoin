'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  eventDocId,
  itemProductId,
  itemUserDataField,
  orderItemId,
  shouldDecrementStock,
  verifyWebhookSignature,
} = require('./_cardtrader_webhook_core');

test('webhook stock gate follows direct paid and Zero hub_pending states', () => {
  assert.equal(shouldDecrementStock({ state: 'paid', via_cardtrader_zero: false }), true);
  assert.equal(shouldDecrementStock({ state: 'hub_pending', via_cardtrader_zero: false }), false);
  assert.equal(shouldDecrementStock({ state: 'paid', via_cardtrader_zero: true }), false);
  assert.equal(shouldDecrementStock(
    { id: 10, state: 'hub_pending', via_cardtrader_zero: true },
    { hub_pending_order_id: 10 },
  ), true);
  assert.equal(shouldDecrementStock(
    { id: 10, state: 'hub_pending', via_cardtrader_zero: true },
    { hub_pending_order_id: 11 },
  ), false);
});

test('webhook accepts flat and nested seller-product identities', () => {
  assert.equal(itemProductId({ product_id: 12 }), '12');
  assert.equal(itemProductId({ seller_product_id: 13 }), '13');
  assert.equal(itemProductId({ product: { id: 14 } }), '14');
  assert.equal(itemUserDataField({ product: { user_data_field: 'pokoin:abc' } }), 'pokoin:abc');
  assert.equal(orderItemId({ order_item_id: 88 }), '88');
  assert.equal(orderItemId({ product: { id: 14 } }), '14');
  assert.equal(eventDocId('seller', 1, 2), 'seller_1_2');
});

test('webhook signature is base64 HMAC-SHA256 of the raw body', () => {
  const body = Buffer.from('{"cause":"order.update"}', 'utf8');
  const secret = 'webhook-secret';
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(verifyWebhookSignature(body, signature, secret), true);
  assert.equal(verifyWebhookSignature(body, 'bad', secret), false);
});

test('raw body is read from the untouched stream the Pi server hands rawBody routes', async () => {
  const { Readable } = require('node:stream');
  const { rawBodyBuffer } = require('./_cardtrader_webhook_core');
  const body = '{"cause":"order.update","data":{"id":1,"state":"paid"}}';
  const secret = 'shared-secret';
  const req = Readable.from([Buffer.from(body.slice(0, 20)), Buffer.from(body.slice(20))]);
  req.headers = {};
  const raw = await rawBodyBuffer(req);
  assert.equal(raw.toString('utf8'), body);
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(verifyWebhookSignature(raw, signature, secret), true);
  // The old path signed an empty buffer: a real delivery could never verify.
  assert.equal(verifyWebhookSignature(Buffer.alloc(0), signature, secret), false);
});

test('raw body prefers an already-buffered rawBody', async () => {
  const { rawBodyBuffer } = require('./_cardtrader_webhook_core');
  const raw = await rawBodyBuffer({ rawBody: Buffer.from('abc') });
  assert.equal(raw.toString('utf8'), 'abc');
});
