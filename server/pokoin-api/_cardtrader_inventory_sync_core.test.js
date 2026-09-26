import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDumpMinimums,
  marketPricePkn,
  claimSaleEventOnce,
  oneDayReadyAssetRow,
  oneDayReadyTotals,
  ctSourceListingId,
  destructiveReconcileGate,
  emptySummary,
  facetKey,
  isCtLinkedSource,
  isPokemonProduct,
  normalizeProduct,
  parseCtProductId,
  planInventoryReconcile,
  publicCardIdFromBlueprint,
  resolveProductAttachment,
  pknFromProduct,
} from './_cardtrader_inventory_sync_core.js';

test('public card id is blueprint × 2', () => {
  assert.equal(publicCardIdFromBlueprint('248086'), '496172');
  assert.equal(ctSourceListingId('19799784'), 'ct:19799784');
  assert.equal(parseCtProductId('ct:19799784'), '19799784');
});

test('PKN conversion from EUR price / price_cents', () => {
  assert.equal(pknFromProduct({ price: 1, price_currency: 'EUR' }), 200);
  assert.equal(pknFromProduct({ price_cents: 100, price_currency: 'EUR' }), 200);
});

test('normalize pokemon product facets', () => {
  const product = normalizeProduct({
    id: 11,
    game_id: 5,
    blueprint_id: 100,
    quantity: 3,
    price: 2.5,
    price_currency: 'EUR',
    properties_hash: {
      condition: 'Slightly Played',
      pokemon_language: 'jp',
      pokemon_reverse: true,
      pokemon_first_edition: true,
    },
  });
  assert.equal(product.condition, 'LP');
  assert.equal(product.language, 'JP');
  assert.equal(product.reverse, true);
  assert.equal(product.firstEdition, true);
  assert.equal(product.quantity, 3);
  assert.equal(isPokemonProduct(product), true);
});

test('destructive gate blocks incomplete and failed exports', () => {
  assert.equal(
    destructiveReconcileGate({ complete: false, exportOk: true, products: [] }).allowDestructive,
    false,
  );
  assert.equal(
    destructiveReconcileGate({ complete: true, exportOk: false, products: [] }).allowDestructive,
    false,
  );
  assert.equal(
    destructiveReconcileGate({ complete: true, exportOk: true, products: null }).allowDestructive,
    false,
  );
  assert.equal(
    destructiveReconcileGate({ complete: true, exportOk: true, products: [] }).allowDestructive,
    true,
  );
});

test('resolve attachment: already linked by ct source id', () => {
  const product = normalizeProduct({
    id: 55,
    game_id: 5,
    blueprint_id: 10,
    quantity: 1,
    price: 1,
  });
  const listing = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', source_listing_id: 'ct:55' };
  const bySourceId = new Map([['ct:55', listing]]);
  const decision = resolveProductAttachment(product, { bySourceId });
  assert.equal(decision.action, 'already_linked');
});

test('resolve attachment: exact single facet match links; ambiguous stays unresolved', () => {
  const product = normalizeProduct({
    id: 77,
    game_id: 5,
    blueprint_id: 50,
    quantity: 2,
    price: 1,
    properties_hash: { condition: 'Near Mint', pokemon_language: 'en' },
  });
  const cardId = publicCardIdFromBlueprint('50');
  const key = facetKey({
    card_id: cardId,
    condition: 'NM',
    language: 'EN',
    reverse: false,
    first_edition: false,
    signed: false,
    altered: false,
    graded: false,
  });
  const one = new Map([[key, [{ id: 'listing-1', card_id: cardId, condition: 'NM', language: 'EN' }]]]);
  assert.equal(resolveProductAttachment(product, { unlinkedByFacet: one }).action, 'link_existing');

  const many = new Map([[key, [
    { id: 'listing-1', card_id: cardId },
    { id: 'listing-2', card_id: cardId },
  ]]]);
  const ambiguous = resolveProductAttachment(product, { unlinkedByFacet: many });
  assert.equal(ambiguous.action, 'unresolved');
  assert.equal(ambiguous.reason, 'ambiguous_facet_match');
});

test('resolve attachment: no match imports; pokoin-only rows are not in bySourceId', () => {
  const product = normalizeProduct({
    id: 88,
    game_id: 5,
    blueprint_id: 60,
    quantity: 1,
    price: 1,
  });
  const decision = resolveProductAttachment(product, {
    bySourceId: new Map(),
    byListingId: new Map(),
    unlinkedByFacet: new Map(),
  });
  assert.equal(decision.action, 'import');
  assert.equal(isCtLinkedSource(''), false);
  assert.equal(isCtLinkedSource('pokoin_only'), false);
  assert.equal(isCtLinkedSource('ct:88'), true);
});

test('empty summary shape is stable for UI', () => {
  const summary = emptySummary();
  assert.equal(summary.imported, 0);
  assert.equal(summary.removed, 0);
  assert.ok(Array.isArray(summary.unresolvedItems));
});

test('existing CT inventory imports; second sync creates zero duplicates', () => {
  const ctProduct = {
    id: 9001,
    game_id: 5,
    blueprint_id: 248086,
    quantity: 2,
    price: 1.5,
    properties_hash: { condition: 'Near Mint', pokemon_language: 'en' },
  };
  const first = planInventoryReconcile({
    products: [ctProduct],
    listings: [
      {
        id: 'pokoin-only-1',
        card_id: '999',
        condition: 'NM',
        language: 'EN',
        source_listing_id: '',
        status: 'active',
        quantity_available: 4,
      },
    ],
    exportComplete: true,
    exportOk: true,
  });
  assert.equal(first.summary.imported, 1);
  assert.equal(first.actions.filter((a) => a.type === 'import').length, 1);
  assert.ok(first.pokoinOnlyIds.includes('pokoin-only-1'));

  const afterImport = [
    {
      id: 'import:9001',
      card_id: publicCardIdFromBlueprint('248086'),
      condition: 'NM',
      language: 'EN',
      source_listing_id: 'ct:9001',
      status: 'active',
      quantity_available: 2,
    },
    {
      id: 'pokoin-only-1',
      card_id: '999',
      condition: 'NM',
      language: 'EN',
      source_listing_id: '',
      status: 'active',
      quantity_available: 4,
    },
  ];
  const second = planInventoryReconcile({
    products: [ctProduct],
    listings: afterImport,
    exportComplete: true,
    exportOk: true,
  });
  assert.equal(second.summary.imported, 0);
  assert.equal(second.summary.alreadyLinked, 1);
  assert.equal(second.actions.filter((a) => a.type === 'import').length, 0);
  assert.ok(second.pokoinOnlyIds.includes('pokoin-only-1'));
  assert.equal(
    second.actions.some((a) => a.listingId === 'pokoin-only-1'),
    false,
    'Pokoin-only listing must never appear in CT reconcile actions',
  );
});

test('compatible Pokoin listing links safely; ambiguous does not guess', () => {
  const cardId = publicCardIdFromBlueprint('50');
  const product = {
    id: 77,
    game_id: 5,
    blueprint_id: 50,
    quantity: 2,
    price: 1,
    properties_hash: { condition: 'Near Mint', pokemon_language: 'en' },
  };
  const linked = planInventoryReconcile({
    products: [product],
    listings: [{
      id: 'compatible-1',
      card_id: cardId,
      condition: 'NM',
      language: 'EN',
      reverse: false,
      first_edition: false,
      signed: false,
      altered: false,
      graded: false,
      source_listing_id: '',
      status: 'active',
      quantity_available: 2,
    }],
    exportComplete: true,
    exportOk: true,
  });
  assert.equal(linked.summary.matchedExisting, 1);
  assert.equal(linked.actions[0].type, 'link');

  const ambiguous = planInventoryReconcile({
    products: [product],
    listings: [
      {
        id: 'a',
        card_id: cardId,
        condition: 'NM',
        language: 'EN',
        source_listing_id: '',
        status: 'active',
      },
      {
        id: 'b',
        card_id: cardId,
        condition: 'NM',
        language: 'EN',
        source_listing_id: '',
        status: 'active',
      },
    ],
    exportComplete: true,
    exportOk: true,
  });
  assert.equal(ambiguous.summary.unresolved, 1);
  assert.equal(ambiguous.actions[0].reason, 'ambiguous_facet_match');
  assert.equal(ambiguous.summary.imported, 0);
  assert.equal(ambiguous.summary.matchedExisting, 0);
});

test('complete snapshot removes missing CT product; incomplete/partial never destroys', () => {
  const listings = [
    {
      id: 'linked-1',
      source_listing_id: 'ct:111',
      status: 'active',
      quantity_available: 3,
    },
    {
      id: 'pokoin-only-2',
      source_listing_id: '',
      status: 'active',
      quantity_available: 9,
    },
  ];

  const goneComplete = planInventoryReconcile({
    products: [],
    listings,
    exportComplete: true,
    exportOk: true,
  });
  assert.equal(goneComplete.allowDestructive, true);
  assert.equal(goneComplete.summary.removed, 1);
  assert.equal(goneComplete.actions.find((a) => a.type === 'remove')?.listingId, 'linked-1');
  assert.equal(
    goneComplete.actions.some((a) => a.listingId === 'pokoin-only-2'),
    false,
  );
  assert.ok(goneComplete.pokoinOnlyIds.includes('pokoin-only-2'));

  const incomplete = planInventoryReconcile({
    products: [],
    listings,
    exportComplete: false,
    exportOk: true,
  });
  assert.equal(incomplete.allowDestructive, false);
  assert.equal(incomplete.summary.removed, 0);
  assert.equal(incomplete.actions.filter((a) => a.type === 'remove').length, 0);

  const failed = planInventoryReconcile({
    products: [],
    listings,
    exportComplete: true,
    exportOk: false,
  });
  assert.equal(failed.allowDestructive, false);
  assert.equal(failed.summary.removed, 0);

  // Pagination / partial array that looks empty must not destroy when marked incomplete.
  const partialEmpty = planInventoryReconcile({
    products: [],
    listings,
    exportComplete: false,
    exportOk: true,
  });
  assert.equal(partialEmpty.summary.removed, 0);
});

test('qty change on linked CT product updates; sale claim is idempotent', () => {
  const product = {
    id: 111,
    game_id: 5,
    blueprint_id: 10,
    quantity: 1,
    price: 1,
  };
  const plan = planInventoryReconcile({
    products: [product],
    listings: [{
      id: 'linked-1',
      source_listing_id: 'ct:111',
      status: 'active',
      quantity_available: 5,
    }],
    exportComplete: true,
    exportOk: true,
  });
  assert.equal(plan.summary.updated, 1);
  assert.equal(plan.actions.find((a) => a.type === 'update_qty')?.quantity, 1);

  const seen = new Set();
  const first = claimSaleEventOnce(seen, { uid: 'seller', orderId: 'o1', orderItemId: 'i1' });
  const second = claimSaleEventOnce(seen, { uid: 'seller', orderId: 'o1', orderItemId: 'i1' });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
});

test('1-Day Ready product becomes a dashboard asset row, not a listing', () => {
  const row = oneDayReadyAssetRow(
    {
      id: '298292043',
      blueprintId: '122728',
      name: 'Lost Blender',
      condition: 'NM',
      language: 'IT',
      reverse: true,
      firstEdition: false,
      quantity: 3,
      pricePkn: 168,
    },
    { cardId: '245456', meta: { set_name: 'Lost Origin', collector_number: '181/196', card_image_url: 'https://cdn.pokoin.com/x.jpg' } },
  );
  assert.deepEqual(row, {
    ctProductId: '298292043',
    blueprintId: '122728',
    cardId: '245456',
    cardName: 'Lost Blender',
    setName: 'Lost Origin',
    collectorNumber: '181/196',
    cardImageUrl: 'https://cdn.pokoin.com/x.jpg',
    condition: 'NM',
    language: 'IT',
    reverse: true,
    firstEdition: false,
    signed: false,
    altered: false,
    graded: false,
    quantity: 3,
    pricePkn: 168,
  });
  // A product without a usable price is still an asset, valued at 0.
  assert.equal(oneDayReadyAssetRow({ id: '1', quantity: 1, pricePkn: null }).pricePkn, 0);
});

test('1-Day Ready totals weight value by quantity and skip empty stacks', () => {
  assert.deepEqual(
    oneDayReadyTotals([
      { quantity: 2, pricePkn: 100 },
      { quantity: 1, price_pkn: '50.5' },
      { quantity: 0, pricePkn: 999 },
    ]),
    { products: 2, cards: 3, valuePkn: 250.5 },
  );
  assert.deepEqual(oneDayReadyTotals([]), { products: 0, cards: 0, valuePkn: 0 });
});

test('dashboard 1-DR price is the daily dump minimum, not the CardTrader conversion', () => {
  assert.equal(marketPricePkn({ price_pkn: 4043, market_pkn: null }), null);
  assert.equal(marketPricePkn({ price_pkn: 4043, market_pkn: '120.5' }), 120.5);
  const priced = applyDumpMinimums(
    [
      { blueprint_id: '10', price_pkn: '999', quantity: 2 },
      { blueprint_id: '11', price_pkn: '50', quantity: 1 },
    ],
    [{ blueprint_id: '10', pkn: '40' }],
  );
  assert.equal(priced[0].market_pkn, 40);
  assert.equal(priced[1].market_pkn, null);
  assert.equal(oneDayReadyTotals([
    { quantity: 2, pricePkn: marketPricePkn(priced[0]) },
    { quantity: 1, pricePkn: marketPricePkn(priced[1]) },
  ]).valuePkn, 80);
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'cardtrader-assets.js'), 'utf8');
  const historySrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'marketplace-portfolio-history.js'), 'utf8');
  assert.match(src, /cardtrader_blueprint_daily_analytics/);
  assert.match(src, /min_price_pkn/);
  assert.match(src, /marketPricePkn/);
  assert.doesNotMatch(src, /cheapest_homepage_cache_blueprint/);
  assert.match(historySrc, /cardtrader_blueprint_daily_analytics/);
  assert.doesNotMatch(historySrc, /cheapest_homepage_cache_blueprint/);
});
