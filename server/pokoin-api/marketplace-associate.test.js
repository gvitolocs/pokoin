'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const path = require('node:path');

const TARGET = path.resolve(__dirname, 'marketplace-associate.js');

const DISTRIBUTOR_ROW = {
  email: 'gianlonji@gmail.com',
  role: 'distributor',
  display_name: 'Gianlonji',
  share_pct: 100,
  royalty_pct: 3,
  window_start: new Date('2026-09-29T00:00:00Z'),
  window_end: new Date('2026-10-31T23:59:59Z'),
  active: true,
};

const AMBASSADOR_ROW = {
  ...DISTRIBUTOR_ROW,
  email: 'apciliberti@gmail.com',
  role: 'ambassador',
  display_name: 'Apciliberti',
};

function orderDoc(id, data) {
  return {
    id,
    data: () => ({
      createdAt: { toMillis: () => Date.parse('2026-10-02T12:00:00Z') },
      ...data,
    }),
  };
}

function firestoreStub(docs) {
  const builder = {
    collection() {
      return builder;
    },
    where() {
      return builder;
    },
    orderBy() {
      return builder;
    },
    limit() {
      return builder;
    },
    async get() {
      return { docs };
    },
  };
  return builder;
}

function loadHandler({ rows = [], docs = [], listingRows = [], decoded } = {}) {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db') {
      return {
        marketplaceQuery: async (sql, params) => {
          if (/marketplace_associates/.test(sql)) {
            return { rows: rows.filter((row) => row.email === params[0]) };
          }
          return { rows: listingRows };
        },
      };
    }
    if (request === './_firebase') {
      return {
        verifyBearerToken: async () => decoded,
        getFirebaseAdmin: () => ({ firestore: () => firestoreStub(docs) }),
        authErrorResponse: (error) => ({
          statusCode: error.statusCode || 401,
          body: { error: error.message },
        }),
      };
    }
    if (request === './_marketplace_react_card') {
      return {
        parsePublicCardId: (value) => String(value || '').trim(),
        setCorsHeaders: (res) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(TARGET);
  } finally {
    Module._load = originalLoad;
    delete require.cache[TARGET];
  }
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
  return res;
}

function mockReq() {
  return { method: 'GET', url: '/api/marketplace-associate', headers: { authorization: 'Bearer tok' } };
}

const IT_TO_IT_EUR = orderDoc('ord_it_it', {
  currency: 'EUR',
  paymentMethod: 'stripe',
  paymentStatus: 'paid',
  buyerEmail: 'mario.rossi@gmail.com',
  shippingAddressCountryCode: 'IT',
  itemsSubtotalCents: 20000,
  totalEURCents: 20600,
  sellerUids: ['seller_a'],
  shipments: [{ sellerId: 'seller_a', fromCountry: 'IT', toCountry: 'IT' }],
  items: [{ sellerUid: 'seller_a', totalPricePkn: 200 }],
});

const IT_TO_FR = orderDoc('ord_it_fr', {
  currency: 'EUR',
  paymentMethod: 'stripe',
  paymentStatus: 'paid',
  buyerEmail: 'hans.de@yahoo.de',
  shippingAddressCountryCode: 'DE',
  itemsSubtotalCents: 50000,
  totalEURCents: 51500,
  sellerUids: ['seller_a'],
  shipments: [{ sellerId: 'seller_a', fromCountry: 'IT', toCountry: 'DE' }],
  items: [{ sellerUid: 'seller_a', totalPricePkn: 500 }],
});

const FR_TO_IT = orderDoc('ord_fr_it', {
  currency: 'EUR',
  paymentMethod: 'stripe',
  paymentStatus: 'paid',
  buyerEmail: 'buyer.it@gmail.com',
  shippingAddressCountryCode: 'IT',
  itemsSubtotalCents: 30000,
  totalEURCents: 30900,
  sellerUids: ['seller_fr'],
  shipments: [{ sellerId: 'seller_fr', fromCountry: 'FR', toCountry: 'IT' }],
  items: [{ sellerUid: 'seller_fr', totalPricePkn: 300 }],
});

const PKN_ESCROW = orderDoc('ord_pkn_escrow', {
  paymentStatus: 'escrow',
  status: 'escrow',
  buyerEmail: 'buyer2@gmail.com',
  subtotalPkn: 1000,
  totalPkn: 1030,
  sellerUids: ['seller_b'],
  items: [{ sellerUid: 'seller_b', totalPricePkn: 1000 }],
});

const CANCELLED = orderDoc('ord_cancelled', {
  currency: 'EUR',
  paymentStatus: 'cancelled',
  status: 'cancelled',
  shippingAddressCountryCode: 'IT',
  itemsSubtotalCents: 9900,
  sellerUids: ['seller_a'],
  shipments: [{ sellerId: 'seller_a', fromCountry: 'IT', toCountry: 'IT' }],
});

const REFUNDED_FULL = orderDoc('ord_refunded', {
  currency: 'EUR',
  paymentStatus: 'paid',
  shippingAddressCountryCode: 'IT',
  itemsSubtotalCents: 10000,
  totalEURCents: 10300,
  refundedTotal: 10300,
  sellerUids: ['seller_a'],
  shipments: [{ sellerId: 'seller_a', fromCountry: 'IT', toCountry: 'IT' }],
});

test('non-associates are rejected with 403', async () => {
  const handler = loadHandler({ rows: [], decoded: { uid: 'u1', email: 'stranger@gmail.com' } });
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.associate, null);
});

test('distributor sees 100% of the 3% royalty pool on IT→IT sales only', async () => {
  const handler = loadHandler({
    rows: [DISTRIBUTOR_ROW],
    decoded: { uid: 'u1', email: 'Gianlonji@gmail.com' },
    docs: [IT_TO_IT_EUR, IT_TO_FR, FR_TO_IT, CANCELLED, REFUNDED_FULL],
  });
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.associate.role, 'distributor');
  assert.equal(res.body.associate.sharePct, 100);
  assert.equal(res.body.associate.royaltyPct, 3);
  assert.equal(res.body.window.daysRemaining > 0, true);

  // Only ord_it_it counts: 200€ subtotal → 6€ royalty → 6€ at 100% share.
  // The fully refunded order nets to zero and is dropped.
  assert.equal(res.body.earnings.qualifyingOrders, 1);
  assert.equal(res.body.earnings.grossEurCents, 20000);
  assert.equal(res.body.earnings.royaltyEurCents, 600);
  assert.equal(res.body.earnings.earningEurCents, 600);
  assert.equal(res.body.earnings.orders[0].orderId, 'ord_it_it');
  assert.equal(res.body.earnings.orders[0].buyer, 'm*****@gmail.com');
});

test('seller country falls back to the listing rows when the order has no shipments', async () => {
  const stripeOrderNoShipments = orderDoc('ord_eur_noship', {
    currency: 'EUR',
    paymentMethod: 'stripe',
    paymentStatus: 'paid',
    buyerEmail: 'buyer3@gmail.com',
    shippingAddressCountryCode: 'IT',
    itemsSubtotalCents: 40000,
    totalEURCents: 41200,
    sellerUids: ['seller_b'],
    items: [{ sellerUid: 'seller_b', totalPricePkn: 400 }],
  });
  const handler = loadHandler({
    rows: [DISTRIBUTOR_ROW],
    decoded: { uid: 'u1', email: 'gianlonji@gmail.com' },
    docs: [stripeOrderNoShipments],
    listingRows: [{ seller_uid: 'seller_b', seller_country: 'it' }],
  });
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.earnings.qualifyingOrders, 1);
  assert.equal(res.body.earnings.grossEurCents, 40000);
  assert.equal(res.body.earnings.royaltyEurCents, 1200);
  assert.equal(res.body.earnings.earningEurCents, 1200);
});

test('PKN escrow orders without a shipping country stay unverified, never guessed', async () => {
  const handler = loadHandler({
    rows: [DISTRIBUTOR_ROW],
    decoded: { uid: 'u1', email: 'gianlonji@gmail.com' },
    docs: [PKN_ESCROW],
    listingRows: [{ seller_uid: 'seller_b', seller_country: 'IT' }],
  });
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.earnings.unverifiedOrders, 1);
  assert.equal(res.body.earnings.qualifyingOrders, 0);
  assert.equal(res.body.earnings.earningPkn, 0);
});

test('unknown buyer or seller country lands in unverified, never in the pool', async () => {
  const noSellerCountry = orderDoc('ord_unknown_seller', {
    paymentStatus: 'paid',
    shippingAddressCountryCode: 'IT',
    subtotalPkn: 500,
    sellerUids: ['seller_ghost'],
  });
  const noBuyerCountry = orderDoc('ord_unknown_buyer', {
    paymentStatus: 'paid',
    subtotalPkn: 500,
    sellerUids: ['seller_a'],
    shipments: [{ sellerId: 'seller_a', fromCountry: 'IT' }],
  });
  const handler = loadHandler({
    rows: [DISTRIBUTOR_ROW],
    decoded: { uid: 'u1', email: 'gianlonji@gmail.com' },
    docs: [noSellerCountry, noBuyerCountry],
  });
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.earnings.unverifiedOrders, 2);
  assert.equal(res.body.earnings.qualifyingOrders, 0);
  assert.equal(res.body.earnings.earningPkn, 0);
});

test('ambassador gets the ambassador row and its own terms', async () => {
  const handler = loadHandler({
    rows: [AMBASSADOR_ROW],
    decoded: { uid: 'u2', email: 'apciliberti@gmail.com' },
    docs: [IT_TO_IT_EUR],
  });
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.associate.role, 'ambassador');
  assert.equal(res.body.associate.displayName, 'Apciliberti');
  assert.equal(res.body.earnings.earningEurCents, 600);
});

test('windowProgress clamps inside the campaign', () => {
  const { windowProgress } = loadHandler()._test;
  const start = '2026-09-29T00:00:00Z';
  const end = '2026-10-31T23:59:59Z';
  const before = windowProgress(start, end, Date.parse('2026-09-01T00:00:00Z'));
  const inside = windowProgress(start, end, Date.parse('2026-10-15T12:00:00Z'));
  const after = windowProgress(start, end, Date.parse('2026-12-01T00:00:00Z'));
  assert.equal(before.live, false);
  assert.equal(before.daysRemaining, 33);
  assert.equal(inside.live, true);
  assert.equal(after.live, false);
  assert.equal(after.daysRemaining, 0);
});

test('classifyOrder drops unpaid orders and counts partial refunds pro rata', () => {
  const { classifyOrder, orderSubtotal } = loadHandler()._test;
  const italy = new Map([['seller_a', 'IT']]);
  assert.equal(classifyOrder({ paymentStatus: 'pending_stripe', shippingAddressCountryCode: 'IT', sellerUids: ['seller_a'] }, italy), null);

  const partial = {
    currency: 'EUR',
    paymentMethod: 'stripe',
    paymentStatus: 'paid',
    shippingAddressCountryCode: 'IT',
    itemsSubtotalCents: 10000,
    totalEURCents: 10300,
    refundedTotal: 5150,
    sellerUids: ['seller_a'],
    shipments: [{ sellerId: 'seller_a', fromCountry: 'IT' }],
  };
  const verdict = classifyOrder(partial, italy);
  assert.equal(verdict.qualifying, true);
  assert.equal(orderSubtotal(partial), 5000);
});

test('maskEmail keeps the first letter and hides the rest', () => {
  const { maskEmail } = loadHandler()._test;
  assert.equal(maskEmail('mario.rossi@gmail.com'), 'm*****@gmail.com');
  assert.equal(maskEmail('a@b.co'), 'a**@b.co');
  assert.equal(maskEmail(''), 'hidden');
});
