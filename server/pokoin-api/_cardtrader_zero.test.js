'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  attachPokoinListings,
  attachPowerToolsOrders,
  buildZeroList,
  linkedSourceIds,
  sortForPicking,
  zeroItemRow,
} = require('./_cardtrader_zero');

function item(id, productId, extra = {}) {
  return {
    id,
    product_id: productId,
    blueprint_id: 300000 + id,
    name: `Card ${id}`,
    expansion: 'Stellar Crown',
    quantity: 1,
    seller_price: { cents: 250, currency: 'EUR' },
    properties: { condition: 'Near Mint', pokemon_language: 'en', collector_number: `${id}/142` },
    ...extra,
  };
}

// The Thursday merge: one `paid` Zero order holding the week's items; the
// sources it merged are `closed`; new Zero sales after it are `hub_pending`.
const ORDERS = [
  {
    id: 900,
    code: '20261001-ZERO',
    state: 'paid',
    via_cardtrader_zero: true,
    paid_at: '2026-10-01T06:00:00Z',
    packing_number: 12,
    seller_total: { cents: 750, currency: 'EUR' },
    order_items: [
      item(1, 501, { hub_pending_order_id: 801 }),
      item(2, 502, { hub_pending_order_id: 801, quantity: 2 }),
      item(3, 503, { hub_pending_order_id: 802, deleted_at: '2026-09-30T10:00:00Z' }),
    ],
  },
  { id: 801, state: 'closed', via_cardtrader_zero: true, order_items: [item(1, 501), item(2, 502)] },
  { id: 803, state: 'hub_pending', via_cardtrader_zero: true, order_items: [item(4, 504)] },
  { id: 700, state: 'paid', via_cardtrader_zero: false, order_items: [item(5, 505)] },
];

test('the weekly paid Zero order is the shipment; closed sources and direct orders are ignored', () => {
  const list = buildZeroList(ORDERS);
  assert.equal(list.weekly.length, 1);
  assert.equal(list.weekly[0].orderId, '900');
  assert.equal(list.weekly[0].packingNumber, 12);
  assert.deepEqual(list.weekly[0].items.map((row) => row.itemId), ['1', '2']);
  assert.deepEqual(list.pending.items.map((row) => row.itemId), ['4']);
  assert.equal(list.pending.orderCount, 1);
  assert.deepEqual(list.totals.weekly, { lines: 2, units: 3, cents: 750 });
  assert.deepEqual(list.totals.pending, { lines: 1, units: 1, cents: 250 });
});

test('an order seen twice (paid page + hub_pending page) is counted once', () => {
  const list = buildZeroList([ORDERS[0], ORDERS[0], ORDERS[2]]);
  assert.equal(list.weekly.length, 1);
  assert.equal(list.totals.weekly.units, 3);
});

test('blank CardTrader language and condition stay blank on the picking line', () => {
  const row = zeroItemRow({ id: 1 }, { id: 9, product_id: 5, properties: {} });
  assert.equal(row.language, '');
  assert.equal(row.condition, '');
  const jp = zeroItemRow({ id: 1 }, item(9, 5, {
    properties: { condition: 'Slightly Played', pokemon_language: 'jp', pokemon_reverse: true },
  }));
  assert.equal(jp.language, 'JP');
  assert.equal(jp.condition, 'SP');
  assert.equal(jp.reverse, true);
  assert.equal(jp.cardId, String(300009 * 2));
});

test('Pokoin listings give each line its MyPokoin location', () => {
  const list = buildZeroList(ORDERS);
  assert.deepEqual(linkedSourceIds(list).sort(), ['ct:501', 'ct:502', 'ct:504']);
  attachPokoinListings(list, [
    { id: 'aaaa', card_id: '42', source_listing_id: 'ct:502', location: 'Box 1 · 2 · 7' },
    { id: 'bbbb', card_id: '43', source_listing_id: 'ct:501', location: 'Box 1 · 2 · 10' },
  ]);
  sortForPicking(list);
  const [first, second] = list.weekly[0].items;
  assert.equal(first.itemId, '2', 'natural sort: pos 7 before pos 10');
  assert.equal(first.location, 'Box 1 · 2 · 7');
  assert.equal(first.cardId, '42');
  assert.equal(second.location, 'Box 1 · 2 · 10');
});

test('picking order is the box, then stock numbers from smaller to bigger', () => {
  const list = buildZeroList([{
    id: 900,
    state: 'paid',
    via_cardtrader_zero: true,
    order_items: [
      item(1, 1),
      item(2, 2),
      item(3, 3),
      item(4, 4),
    ],
  }]);
  attachPokoinListings(list, [
    { id: 'a', source_listing_id: 'ct:1', location: 'FUOCOBOMBA 004·47' },
    { id: 'b', source_listing_id: 'ct:2', location: 'FUOCOBOMBA 004·7' },
    { id: 'c', source_listing_id: 'ct:3', location: 'HYPERBEAM BINDER·1' },
    { id: 'd', source_listing_id: 'ct:4', location: 'FUOCOBOMBA 007·1' },
  ]);
  sortForPicking(list);
  assert.deepEqual(list.weekly[0].items.map((row) => row.location), [
    'FUOCOBOMBA 004·7',
    'FUOCOBOMBA 004·47',
    'FUOCOBOMBA 007·1',
    'HYPERBEAM BINDER·1',
  ]);
});

test('lines without any location sort after located lines', () => {
  const list = buildZeroList(ORDERS);
  attachPokoinListings(list, [{ id: 'bbbb', source_listing_id: 'ct:502', location: 'Z9' }]);
  sortForPicking(list);
  assert.deepEqual(list.weekly[0].items.map((row) => row.itemId), ['2', '1']);
});

test('Power Tools state joins by CardTrader order id and order-item id', () => {
  const list = buildZeroList(ORDERS);
  const result = attachPowerToolsOrders(list, [
    {
      source: 'Cardtrader',
      sourceOrderId: '900',
      isCtZeroClosing: true,
      state: { state: 'picking' },
      articles: [
        { sourceArticleId: '1', pickedQuantity: 1, pickingId: '3', locationInfo: { name: 'AA03' } },
        { sourceArticleId: '2', pickedQuantity: 0, locations: [{ name: 'unknown-1', quantity: 2 }] },
      ],
    },
    { source: 'Cardmarket', sourceOrderId: '803', articles: [] },
  ]);
  assert.deepEqual(result, { matchedOrders: 1, matchedItems: 2, ptOrderCount: 1 });
  const [one, two] = list.weekly[0].items;
  assert.deepEqual(one.powerTools, {
    orderState: 'picking',
    isCtZeroClosing: true,
    articleState: '',
    pickedQuantity: 1,
    location: 'AA03',
    bin: '3',
    position: 1,
  });
  assert.equal(two.powerTools.location, '', 'Power Tools "unknown" location is not a place');
  assert.equal(two.powerTools.position, 2);
  const explicit = buildZeroList(ORDERS);
  attachPowerToolsOrders(explicit, [{
    source: 'Cardtrader',
    sourceOrderId: '900',
    articles: [{ sourceArticleId: '1', position: 8 }],
  }]);
  assert.equal(explicit.weekly[0].items[0].powerTools.position, 8);
  const zeroBased = buildZeroList(ORDERS);
  attachPowerToolsOrders(zeroBased, [{
    source: 'Cardtrader',
    sourceOrderId: '900',
    articles: [{ sourceArticleId: '1', pos: 0 }, { sourceArticleId: '2', pos: 3 }],
  }]);
  assert.equal(zeroBased.weekly[0].items[0].powerTools.position, 1);
  assert.equal(zeroBased.weekly[0].items[1].powerTools.position, 4);
  assert.equal(list.pending.items[0].powerTools, null, 'a Cardmarket order never matches a CT order');
});

test('a Power Tools location is used for picking order when Pokoin has none', () => {
  const list = buildZeroList(ORDERS);
  attachPowerToolsOrders(list, [{
    source: 'Cardtrader',
    sourceOrderId: '900',
    articles: [{ sourceArticleId: '2', locationInfo: { name: 'A1' } }],
  }]);
  sortForPicking(list);
  assert.equal(list.weekly[0].items[0].itemId, '2');
});
