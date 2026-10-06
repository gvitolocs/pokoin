import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GCR_MERCHANT_ID,
  GCR_SCRIPT_SRC,
  estimatedDeliveryDate,
  gcrStorageKey,
  optInFields,
  showReviewsOptIn,
} from './google-reviews.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.hasOwn(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
  };
}

function fakeDocument() {
  const scripts = [];
  return {
    scripts,
    head: {
      appendChild(node) {
        scripts.push(node);
      },
    },
    createElement(tagName) {
      return { tagName };
    },
    querySelector(selector) {
      const match = /^script\[src="(.*)"\]$/.exec(selector);
      const src = match ? match[1] : '';
      return scripts.some((row) => row.src === src) ? { src } : null;
    },
  };
}

function loadedGapi(calls) {
  return {
    load(name, done) {
      calls.push({ load: name });
      done();
    },
    surveyoptin: {
      render(payload) {
        calls.push({ render: payload });
      },
    },
  };
}

const VALID = {
  orderId: 'ord-1',
  email: 'buyer@example.com',
  deliveryCountry: 'it',
  estimatedDelivery: '2026-01-08',
};

test('domestic shipments estimate 7 days, cross-border and missing data 14', () => {
  const orderedAt = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(
    estimatedDeliveryDate({ orderedAt, shipments: [{ fromCountry: 'IT' }], toCountry: 'IT' }),
    '2026-01-08',
  );
  assert.equal(
    estimatedDeliveryDate({ orderedAt, shipments: [{ fromCountry: 'it' }], toCountry: 'IT' }),
    '2026-01-08',
  );
  assert.equal(
    estimatedDeliveryDate({
      orderedAt,
      shipments: [{ fromCountry: 'IT' }, { fromCountry: 'DE' }],
      toCountry: 'IT',
    }),
    '2026-01-15',
  );
  assert.equal(
    estimatedDeliveryDate({ orderedAt, shipments: [{ fromCountry: 'DE' }], toCountry: 'IT' }),
    '2026-01-15',
  );
  assert.equal(estimatedDeliveryDate({ orderedAt, toCountry: 'IT' }), '2026-01-15');
});

test('Firestore-like timestamps are accepted', () => {
  const ms = Date.UTC(2026, 0, 1);
  assert.equal(
    estimatedDeliveryDate({
      orderedAt: { toMillis: () => ms },
      shipments: [{ fromCountry: 'IT' }],
      toCountry: 'IT',
    }),
    '2026-01-08',
  );
  assert.equal(
    estimatedDeliveryDate({
      orderedAt: { seconds: ms / 1000 },
      shipments: [{ fromCountry: 'DE' }],
      toCountry: 'IT',
    }),
    '2026-01-15',
  );
  assert.equal(estimatedDeliveryDate({ orderedAt: new Date(ms) }), '2026-01-15');
});

test('the estimate rolls over months and years', () => {
  assert.equal(
    estimatedDeliveryDate({
      orderedAt: Date.UTC(2026, 11, 28),
      shipments: [{ fromCountry: 'IT' }],
      toCountry: 'IT',
    }),
    '2027-01-04',
  );
  assert.equal(
    estimatedDeliveryDate({ orderedAt: Date.UTC(2026, 11, 28), shipments: [] }),
    '2027-01-11',
  );
});

test('an invalid orderedAt falls back to now', () => {
  const today = estimatedDeliveryDate({ orderedAt: Date.now(), shipments: [] });
  const broken = estimatedDeliveryDate({ orderedAt: 'not-a-date', shipments: [] });
  assert.match(broken, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Math.abs(new Date(broken).getTime() - new Date(today).getTime()) <= DAY_MS);
});

test('optInFields builds the numeric merchant payload and uppercases the country', () => {
  const fields = optInFields(VALID);
  assert.equal(fields.merchant_id, 5869935257);
  assert.equal(typeof fields.merchant_id, 'number');
  assert.equal(fields.merchant_id, GCR_MERCHANT_ID);
  assert.equal(fields.order_id, 'ord-1');
  assert.equal(fields.email, 'buyer@example.com');
  assert.equal(fields.delivery_country, 'IT');
  assert.equal(fields.estimated_delivery_date, '2026-01-08');
  assert.equal(fields.products, undefined);
});

test('optInFields rejects each missing or malformed field', () => {
  assert.equal(optInFields({ ...VALID, orderId: '' }), null);
  assert.equal(optInFields({ ...VALID, orderId: '   ' }), null);
  assert.equal(optInFields({ ...VALID, email: '' }), null);
  assert.equal(optInFields({ ...VALID, email: 'buyer.example.com' }), null);
  assert.equal(optInFields({ ...VALID, deliveryCountry: 'I' }), null);
  assert.equal(optInFields({ ...VALID, deliveryCountry: 'ITA' }), null);
  assert.equal(optInFields({ ...VALID, deliveryCountry: '' }), null);
  assert.equal(optInFields({ ...VALID, estimatedDelivery: '2026-1-8' }), null);
  assert.equal(optInFields({ ...VALID, estimatedDelivery: 'tomorrow' }), null);
  assert.equal(optInFields({}), null);
  assert.equal(optInFields(), null);
});

test('showReviewsOptIn injects one platform.js script and remembers the order', () => {
  const win = {};
  const doc = fakeDocument();
  const storage = memoryStore();
  const fields = optInFields(VALID);

  assert.equal(showReviewsOptIn(fields, { win, doc, storage }), true);
  assert.equal(doc.scripts.length, 1);
  assert.equal(doc.scripts[0].src, GCR_SCRIPT_SRC);
  assert.equal(doc.scripts[0].async, true);
  assert.equal(doc.scripts[0].defer, true);
  assert.equal(doc.scripts[0].src, 'https://apis.google.com/js/platform.js?onload=__pokoinRenderGcrOptIn');
  assert.equal(storage.getItem(gcrStorageKey('ord-1')), '1');
  assert.equal(typeof win.__pokoinRenderGcrOptIn, 'function');

  // Same order again: nothing new, and no second script tag.
  assert.equal(showReviewsOptIn(fields, { win, doc, storage }), false);
  assert.equal(doc.scripts.length, 1);
});

test('the script onload callback renders the fields through gapi', () => {
  const calls = [];
  const win = { gapi: loadedGapi(calls) };
  const doc = fakeDocument();
  const storage = memoryStore();
  const fields = optInFields(VALID);

  showReviewsOptIn(fields, { win, doc, storage });
  win.__pokoinRenderGcrOptIn();

  assert.deepEqual(calls[0], { load: 'surveyoptin' });
  assert.deepEqual(calls[1], { render: fields });
});

test('a later order with gapi already loaded renders without a second script', () => {
  const calls = [];
  const win = {};
  const doc = fakeDocument();
  const storage = memoryStore();
  const first = optInFields(VALID);
  const second = optInFields({ ...VALID, orderId: 'ord-2', deliveryCountry: 'DE' });

  showReviewsOptIn(first, { win, doc, storage });
  assert.equal(doc.scripts.length, 1);

  win.gapi = loadedGapi(calls);
  assert.equal(showReviewsOptIn(second, { win, doc, storage }), true);
  assert.equal(doc.scripts.length, 1);
  assert.deepEqual(calls, [{ load: 'surveyoptin' }, { render: second }]);
});

test('invalid fields are a no-op', () => {
  const win = {};
  const doc = fakeDocument();
  const storage = memoryStore();
  assert.equal(showReviewsOptIn(null, { win, doc, storage }), false);
  assert.equal(doc.scripts.length, 0);
  assert.equal(storage.getItem(gcrStorageKey('ord-1')), null);
});

test('storage that throws does not crash the opt-in', () => {
  const win = {};
  const doc = fakeDocument();
  const storage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(showReviewsOptIn(optInFields(VALID), { win, doc, storage }), true);
  assert.equal(doc.scripts.length, 1);
});
