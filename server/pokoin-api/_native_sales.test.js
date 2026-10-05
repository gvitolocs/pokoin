'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFirestore } = require('./_firestore_fake');
const {
  publicSaleRow,
  recordNativeSales,
  saleDocsFromOrder,
  sellerCardTraderRow,
  sellerHistoryRow,
  sellerShare,
} = require('./_native_sales');
const { _test: salesEndpoint } = require('./marketplace-native-sales');

const eurOrder = {
  currency: 'EUR',
  paymentMethod: 'stripe',
  paymentStatus: 'paid',
  buyerUid: 'buyer1',
  buyerEmail: 'buyer@example.com',
  items: [
    {
      listingId: '3868b36c', sellerUid: 's1', sellerName: 'redshakkio', quantity: 1,
      unitPricePkn: 20, unitPriceEURCents: 10, condition: 'LP', language: 'IT', card: { id: '713650', name: 'Mimikyu' },
    },
  ],
  shipments: [{ sellerId: 's1', itemsSubtotalCents: 10, shippingAmountEURCents: 400 }],
};

test('sale rows are one per paid order line and never carry the buyer', () => {
  const rows = saleDocsFromOrder('eur_1', eurOrder);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'eur_1__3868b36c');
  assert.equal(rows[0].data.cardId, '713650');
  assert.equal(rows[0].data.currency, 'EUR');
  assert.equal(rows[0].data.source, 'pokoin');
  assert.equal(JSON.stringify(rows[0].data).includes('buyer'), false);
});

test('recording twice keeps one row per line', async () => {
  const { admin, firestore } = createFirestore();
  await recordNativeSales({ admin, firestore, orderId: 'eur_1', order: eurOrder });
  await recordNativeSales({ admin, firestore, orderId: 'eur_1', order: eurOrder });
  assert.equal(firestore.all('marketplace_sales').length, 1);
});

test('EUR seller share is the parcel (items + shipping); PKN is the item total', () => {
  assert.equal(sellerShare(eurOrder, 's1').gross, 410);
  const pkn = { paymentStatus: 'escrow', items: [{ sellerUid: 's1', quantity: 2, unitPricePkn: 500 }] };
  assert.equal(sellerShare(pkn, 's1').gross, 1000);
  assert.equal(sellerShare({ ...pkn, refunds: [{ sellerUid: 's1', amount: 300, status: 'succeeded' }] }, 's1').refundable, 700);
  assert.equal(sellerShare({ ...pkn, refunds: [{ sellerUid: 's1', amount: 300, status: 'failed' }] }, 's1').refundable, 1000);
});

test('seller history shows only that seller lines', () => {
  const order = {
    ...eurOrder,
    items: [...eurOrder.items, { listingId: 'x', sellerUid: 's2', quantity: 1, unitPriceEURCents: 999, card: { id: '1' } }],
  };
  const row = sellerHistoryRow('eur_1', order, 's1');
  assert.equal(row.items.length, 1);
  assert.equal(row.refundable, 410);
});

test('CardTrader sales show in seller history but are not refundable here', () => {
  const row = sellerCardTraderRow('ct_1__2', {
    orderId: 'ct_1', cardName: 'Arbok', quantity: 1, unitPriceEURCents: 267, ctOrderState: 'hub_pending',
  });
  assert.equal(row.source, 'cardtrader');
  assert.equal(row.gross, 267);
  assert.equal(row.refundable, 0);
  assert.equal(row.channel, '');
  const ready = sellerCardTraderRow('ct_2__3', { channel: '1dr', cardName: 'Switch', quantity: 1, unitPriceEURCents: 2 });
  assert.equal(ready.channel, '1dr');
  assert.equal(ready.source, 'cardtrader');
});

test('desk endpoint keeps only live native sales, newest first', () => {
  const docs = [
    { data: () => ({ soldAt: '2026-09-20T00:00:00Z', quantity: 1, unitPricePkn: 20, source: 'pokoin' }) },
    { data: () => ({ soldAt: '2026-09-28T00:00:00Z', quantity: 1, unitPricePkn: 25, source: 'pokoin' }) },
    { data: () => ({ soldAt: '2026-09-27T00:00:00Z', quantity: 1, unitPricePkn: 30, voided: true }) },
    { data: () => ({ soldAt: '2026-09-27T00:00:00Z', quantity: 1, unitPriceEURCents: 267, source: 'cardtrader', currency: 'EUR' }) },
  ];
  const rows = salesEndpoint.nativeSalesFromDocs(docs, 10);
  assert.deepEqual(rows.map((row) => row.unitPricePkn), [25, 20]);
  assert.equal(salesEndpoint.cleanCardId('713650'), '713650');
  assert.equal(salesEndpoint.cleanCardId('../x'), '');
  assert.equal(publicSaleRow({ currency: 'EUR', unitPriceEURCents: 10, quantity: 1 }).unitPriceEURCents, 10);
});
