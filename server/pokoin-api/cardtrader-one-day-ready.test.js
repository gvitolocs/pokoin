const assert = require('node:assert/strict');
const Module = require('module');
const path = require('node:path');
const test = require('node:test');

// Pi layout: api/ beside server/. Swap the DB and Firebase modules for fakes
// before the sync modules load, so no test can reach a real database.
const dbCalls = [];
let listingsToHide = [];
function fakeQuery(sql, params = []) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  dbCalls.push({ text, params });
  if (text.includes('from public.marketplace_search_candidates')) {
    const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
    return {
      rows: ids.filter(Boolean).map((id) => ({
        card_id: String(id),
        card_name: 'Doduo',
        set_name: 'Evolutions',
        collector_number: '69/108',
        card_image_url: 'https://cdn/doduo.jpg',
      })),
    };
  }
  if (text.startsWith('update public.marketplace_user_listings')) {
    return { rows: listingsToHide };
  }
  if (text.startsWith('delete from public.marketplace_cardtrader_1dr_assets')) {
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}
const serverDir = path.join(__dirname, '..', 'server');
const fakes = {
  '../server/_marketplace_db': {
    marketplaceQuery: async (...a) => fakeQuery(...a),
    marketplaceWriteQuery: async (...a) => fakeQuery(...a),
  },
  '../server/_firebase': {
    getFirebaseAdmin: () => { throw new Error('no firebase in tests'); },
    verifyBearerToken: async () => ({ uid: 'u1' }),
  },
};
const origRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (Object.prototype.hasOwnProperty.call(fakes, id)) return fakes[id];
  return origRequire.apply(this, arguments);
};
for (const [name, exports] of [
  ['_marketplace_db.js', fakes['../server/_marketplace_db']],
  ['_firebase.js', fakes['../server/_firebase']],
]) {
  const file = path.join(serverDir, name);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

const { isOneDayReadyName, normalizeInfo, safeInfoMetadata } = require('./_cardtrader_client');
const { reconcileCardTraderInventory } = require('./_cardtrader_inventory_sync');
const { pushListingToCardTrader } = require('./_cardtrader_seller_listings');
const { assetItem, readAssetsPayload } = require('./cardtrader-assets')._test;
Module.prototype.require = origRequire;

function fakeFirestore(docData = null) {
  const writes = [];
  return {
    writes,
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: Boolean(docData), data: () => docData }),
        set: async (payload, options) => { writes.push({ payload, options }); },
      }),
    }),
  };
}

function mockCardTrader(t, { appName, products }) {
  const original = global.fetch;
  const seen = [];
  t.after(() => { global.fetch = original; });
  global.fetch = async (url) => {
    seen.push(String(url));
    const body = String(url).endsWith('/info')
      ? { shared_secret: 's', name: appName, id: 14299, user_id: 295975 }
      : products;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return seen;
}

const pokemonProduct = {
  id: 111,
  blueprint_id: 122,
  quantity: 2,
  price_cents: 100,
  price_currency: 'EUR',
  game_id: 5,
  name_en: 'Doduo',
  properties_hash: { condition: 'Near Mint', pokemon_language: 'en' },
};
const magicProduct = { id: 222, blueprint_id: 9, quantity: 1, price_cents: 50, game_id: 1, name_en: 'Island' };

test('1-Day Ready app names are recognised', () => {
  assert.equal(isOneDayReadyName('Vitologiuseppe17 1-Day Ready App 20250302165747'), true);
  assert.equal(isOneDayReadyName('Shop 1 Day Ready'), true);
  assert.equal(isOneDayReadyName('One-Day-Ready shop'), true);
  assert.equal(isOneDayReadyName('Pokoin seller app'), false);
  assert.equal(isOneDayReadyName('21 days ready'), false);
  const info = normalizeInfo({ shared_secret: 's', name: 'X 1-Day Ready App 2025', id: 1, user_id: 2 });
  assert.equal(info.oneDayReady, true);
  assert.equal(safeInfoMetadata(info).oneDayReady, true);
  assert.equal(normalizeInfo({ name: 'Normal app' }).oneDayReady, false);
});

test('a 1-Day Ready sync stores assets and hides imported listings — it never creates listings', async (t) => {
  dbCalls.length = 0;
  listingsToHide = [{ id: 'l1', card_id: '244' }, { id: 'l2', card_id: '244' }, { id: 'l3', card_id: '300' }];
  const seen = mockCardTrader(t, { appName: 'Seller 1-Day Ready App 2025', products: [pokemonProduct, magicProduct] });
  const firestore = fakeFirestore();

  const result = await reconcileCardTraderInventory({ firestore, uid: 'u1', token: 'ct_test_token_long_enough' });

  assert.equal(result.ok, true);
  assert.equal(result.oneDayReady, true);
  assert.ok(seen.some((u) => u.endsWith('/info')));
  assert.deepEqual(firestore.writes[0].payload, { metadata: { oneDayReady: true } });
  const texts = dbCalls.map((c) => c.text);
  assert.equal(texts.filter((x) => x.startsWith('insert into public.marketplace_user_listings')).length, 0);
  // Card metadata reads the real candidate columns (name / card_number), so
  // synced cards get their image, set and number.
  const meta = dbCalls.find((c) => c.text.includes('from public.marketplace_search_candidates'));
  assert.match(meta.text, /nullif\(name, ''\)/);
  assert.match(meta.text, /nullif\(card_number, ''\)/);
  assert.doesNotMatch(meta.text, /nullif\(card_name|nullif\(collector_number/);
  const upserts = dbCalls.filter((c) => c.text.startsWith('insert into public.marketplace_cardtrader_1dr_assets'));
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].params[5], 'Evolutions');
  assert.equal(upserts[0].params[7], 'https://cdn/doduo.jpg');
  assert.equal(upserts[0].params[1], '111');
  assert.equal(upserts[0].params[3], '244');
  assert.equal(upserts[0].params[15], 2);
  assert.equal(upserts[0].params[16], 200);
  const remove = dbCalls.find((c) => c.text.startsWith('delete from public.marketplace_cardtrader_1dr_assets'));
  assert.deepEqual(remove.params, ['u1', ['111']]);
  const hide = dbCalls.find((c) => c.text.startsWith('update public.marketplace_user_listings'));
  assert.match(hide.text, /set status = 'inactive'/);
  assert.deepEqual(hide.params, ['u1', 'cardtrader_seller_import']);
  assert.ok(texts.some((x) => x.startsWith('delete from public.marketplace_cardtrader_product_links')));
  const refreshed = dbCalls.filter((c) => c.text.includes('refresh_marketplace_blueprint_price_summary')).map((c) => c.params[0]);
  assert.deepEqual(refreshed, ['244', '300']);
  assert.equal(result.summary.mode, 'one_day_ready');
  assert.equal(result.summary.assets, 1);
  assert.equal(result.summary.assetCards, 2);
  assert.equal(result.summary.assetValuePkn, 400);
  assert.equal(result.summary.hiddenListings, 3);
  assert.equal(result.summary.skippedNonPokemon, 1);
});

test('an unknown account type publishes nothing', async (t) => {
  dbCalls.length = 0;
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => ({ ok: false, status: 500, text: async () => '' });
  const result = await reconcileCardTraderInventory({ firestore: fakeFirestore(), uid: 'u1', token: 'ct_test_token_long_enough' });
  assert.equal(result.ok, false);
  assert.equal(result.incomplete, true);
  assert.equal(dbCalls.filter((c) => /marketplace_user_listings|1dr_assets/.test(c.text)).length, 0);
});

test('a normal CardTrader account keeps the listing import path', async (t) => {
  dbCalls.length = 0;
  mockCardTrader(t, { appName: 'My seller app', products: [pokemonProduct] });
  const firestore = fakeFirestore();
  const result = await reconcileCardTraderInventory({ firestore, uid: 'u1', token: 'ct_test_token_long_enough' });
  assert.equal(result.oneDayReady, undefined);
  assert.deepEqual(firestore.writes[0].payload, { metadata: { oneDayReady: false } });
  assert.equal(dbCalls.filter((c) => c.text.includes('1dr_assets')).length, 0);
  assert.ok(dbCalls.some((c) => c.text.startsWith('insert into public.marketplace_user_listings')));
});

test('Pokoin never pushes a listing into a 1-Day Ready account', async (t) => {
  const original = global.fetch;
  let called = false;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; };
  const firestore = fakeFirestore({ enabled: true, metadata: { oneDayReady: true } });
  await assert.rejects(
    pushListingToCardTrader({ firestore, uid: 'u1', listing: { cardId: '244', pricePkn: 10, quantityAvailable: 1 } }),
    (error) => error.code === 'cardtrader_one_day_ready' && error.statusCode === 409,
  );
  assert.equal(called, false);
});

test('assets payload: disconnected sellers get no assets; rows map to camelCase', async () => {
  const payload = await readAssetsPayload(fakeFirestore(null), 'u1');
  assert.deepEqual(payload, {
    connected: false,
    oneDayReady: false,
    lastSyncAt: null,
    totals: { products: 0, cards: 0, valuePkn: 0 },
    items: [],
  });
  assert.deepEqual(assetItem({ ct_product_id: '1', card_id: '2', card_name: 'Doduo', quantity: '2', price_pkn: '12.5', reverse: true }), {
    ctProductId: '1', cardId: '2', cardName: 'Doduo', setName: '', collectorNumber: '', imageUrl: '',
    condition: '', language: '', reverse: true, firstEdition: false, signed: false, altered: false, graded: false,
    quantity: 2, pricePkn: null,
  });
});

