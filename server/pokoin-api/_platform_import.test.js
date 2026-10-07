'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createFirestore } = require('./_firestore_fake');
const {
  COLLECTION,
  integrationDocId,
  patchIntegration,
} = require('./_platform_integration');
const {
  linkAndImportInventory,
  enqueueLinkAndImport,
  isImportRunning,
} = require('./_platform_import');

// ---------------------------------------------------------------------------
// Harness: fake Firestore + query executor + adapter double.
// ---------------------------------------------------------------------------

const UID = 'seller-1';
const PROVIDER = 'cardmarket';

function createHarness({
  provider = PROVIDER,
  listings = [],
  existingBySource = [],
  items = [],
  complete = true,
  enabled = true,
  integrationExists = true,
} = {}) {
  const { admin, firestore } = createFirestore();

  if (integrationExists) {
    const ref = firestore.collection(COLLECTION).doc(integrationDocId(UID, provider));
    ref.set({
      uid: UID,
      provider,
      userEmail: 'seller@example.com',
      enabled,
      state: 'connected',
      metadata: {},
      encryptedSecrets: {},
    });
  }

  const state = {
    sql: [],
    params: [],
    links: [],
    patches: [],
    resolveCalls: [],
    insertCalls: [],
    adapterCalls: 0,
  };

  const query = async (sql, params = []) => {
    state.sql.push(sql);
    state.params.push(params);
    if (/marketplace_user_listings[\s\S]*seller_uid = \$1[\s\S]*status in/.test(sql)) {
      return { rows: listings };
    }
    if (/marketplace_user_listings[\s\S]*source = \$2 and source_listing_id = \$3/.test(sql)) {
      const match = existingBySource.find(
        (row) => row.source === params[1] && row.sourceListingId === params[2],
      );
      return { rows: match ? [{ id: match.id }] : [] };
    }
    if (/marketplace_cards/.test(sql)) {
      return { rows: [] };
    }
    if (/insert into public.marketplace_user_listings/.test(sql)) {
      return { rows: [{ id: `new_${state.sql.length}`, card_id: 'c1', location: 'EU' }] };
    }
    if (/marketplace_platform_links/.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  };

  const adapter = {
    async listInventory(ctx) {
      state.adapterCalls += 1;
      state.lastCtx = ctx;
      return { complete, items };
    },
  };

  const deps = {
    query,
    getAdapter: (id) => (id === PROVIDER ? adapter : null),
    patchIntegration: async (fs, uid, provider, patch) => {
      state.patches.push({ ...patch });
      await patchIntegration(fs, uid, provider, patch);
    },
    resolveCard: async (row) => {
      state.resolveCalls.push({ ...row });
      const named = row.name;
      if (named === 'Not In Catalog') return { error: `No catalog match for ${named}` };
      if (named === 'Ambiguous Card') {
        return {
          error: 'Ambiguous match',
          candidates: [
            { cardId: '1', setName: 'A' },
            { cardId: '2', setName: 'B' },
          ],
        };
      }
      return {
        cardId: `card_${named.replace(/\s+/g, '_').toLowerCase()}`,
        cardName: named,
        setName: row.setName,
        collectorNumber: row.collectorNumber,
        imageUrl: 'https://cdn.example/x.jpg',
      };
    },
    insertListing: async (seller, row, resolved, opts) => {
      state.insertCalls.push({ seller, row, resolved, opts });
      return { created: true, id: `new_${state.insertCalls.length}`, cardId: resolved.cardId };
    },
    upsertLink: async (payload) => {
      state.links.push({ ...payload });
      return { ...payload };
    },
  };

  return { admin, firestore, deps, state, provider };
}

function args(harness, provider = harness.provider) {
  return {
    provider,
    uid: UID,
    firestore: harness.firestore,
    deps: harness.deps,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('unknown provider is rejected', async () => {
  const harness = createHarness();
  await assert.rejects(
    () => linkAndImportInventory({ ...args(harness), provider: 'nope' }),
    (error) => error.statusCode === 400 && /Unknown provider/.test(error.message),
  );
});

test('missing uid is rejected', async () => {
  const harness = createHarness();
  await assert.rejects(
    () => linkAndImportInventory({ ...args(harness), uid: '  ' }),
    (error) => error.statusCode === 400 && /Missing seller uid/.test(error.message),
  );
});

test('missing integration is rejected', async () => {
  const harness = createHarness({ integrationExists: false });
  await assert.rejects(
    () => linkAndImportInventory(args(harness)),
    (error) => error.statusCode === 400 && /No integration/.test(error.message),
  );
});

test('disabled integration is rejected', async () => {
  const harness = createHarness({ enabled: false });
  await assert.rejects(
    () => linkAndImportInventory(args(harness)),
    (error) => error.statusCode === 400 && /disabled/.test(error.message),
  );
});

test('incomplete adapter read fails the job', async () => {
  const harness = createHarness({ complete: false, items: [] });
  await assert.rejects(
    () => linkAndImportInventory(args(harness)),
    (error) => error.statusCode === 502 && /Incomplete/.test(error.message),
  );
});

test('zero-quantity items are skipped', async () => {
  const harness = createHarness({
    items: [
      { externalId: 'a1', name: 'Pikachu', quantity: 0, condition: 'NM' },
      { externalId: 'a2', name: 'Charizard', quantity: 2, condition: 'NM', priceCents: 15000, currency: 'EUR' },
    ],
  });
  const summary = await linkAndImportInventory(args(harness));
  assert.equal(summary.processed, 2);
  assert.equal(summary.total, 2);
  assert.equal(summary.linked, 1);
  assert.equal(summary.imported, 1);
  assert.equal(summary.unmatched, 0);
  assert.equal(summary.complete, true);
  assert.equal(harness.state.insertCalls.length, 1);
  assert.equal(harness.state.links.length, 1);
  assert.equal(harness.state.links[0].matchMethod, 'import');
});

test('SKU match links the existing listing without importing', async () => {
  const harness = createHarness({
    listings: [
      { id: 'lst-1', source_listing_id: null, status: 'active', quantity_available: 3 },
    ],
    items: [
      { externalId: 'a1', sku: 'lst-1', name: 'Pikachu', quantity: 3, condition: 'NM' },
    ],
  });
  const summary = await linkAndImportInventory(args(harness));
  assert.equal(summary.linked, 1);
  assert.equal(summary.imported, 0);
  assert.equal(summary.unmatched, 0);
  assert.equal(harness.state.insertCalls.length, 0);
  assert.deepEqual(harness.state.links[0], {
    listingId: 'lst-1',
    sellerUid: UID,
    provider: PROVIDER,
    externalId: 'a1',
    externalMeta: { sku: 'lst-1' },
    matchMethod: 'sku',
  });
});

test('import path maps condition, language, price and foil', async () => {
  const harness = createHarness({
    items: [
      {
        externalId: 'a1',
        name: 'Pikachu ex',
        setName: 'Scarlet & Violet',
        collectorNumber: '123/162',
        quantity: 4,
        condition: 'Near Mint',
        language: 'English',
        foil: true,
        priceCents: 2599,
        currency: 'EUR',
      },
    ],
  });
  await linkAndImportInventory(args(harness));
  assert.equal(harness.state.insertCalls.length, 1);
  const call = harness.state.insertCalls[0];
  assert.equal(call.row.condition, 'NM');
  assert.equal(call.row.language, 'EN');
  assert.equal(call.row.foilState, 'foil');
  assert.equal(call.row.quantity, 4);
  assert.equal(call.row.pricePkn, 5198); // 25.99 EUR * 200
  assert.equal(call.opts.source, 'cardmarket_sync');
  assert.equal(call.opts.sourceListingId, 'cm:a1');
  assert.equal(call.seller.uid, UID);
  assert.ok(call.resolved.cardId);
});

test('not-in-catalog and ambiguous items are reported unmatched', async () => {
  const harness = createHarness({
    items: [
      { externalId: 'a1', name: 'Not In Catalog', quantity: 1 },
      { externalId: 'a2', name: 'Ambiguous Card', quantity: 1 },
    ],
  });
  const summary = await linkAndImportInventory(args(harness));
  assert.equal(summary.unmatched, 2);
  assert.equal(summary.linked, 0);
  assert.equal(summary.imported, 0);
  assert.deepEqual(
    summary.unmatchedSample.map((row) => row.reason),
    ['not_in_catalog', 'ambiguous'],
  );
  assert.equal(summary.unmatchedSample[1].candidates, 2);
  assert.equal(harness.state.insertCalls.length, 0);
});

test('provider without import capability leaves unmatched items unimported', async () => {
  const harness = createHarness({
    provider: 'ccgseller',
    items: [{ externalId: 'a1', name: 'Pikachu', quantity: 1, condition: 'NM' }],
  });
  // ccgseller's partner adapter has no listInventory; give the harness adapter
  // a stock reader so the job reaches the capability check.
  const cmAdapter = harness.deps.getAdapter(PROVIDER);
  harness.deps.getAdapter = (id) => (id === 'ccgseller' ? cmAdapter : null);
  const summary = await linkAndImportInventory(args(harness, 'ccgseller'));
  assert.equal(summary.unmatched, 1);
  assert.equal(summary.imported, 0);
  assert.equal(harness.state.resolveCalls.length, 0);
  assert.equal(summary.unmatchedSample[0].reason, 'no_sku_match');
});

test('a previously imported item is linked, not re-inserted', async () => {
  const harness = createHarness({
    existingBySource: [
      { source: 'cardmarket_sync', sourceListingId: 'cm:a1', id: 'lst-7' },
    ],
    items: [
      { externalId: 'a1', name: 'Pikachu', quantity: 1, condition: 'NM' },
    ],
  });
  const summary = await linkAndImportInventory(args(harness));
  assert.equal(summary.linked, 1);
  assert.equal(summary.imported, 0);
  assert.equal(harness.state.insertCalls.length, 0);
  assert.equal(harness.state.links[0].listingId, 'lst-7');
  assert.equal(harness.state.links[0].matchMethod, 'import');
});

test('progress is written to the integration document', async () => {
  const many = [];
  for (let i = 0; i < 120; i += 1) {
    many.push({ externalId: `a${i}`, name: `Card ${i}`, quantity: 1, condition: 'NM' });
  }
  let gateReached = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = createHarness({ items: many });
  const originalResolve = harness.deps.resolveCard;
  harness.deps.resolveCard = async (row) => {
    if (row.name === 'Card 55') {
      gateReached = true;
      await gate;
    }
    return originalResolve(row);
  };

  const running = linkAndImportInventory(args(harness));
  await flush(25);
  assert.equal(gateReached, true, 'job should have reached item 55');
  release();
  const summary = await running;

  assert.equal(summary.processed, 120);
  assert.equal(summary.complete, true);
  // A mid-run progress patch (phase "importing") was written at item 50,
  // and the final summary (phase "complete") lands on the document.
  const mid = harness.state.patches.find(
    (row) => row.inventorySync && row.inventorySync.phase === 'importing',
  );
  assert.ok(mid, 'expected a mid-run progress patch');
  assert.ok(mid.inventorySync.processed >= 50);
  const last = harness.state.patches[harness.state.patches.length - 1];
  assert.equal(last.inventorySync.phase, 'complete');
  const doc = harness.firestore.dump(`${COLLECTION}/${integrationDocId(UID, PROVIDER)}`);
  assert.equal(doc.inventorySync.complete, true);
  assert.equal(doc.inventorySync.linked, 120);
});

function flush(ms = 25) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('enqueueLinkAndImport runs the job in the background with a running guard', async () => {
  let release;
  let resolveCalled = false;
  const gate = new Promise((resolve) => {
    release = () => resolve();
  });
  const harness = createHarness({
    items: [{ externalId: 'a1', name: 'Pikachu', quantity: 1, condition: 'NM' }],
  });
  const originalResolve = harness.deps.resolveCard;
  harness.deps.resolveCard = async (row) => {
    resolveCalled = true;
    await gate;
    return originalResolve(row);
  };

  const first = await enqueueLinkAndImport(args(harness));
  assert.deepEqual(first, { started: true, alreadyRunning: false });

  // Let the setImmediate job start so it reaches the gate.
  await flush(15);
  assert.equal(resolveCalled, true);
  assert.equal(isImportRunning(UID, PROVIDER), true);

  const second = await enqueueLinkAndImport(args(harness));
  assert.deepEqual(second, { started: false, alreadyRunning: true });

  release();
  await flush(25);

  assert.equal(isImportRunning(UID, PROVIDER), false);
  assert.equal(harness.state.patches.length, 1);
  assert.equal(harness.state.patches[0].inventorySync.complete, true);

  const third = await enqueueLinkAndImport(args(harness));
  assert.deepEqual(third, { started: true, alreadyRunning: false });
  await flush(25);
  assert.equal(isImportRunning(UID, PROVIDER), false);
});
