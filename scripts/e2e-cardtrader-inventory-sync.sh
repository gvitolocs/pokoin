#!/usr/bin/env bash
# Controlled CardTrader inventory sync E2E against a connected seller.
# Creates one disposable CT product, reconciles, updates qty, destroys, reconciles.
#
# Not part of the Pi API runtime overlay. deploy-cardtrader-sync-api.sh archives
# only server/pokoin-api/; commits that change only this script (e.g. ff20279)
# must not force a production redeploy — runtime SHA may stay on the last
# overlay that changed CT handlers.
#
#   scripts/e2e-cardtrader-inventory-sync.sh [seller_uid]
set -euo pipefail

die() { echo "e2e-ct-sync: $*" >&2; exit 1; }
say() { echo "== $*"; }

UID_DEFAULT='Ax7G1IOIOvZUd7mrIc5gsw0Fcgt2'
SELLER_UID="${1:-$UID_DEFAULT}"
MARKER="pokoin-ct-sync-e2e-$(date -u +%Y%m%d%H%M%S)"
STAGE="$(mktemp /tmp/pokoin-ct-e2e-XXXXXX.js)"
trap 'rm -f "$STAGE"' EXIT

say "seller=$SELLER_UID marker=$MARKER"

cat > "$STAGE" <<'JS'
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { getFirebaseAdmin } = require('./server/_firebase');
const { decryptIntegrationToken } = require('./api/_cardtrader_integration');
const {
  createProduct,
  destroyProduct,
  fetchProductsExport,
  updateProduct,
} = require('./api/_cardtrader_client');
const { reconcileCardTraderInventory } = require('./api/_cardtrader_inventory_sync');
const { marketplaceQuery, marketplaceWriteQuery } = require('./server/_marketplace_db');

const sellerUid = process.env.E2E_SELLER_UID;
const marker = process.env.E2E_MARKER;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExport(token, predicate, label, attempts = 12) {
  let last = [];
  for (let i = 0; i < attempts; i += 1) {
    last = await fetchProductsExport(token);
    assert(Array.isArray(last), `${label}: export must be array`);
    if (predicate(last)) return last;
    await sleep(1500);
  }
  throw new Error(`${label}: export predicate not met after ${attempts} attempts (count=${last.length})`);
}

(async () => {
  const admin = getFirebaseAdmin();
  const firestore = admin.firestore();
  const token = await decryptIntegrationToken(firestore, sellerUid);

  const beforeExport = await fetchProductsExport(token);
  assert(Array.isArray(beforeExport), 'export must be array');
  console.log('A0 export_count', beforeExport.length);

  const sample = beforeExport.find((p) => Number(p.game_id) === 5 && p.blueprint_id)
    || beforeExport.find((p) => p.blueprint_id)
    || { blueprint_id: 248086 };
  const blueprintId = Number(sample.blueprint_id);
  assert(blueprintId > 0, 'need a blueprint id for disposable product');

  const created = await createProduct(token, {
    blueprint_id: blueprintId,
    quantity: 2,
    price: 0.05,
    description: marker,
    properties: {
      condition: 'Near Mint',
      pokemon_language: 'en',
    },
  });
  const resource = created?.resource || created?.product || created;
  const productId = String(resource?.id || created?.id || '');
  assert(productId, 'createProduct must return id: ' + JSON.stringify(created).slice(0, 300));
  console.log('A1 created_ct_product', productId);

  await waitForExport(
    token,
    (rows) => rows.some((p) => String(p.id) === productId),
    'A wait for create in export',
  );

  const syncA = await reconcileCardTraderInventory({
    firestore,
    uid: sellerUid,
    sellerName: 'E2E',
    token,
  });
  console.log('A2 sync', JSON.stringify({
    ok: syncA.ok,
    incomplete: syncA.incomplete,
    imported: syncA.summary?.imported,
    alreadyLinked: syncA.summary?.alreadyLinked,
    matchedExisting: syncA.summary?.matchedExisting,
    removed: syncA.summary?.removed,
    errors: syncA.summary?.errors,
    errorItems: syncA.summary?.errorItems,
  }));
  assert(syncA.incomplete !== true, 'A sync must be complete');
  assert(syncA.destructiveSkipped !== true, 'A sync must allow destructive');

  const linkA = await marketplaceQuery(
    `select listing_id::text, ct_product_id, last_ct_quantity, missing_from_ct
     from marketplace_cardtrader_product_links
     where seller_uid = $1 and ct_product_id = $2`,
    [sellerUid, productId],
  );
  assert(linkA.rows[0], 'A: product link missing');
  const listingId = linkA.rows[0].listing_id;
  console.log('A3 linked_listing', listingId, 'qty', linkA.rows[0].last_ct_quantity);

  const listingA = await marketplaceQuery(
    `select id::text, quantity_available, status, source_listing_id
     from marketplace_user_listings where id = $1::uuid`,
    [listingId],
  );
  assert(listingA.rows[0]?.source_listing_id === 'ct:' + productId, 'A: source_listing_id');
  assert(Number(listingA.rows[0].quantity_available) === 2, 'A: qty 2');

  // Pokoin-only listings must survive — count before/after later steps.
  const pokoinOnlyBefore = await marketplaceQuery(
    `select count(*)::int as n from marketplace_user_listings
     where seller_uid = $1
       and status in ('active','paused')
       and (source_listing_id is null or source_listing_id = '' or source_listing_id not like 'ct:%')`,
    [sellerUid],
  );
  const pokoinOnlyCount = Number(pokoinOnlyBefore.rows[0].n);

  await updateProduct(token, productId, { quantity: 1 });
  await waitForExport(
    token,
    (rows) => {
      const row = rows.find((p) => String(p.id) === productId);
      return row && Number(row.quantity) === 1;
    },
    'B wait for qty=1 in export',
  );

  const syncB = await reconcileCardTraderInventory({
    firestore,
    uid: sellerUid,
    sellerName: 'E2E',
    token,
  });
  console.log('B1 sync', JSON.stringify({
    updated: syncB.summary?.updated,
    imported: syncB.summary?.imported,
    removed: syncB.summary?.removed,
  }));
  const listingB = await marketplaceQuery(
    `select quantity_available, status from marketplace_user_listings where id = $1::uuid`,
    [listingId],
  );
  assert(Number(listingB.rows[0].quantity_available) === 1, 'B: qty must be 1 after CT update');
  console.log('B2 pokoin_qty', listingB.rows[0].quantity_available);

  for (let i = 0; i < 6; i += 1) {
    try { await destroyProduct(token, productId); } catch (_) { /* retry */ }
    const rows = await fetchProductsExport(token);
    if (!rows.some((p) => String(p.id) === productId)) break;
    await sleep(1500);
  }
  await waitForExport(
    token,
    (rows) => !rows.some((p) => String(p.id) === productId),
    'C wait for destroy in export',
  );
  console.log('C0 product absent from export');

  const syncC = await reconcileCardTraderInventory({
    firestore,
    uid: sellerUid,
    sellerName: 'E2E',
    token,
  });
  console.log('C1 sync', JSON.stringify({
    removed: syncC.summary?.removed,
    incomplete: syncC.incomplete,
    destructiveSkipped: syncC.destructiveSkipped,
  }));
  assert(syncC.incomplete !== true, 'C must be complete snapshot');
  const listingC = await marketplaceQuery(
    `select quantity_available, status, source_listing_id
     from marketplace_user_listings where id = $1::uuid`,
    [listingId],
  );
  assert(Number(listingC.rows[0].quantity_available) === 0, 'C: qty 0');
  assert(listingC.rows[0].status === 'sold_out', 'C: sold_out');
  const linkC = await marketplaceQuery(
    `select missing_from_ct from marketplace_cardtrader_product_links
     where seller_uid = $1 and ct_product_id = $2`,
    [sellerUid, productId],
  );
  assert(linkC.rows[0]?.missing_from_ct === true, 'C: missing_from_ct');
  console.log('C2 disappearance_ok');

  const pokoinOnlyAfter = await marketplaceQuery(
    `select count(*)::int as n from marketplace_user_listings
     where seller_uid = $1
       and status in ('active','paused')
       and (source_listing_id is null or source_listing_id = '' or source_listing_id not like 'ct:%')`,
    [sellerUid],
  );
  assert(Number(pokoinOnlyAfter.rows[0].n) === pokoinOnlyCount, 'Pokoin-only count unchanged');

  await marketplaceWriteQuery(
    `update marketplace_user_listings
     set status = 'inactive', quantity_available = 0, updated_at = now()
     where id = $1::uuid and seller_uid = $2`,
    [listingId, sellerUid],
  );
  console.log('CLEANUP inactive', listingId);
  console.log('E2E_OK', marker);
})().catch((error) => {
  console.error('E2E_FAIL', error.message);
  process.exit(1);
});
JS

scp -q "$STAGE" pi-home:/tmp/pokoin-ct-e2e.js
ssh pi-home "docker cp /tmp/pokoin-ct-e2e.js pokoin-oracle-api:/app/pokoin-ct-e2e.js && docker exec -e E2E_SELLER_UID='$SELLER_UID' -e E2E_MARKER='$MARKER' -w /app pokoin-oracle-api node /app/pokoin-ct-e2e.js; ec=\$?; docker exec pokoin-oracle-api rm -f /app/pokoin-ct-e2e.js; exit \$ec"
