'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const core = require('./_poko_personal_context');
const {
  cleanCartItems,
  cleanDesk,
  normalizeCardIds,
  formatPersonalIntent,
} = core._test;

test('normalizeCardIds dedupes and caps', () => {
  assert.deepEqual(normalizeCardIds(['1', '1', '2', 'x', 0, -3], 2), [1, 2]);
});

test('cleanCartItems keeps purchasable lines only', () => {
  const rows = cleanCartItems([
    { cardId: '10', name: 'Pikachu', qty: 2, pricePkn: 100, sellerName: 'A' },
    { cardId: '11', qty: 0, pricePkn: 50 },
    { cardId: 'bad', qty: 1 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cardId, '10');
  assert.equal(rows[0].qty, 2);
});

test('cleanDesk accepts pageContext aliases', () => {
  assert.deepEqual(
    cleanDesk({ deskCardId: '246912', deskCardName: 'Noivern V', deskSetName: 'ES' }),
    { cardId: '246912', name: 'Noivern V', setName: 'ES' },
  );
});

test('formatPersonalIntent covers desk cart watchlist inventory collection', () => {
  const text = formatPersonalIntent({
    desk: { cardId: '1', name: 'Mew', setName: 'Base' },
    recents: [{ cardId: '2', name: 'Mewtwo', setName: 'Fossil' }],
    watchlist: [{ cardId: '3', name: 'Raichu' }],
    cart: [{ cardId: '4', name: 'Pikachu', qty: 1, pricePkn: 50 }],
    inventory: {
      listingCount: 2,
      quantity: 5,
      samples: [{ cardId: '9', name: 'Zapdos', qty: 2, pricePkn: 200 }],
    },
    collection: { cardsOwned: 12, physicalOwned: 10, nftOwned: 2, items: 8 },
  });
  assert.match(text, /Open desk: Mew/);
  assert.match(text, /Recently seen/);
  assert.match(text, /Watchlist/);
  assert.match(text, /Cart \(1 lines/);
  assert.match(text, /Selling inventory: 2 listings/);
  assert.match(text, /Collection: 12 cards/);
  assert.equal(formatPersonalIntent({}), '');
});

test('buildPersonalContext merges overlay over snapshot and hydrates names', async () => {
  const queries = [];
  const personal = await core.buildPersonalContext({
    uid: 'fb-1',
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/marketplace_user_recents/.test(sql)) {
        return { rows: [{ card_ids: [100, 101] }] };
      }
      if (/count\(\*\)::int as listing_count/.test(sql)) {
        return { rows: [{ listing_count: 1, quantity: 3 }] };
      }
      if (/from public.marketplace_user_listings/.test(sql) && /limit/.test(sql)) {
        return {
          rows: [{
            card_id: '200',
            card_name: 'Listed Bird',
            set_name: 'Fossil',
            quantity_available: 3,
            price_pkn: 400,
            condition: 'NM',
            language: 'EN',
            status: 'active',
          }],
        };
      }
      if (/poko_user_personal_snapshot/.test(sql) && /select/.test(sql)) {
        return {
          rows: [{
            watchlist_card_ids: [50],
            cart_items: [{ cardId: '60', name: 'Old Cart', qty: 1, pricePkn: 10 }],
            desk_card_id: 70,
            desk_card_name: 'Old Desk',
            desk_set_name: 'Base',
            updated_at: '2026-09-28',
          }],
        };
      }
      if (/marketplace_search_candidates/.test(sql)) {
        return {
          rows: [
            { id: '100', name: 'Recent A', set_name: 'Set A' },
            { id: '80', name: 'Watch New', set_name: 'Set W' },
          ],
        };
      }
      return { rows: [] };
    },
    writeQuery: async () => ({ rows: [] }),
    summarizeOwnedCollection: async () => ({
      cardsOwned: 4,
      items: 3,
      physicalOwned: 4,
      nftOwned: 0,
    }),
    firestore: {},
    overlay: {
      watchlistIds: [80],
      cart: [{ cardId: '90', name: 'Fresh Cart', qty: 2, pricePkn: 25 }],
      desk: { cardId: '246912', name: 'Noivern V', setName: 'ES' },
    },
    persistOverlay: false,
  });

  assert.equal(personal.desk.cardId, '246912');
  assert.equal(personal.watchlist[0].cardId, '80');
  assert.equal(personal.watchlist[0].name, 'Watch New');
  assert.equal(personal.cart[0].cardId, '90');
  assert.equal(personal.recents[0].name, 'Recent A');
  assert.equal(personal.inventory.listingCount, 1);
  assert.equal(personal.collection.cardsOwned, 4);
  assert.ok(queries.some((q) => /marketplace_user_recents/.test(q.sql)));
});

test('handler rejects unauth and serves service get', async () => {
  process.env.POKONTACT_SERVICE_TOKEN = 'svc-token';
  const TARGET = path.resolve(__dirname, 'poko-personal-context.js');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (String(request).includes('_marketplace_db')) {
      return {
        marketplaceQuery: async (sql) => {
          if (/marketplace_user_recents/.test(sql)) return { rows: [{ card_ids: [] }] };
          if (/listing_count/.test(sql)) return { rows: [{ listing_count: 0, quantity: 0 }] };
          if (/marketplace_user_listings/.test(sql)) return { rows: [] };
          if (/poko_user_personal_snapshot/.test(sql)) return { rows: [] };
          if (/marketplace_search_candidates/.test(sql)) return { rows: [] };
          return { rows: [] };
        },
        marketplaceWriteQuery: async () => ({ rows: [] }),
      };
    }
    if (String(request).includes('_firebase')) {
      return {
        verifyBearerToken: async () => {
          const err = new Error('no');
          err.statusCode = 401;
          throw err;
        },
        authErrorResponse: () => ({ statusCode: 401, body: { error: 'unauthorized' } }),
        getFirebaseAdmin: () => ({ firestore: () => ({}) }),
      };
    }
    if (String(request).includes('_user_card_collection')) {
      return { summarizeOwnedCollection: async () => ({ cardsOwned: 0, items: 0, physicalOwned: 0, nftOwned: 0 }) };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[TARGET];
  const handler = require(TARGET);
  Module._load = originalLoad;

  const unauth = {
    statusCode: 0,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ method: 'POST', headers: {}, body: { action: 'get' } }, unauth);
  assert.equal(unauth.statusCode, 401);

  const ok = {
    statusCode: 0,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer svc-token' },
    body: { action: 'get', firebaseUid: 'fb-9' },
  }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.ok, true);
  assert.ok(ok.body.personal);
});
