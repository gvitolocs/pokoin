#!/usr/bin/env bash
# Controlled CardTrader inventory sync E2E against a connected seller.
# Creates one disposable CT product, reconciles, updates qty, destroys, reconciles.
# Requires: Pi API with Pokoin CT sync overlay live; seller_integrations enabled.
#
#   scripts/e2e-cardtrader-inventory-sync.sh [seller_uid]
set -euo pipefail

die() { echo "e2e-ct-sync: $*" >&2; exit 1; }
say() { echo "== $*"; }

UID_DEFAULT='Ax7G1IOIOvZUd7mrIc5gsw0Fcgt2'
SELLER_UID="${1:-$UID_DEFAULT}"
MARKER="pokoin-ct-sync-e2e-$(date -u +%Y%m%d%H%M%S)"

say "seller=$SELLER_UID marker=$MARKER"

ssh pi-home "docker exec -i pokoin-oracle-api node" <<EOF
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

const sellerUid = ${JSON.stringify(SELLER_UID)};
const marker = ${JSON.stringify(MARKER)};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  const admin = getFirebaseAdmin();
  const firestore = admin.firestore();
  const token = await decryptIntegrationToken(firestore, sellerUid);

  const beforeExport = await fetchProductsExport(token);
  assert(Array.isArray(beforeExport), 'export must be array');
  console.log('A0 export_count', beforeExport.length);

  // Prefer an existing Pokemon blueprint from the seller export, else a known common.
  const sample = beforeExport.find((p) => Number(p.game_id) === 5 && p.blueprint_id)
    || beforeExport.find((p) => p.blueprint_id)
    || { blueprint_id: 248086, properties_hash: { condition: 'Near Mint', pokemon_language: 'en' } };
  const blueprintId = Number(sample.blueprint_id);
  assert(blueprintId > 0, 'need a blueprint id for disposable product');

  const created = await createProduct(token, {
    blueprint_id: blueprintId,
    quantity: 2,
    price: 0.05,
    description: marker,
    user_data_field: '',
    properties: {
      condition: 'Near Mint',
      pokemon_language: 'en',
    },
  });
  const resource = created?.resource || created?.product || created;
  const productId = String(resource?.id || created?.id || '');
  assert(productId, 'createProduct must return id: ' + JSON.stringify(created).slice(0, 300));
  console.log('A1 created_ct_product', productId);

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
  }));
  assert(syncA.incomplete !== true, 'A sync must be complete');
  assert(syncA.destructiveSkipped !== true, 'A sync must allow destructive');

  const linkA = await marketplaceQuery(
    \`select listing_id::text, ct_product_id, last_ct_quantity, missing_from_ct
     from marketplace_cardtrader_product_links
     where seller_uid = \$1 and ct_product_id = \$2\`,
    [sellerUid, productId],
  );
  assert(linkA.rows[0], 'A: product link missing');
  const listingId = linkA.rows[0].listing_id;
  console.log('A3 linked_listing', listingId, 'qty', linkA.rows[0].last_ct_quantity);

  const listingA = await marketplaceQuery(
    \`select id::text, quantity_available, status, source_listing_id
     from marketplace_user_listings where id = \$1::uuid\`,
    [listingId],
  );
  assert(listingA.rows[0]?.source_listing_id === 'ct:' + productId, 'A: source_listing_id');
  assert(Number(listingA.rows[0].quantity_available) === 2, 'A: qty 2');

  // B: change quantity on CT
  await updateProduct(token, productId, { quantity: 1 });
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
    \`select quantity_available, status from marketplace_user_listings where id = \$1::uuid\`,
    [listingId],
  );
  assert(Number(listingB.rows[0].quantity_available) === 1, 'B: qty must be 1 after CT update');
  console.log('B2 pokoin_qty', listingB.rows[0].quantity_available);

  // C: destroy on CT, complete reconcile must detect disappearance
  await destroyProduct(token, productId);
  const afterDestroy = await fetchProductsExport(token);
  assert(Array.isArray(afterDestroy), 'C export array');
  assert(!afterDestroy.some((p) => String(p.id) === productId), 'C product gone from export');
  console.log('C0 export_count_after_destroy', afterDestroy.length);

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
    \`select quantity_available, status, source_listing_id
     from marketplace_user_listings where id = \$1::uuid\`,
    [listingId],
  );
  assert(Number(listingC.rows[0].quantity_available) === 0, 'C: qty 0');
  assert(listingC.rows[0].status === 'sold_out', 'C: sold_out');
  const linkC = await marketplaceQuery(
    \`select missing_from_ct from marketplace_cardtrader_product_links
     where seller_uid = \$1 and ct_product_id = \$2\`,
    [sellerUid, productId],
  );
  assert(linkC.rows[0]?.missing_from_ct === true, 'C: missing_from_ct');
  console.log('C2 disappearance_ok');

  // Cleanup disposable Pokoin listing (keep seller's other inventory)
  await marketplaceWriteQuery(
    \`update marketplace_user_listings
     set status = 'cancelled', quantity_available = 0, updated_at = now()
     where id = \$1::uuid and seller_uid = \$2 and seller_comment = \$3\`,
    [listingId, sellerUid, marker],
  ).catch(() => null);
  await marketplaceWriteQuery(
    \`update marketplace_user_listings
     set status = 'cancelled', quantity_available = 0, updated_at = now()
     where id = \$1::uuid and seller_uid = \$2\`,
    [listingId, sellerUid],
  );
  console.log('CLEANUP cancelled', listingId);
  console.log('E2E_OK', marker);
})().catch((error) => {
  console.error('E2E_FAIL', error.message);
  process.exit(1);
});
EOF
