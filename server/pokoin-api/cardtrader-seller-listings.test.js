const assert = require('node:assert/strict');
const test = require('node:test');

const {
  shouldDecrementStock,
  verifyWebhookSignature,
  eventDocId,
} = require('./cardtrader-webhook')._test;

const {
  buildProductBody,
  eurFromPkn,
  leftoverBlueprintId,
  normalizeTargets,
  parseCtProductId,
  parsePokoinListingId,
  pokoinUserDataField,
  ctSourceListingId,
} = require('./_cardtrader_seller_listings');

const {
  cardTraderWebhookUrlForUid,
} = require('./_cardtrader_client');

test('CardTrader stock gate follows Zero hub_pending and paid direct', () => {
  assert.equal(shouldDecrementStock({ state: 'hub_pending', via_cardtrader_zero: true }, {}), true);
  assert.equal(shouldDecrementStock({ state: 'paid', via_cardtrader_zero: false }, {}), true);
  assert.equal(shouldDecrementStock({ state: 'paid', via_cardtrader_zero: true }, {}), false);
  assert.equal(shouldDecrementStock({ state: 'hub_pending', via_cardtrader_zero: false }, {}), false);
  assert.equal(shouldDecrementStock({ state: 'shipped', via_cardtrader_zero: false }, {}), false);
  assert.equal(
    shouldDecrementStock(
      { id: 10, state: 'hub_pending', via_cardtrader_zero: true },
      { hub_pending_order_id: 10 },
    ),
    true,
  );
  assert.equal(
    shouldDecrementStock(
      { id: 10, state: 'hub_pending', via_cardtrader_zero: true },
      { hub_pending_order_id: 99 },
    ),
    false,
  );
});

test('CardTrader webhook signature is base64 HMAC-SHA256 of raw body', () => {
  const body = Buffer.from('{"cause":"order.update"}', 'utf8');
  const secret = 'webhook-secret';
  const crypto = require('node:crypto');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(verifyWebhookSignature(body, signature, secret), true);
  assert.equal(verifyWebhookSignature(body, 'bad', secret), false);
});

test('inventory targets default and normalize', () => {
  assert.deepEqual(normalizeTargets({}), { pokoin: true, cardtrader: false });
  assert.deepEqual(normalizeTargets({ pokoin: true, cardtrader: true }), { pokoin: true, cardtrader: true });
  assert.deepEqual(normalizeTargets({ pokoin: false, cardtrader: true }), { pokoin: false, cardtrader: true });
  assert.deepEqual(normalizeTargets({ pokoin: false, cardtrader: false }), { pokoin: true, cardtrader: false });
});

test('PKN to EUR and blueprint leftover mapping', () => {
  assert.equal(eurFromPkn(200), 1);
  assert.equal(eurFromPkn(716), 3.58);
  assert.equal(leftoverBlueprintId('496172'), 248086);
  assert.equal(leftoverBlueprintId('248087'), 248087);
});

test('Pokoin ↔ CardTrader link ids', () => {
  assert.equal(ctSourceListingId('19799784'), 'ct:19799784');
  assert.equal(parseCtProductId('ct:19799784'), '19799784');
  assert.equal(parseCtProductId('cardtrader:19799784'), '19799784');
  assert.equal(pokoinUserDataField('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), 'pokoin:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(parsePokoinListingId('pokoin:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(eventDocId('uid1', 12, 34), 'uid1_12_34');
});

test('buildProductBody maps listing facets for CardTrader', () => {
  const body = buildProductBody({
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    cardId: '496172',
    pricePkn: 200,
    quantityAvailable: 2,
    condition: 'LP',
    language: 'JP',
    reverse: true,
    firstEdition: true,
    signed: false,
    altered: false,
  });
  assert.equal(body.blueprint_id, 248086);
  assert.equal(body.price, 1);
  assert.equal(body.quantity, 2);
  assert.equal(body.user_data_field, 'pokoin:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(body.properties.condition, 'Slightly Played');
  assert.equal(body.properties.pokemon_language, 'jp');
  assert.equal(body.properties.pokemon_reverse, true);
  assert.equal(body.properties.pokemon_first_edition, true);
});

test('webhook URL includes seller firebase uid', () => {
  const original = process.env.CARDTRADER_WEBHOOK_BASE_URL;
  process.env.CARDTRADER_WEBHOOK_BASE_URL = 'https://api.pokoin.com';
  try {
    assert.equal(
      cardTraderWebhookUrlForUid('firebase-uid'),
      'https://api.pokoin.com/api/cardtrader-webhook/firebase-uid',
    );
  } finally {
    if (original === undefined) delete process.env.CARDTRADER_WEBHOOK_BASE_URL;
    else process.env.CARDTRADER_WEBHOOK_BASE_URL = original;
  }
});
