const { getFirebaseAdmin } = require('../server/_firebase');
const {
  decryptIntegrationSharedSecret,
  decryptIntegrationToken,
  isOneDayReadyIntegration,
  readIntegrationDoc,
} = require('./_cardtrader_integration');
const { publicCardIdFromBlueprint } = require('./_cardtrader_inventory_sync_core');
const { marketplaceWriteQuery, marketplaceQuery } = require('../server/_marketplace_db');
const {
  ctSourceListingId,
  parsePokoinListingId,
} = require('./_cardtrader_seller_listings');
const { decrementSellerOwnershipForSale } = require('./_user_card_collection');
const { enqueueCardTraderInventorySync } = require('./_cardtrader_inventory_async');
const { SALES_COLLECTION, recordCardTraderSale } = require('./_native_sales');
const {
  cleanText,
  eventDocId,
  itemProductId,
  itemUserDataField,
  orderItemId,
  rawBodyBuffer,
  shouldDecrementStock,
  verifyWebhookSignature,
} = require('./_cardtrader_webhook_core');

const EVENTS_COLLECTION = 'cardtrader_webhook_events';

async function claimWebhookEvent(firestore, { uid, orderId, orderItemId, cause }) {
  const id = eventDocId(uid, orderId, orderItemId);
  const ref = firestore.collection(EVENTS_COLLECTION).doc(id);
  try {
    await ref.create({
      uid,
      orderId: String(orderId),
      orderItemId: String(orderItemId),
      cause: cleanText(cause, 40),
      createdAt: new Date().toISOString(),
    });
    return { claimed: true, id };
  } catch (error) {
    if (error.code === 6 || /already exists/i.test(String(error.message || ''))) {
      return { claimed: false, id };
    }
    throw error;
  }
}

async function releaseWebhookEvent(firestore, id) {
  if (!id) return;
  await firestore.collection(EVENTS_COLLECTION).doc(id).delete();
}

async function findLinkedListing(sellerUid, item = {}) {
  const listingId = parsePokoinListingId(itemUserDataField(item));
  if (listingId) {
    const byId = await marketplaceQuery(
      `
        select id, card_id, quantity_available, status, source_listing_id, seller_uid
        from public.marketplace_user_listings
        where id = $1 and seller_uid = $2
        limit 1
      `,
      [listingId, sellerUid],
    );
    if (byId.rows[0]) return byId.rows[0];
  }
  const productId = itemProductId(item);
  if (productId == null || productId === '') return null;
  const sourceId = ctSourceListingId(productId);
  const bySource = await marketplaceQuery(
    `
      select id, card_id, quantity_available, status, source_listing_id, seller_uid
      from public.marketplace_user_listings
      where seller_uid = $1
        and source_listing_id = $2
        and status in ('active', 'paused')
      order by updated_at desc
      limit 1
    `,
    [sellerUid, sourceId],
  );
  if (bySource.rows[0]) return bySource.rows[0];
  try {
    const byLink = await marketplaceQuery(
      `
        select l.id, l.card_id, l.quantity_available, l.status, l.source_listing_id, l.seller_uid
        from public.marketplace_cardtrader_product_links link
        join public.marketplace_user_listings l on l.id = link.listing_id
        where link.seller_uid = $1
          and link.ct_product_id = $2
          and l.status in ('active', 'paused')
        limit 1
      `,
      [sellerUid, String(productId)],
    );
    return byLink.rows[0] || null;
  } catch (error) {
    if (/does not exist/i.test(String(error.message || ''))) return null;
    throw error;
  }
}

async function decrementPokoinListing(listing, quantity) {
  const qty = Math.max(1, Math.trunc(Number(quantity) || 1));
  const result = await marketplaceWriteQuery(
    `
      update public.marketplace_user_listings
      set
        quantity_available = quantity_available - $2,
        status = case when quantity_available - $2 <= 0 then 'sold_out' else status end,
        updated_at = now()
      where id = $1
        and seller_uid = $3
        and status in ('active', 'paused')
        and quantity_available >= $2
      returning id, card_id, quantity_available, status, seller_uid
    `,
    [listing.id, qty, listing.seller_uid],
  );
  return result.rows[0] || null;
}

const CANCELLED_ORDER_STATES = new Set(['canceled', 'cancelled', 'request_for_cancel_accepted']);

function isCancelledOrder(order = {}) {
  return CANCELLED_ORDER_STATES.has(cleanText(order.state, 40).toLowerCase());
}

async function restoreCancelledItem({ admin, firestore, uid, order, item }) {
  const currentOrderItemId = orderItemId(item);
  const ref = firestore.collection(EVENTS_COLLECTION).doc(eventDocId(uid, order.id, currentOrderItemId));
  let restore = null;
  await firestore.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const data = snap.exists ? snap.data() || {} : {};
    if (!snap.exists || data.restoredAt || !data.listingId) return;
    restore = data;
    transaction.set(ref, { restoredAt: new Date().toISOString(), cancelledState: cleanText(order.state, 40) }, { merge: true });
  });
  if (!restore) {
    return { orderItemId: currentOrderItemId, skipped: true, reason: 'nothing_to_restore' };
  }
  const qty = Math.max(1, Math.trunc(Number(restore.quantity || item.quantity) || 1));
  await marketplaceWriteQuery(
    `
      update public.marketplace_user_listings
      set
        quantity_available = quantity_available + $2,
        status = case when status = 'sold_out' then 'active' else status end,
        updated_at = now()
      where id = $1 and seller_uid = $3
    `,
    [restore.listingId, qty, uid],
  );
  await firestore.collection(SALES_COLLECTION).doc(`ct_${cleanText(order.id, 40)}__${currentOrderItemId}`).set({
    voided: true,
    voidReason: 'cardtrader_order_cancelled',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true }).catch(() => {});
  return { orderItemId: currentOrderItemId, ok: true, restored: qty, listingId: restore.listingId };
}

async function handleOrderPayload({ admin, firestore, uid, cause, order }) {
  const items = Array.isArray(order.order_items) ? order.order_items : [];
  const results = [];
  if (isCancelledOrder(order)) {
    for (const item of items) {
      results.push(await restoreCancelledItem({ admin, firestore, uid, order, item }));
    }
    return results;
  }
  for (const item of items) {
    const currentOrderItemId = orderItemId(item);
    if (!shouldDecrementStock(order, item)) {
      results.push({ orderItemId: currentOrderItemId, skipped: true, reason: 'not_sale_state' });
      continue;
    }
    if (!currentOrderItemId) {
      results.push({ orderItemId: '', skipped: true, reason: 'missing_order_item_id' });
      continue;
    }
    // Resolve before claiming. A not-yet-linked item must remain retryable and
    // the complete-export fallback will reconcile it without double decrement.
    const listing = await findLinkedListing(uid, item);
    if (!listing) {
      // 1-Day Ready stock is never a Pokoin listing. The sale still belongs
      // in Sold history, tagged CardTrader 1-DR, and Pokoin stock stays put.
      const integration = await readIntegrationDoc(firestore, uid);
      if (isOneDayReadyIntegration(integration)) {
        const claim = await claimWebhookEvent(firestore, {
          uid,
          orderId: order.id,
          orderItemId: currentOrderItemId,
          cause,
        });
        if (!claim.claimed) {
          results.push({ orderItemId: currentOrderItemId, skipped: true, reason: 'already_processed' });
          continue;
        }
        const productId = itemProductId(item);
        const cardId = publicCardIdFromBlueprint(item.blueprint_id ?? item.blueprintId) || '';
        await firestore.collection(EVENTS_COLLECTION).doc(claim.id).set({
          quantity: Math.max(1, Math.trunc(Number(item.quantity) || 1)),
          productId,
          channel: '1dr',
        }, { merge: true }).catch(() => {});
        await recordCardTraderSale({
          admin,
          firestore,
          sellerUid: uid,
          order,
          item,
          channel: '1dr',
          listing: { id: productId ? `ct:${productId}` : '', card_id: cardId },
        }).catch((error) => {
          console.error('cardtrader webhook 1dr sale record failed', { uid, message: error.message });
        });
        results.push({
          orderItemId: currentOrderItemId,
          ok: true,
          channel: '1dr',
          productId,
        });
        continue;
      }
      results.push({ orderItemId: currentOrderItemId, skipped: true, reason: 'no_linked_listing' });
      continue;
    }
    const claim = await claimWebhookEvent(firestore, {
      uid,
      orderId: order.id,
      orderItemId: currentOrderItemId,
      cause,
    });
    if (!claim.claimed) {
      results.push({ orderItemId: currentOrderItemId, skipped: true, reason: 'already_processed' });
      continue;
    }
    const qty = Math.max(1, Math.trunc(Number(item.quantity) || 1));
    const updated = await decrementPokoinListing(listing, qty);
    if (!updated) {
      await releaseWebhookEvent(firestore, claim.id).catch(() => {});
      results.push({ orderItemId: currentOrderItemId, ok: false, reason: 'decrement_failed', listingId: listing.id });
      continue;
    }
    await firestore.collection(EVENTS_COLLECTION).doc(claim.id).set({
      listingId: updated.id,
      quantity: qty,
      productId: itemProductId(item),
    }, { merge: true }).catch(() => {});
    // A CardTrader sale of a linked card is a real sale: seller sold history.
    await recordCardTraderSale({
      admin,
      firestore,
      sellerUid: uid,
      order,
      item,
      listing: { id: updated.id, card_id: updated.card_id },
    }).catch((error) => {
      console.error('cardtrader webhook sale record failed', { uid, listingId: updated.id, message: error.message });
    });
    // refresh_marketplace_blueprint_price_summary is DELETE+INSERT, so it must
    // run on the writer pool; marketplaceQuery can land on a read-only replica.
    // Kept best-effort: the decrement is already durable and a refresh failure
    // must not fail the webhook (CardTrader would redeliver → double decrement).
    await marketplaceWriteQuery(
      'select public.refresh_marketplace_blueprint_price_summary($1)',
      [updated.card_id],
    ).catch((error) => {
      console.error('cardtrader webhook price summary refresh failed', error);
    });
    try {
      await decrementSellerOwnershipForSale({
        admin,
        firestore,
        sellerUid: uid,
        quantity: qty,
        listingId: updated.id,
        sourceListingId: listing.source_listing_id || '',
      });
    } catch (error) {
      console.error('cardtrader webhook ownership decrement failed', {
        uid,
        listingId: updated.id,
        message: error.message,
      });
    }
    results.push({
      orderItemId: currentOrderItemId,
      ok: true,
      listingId: updated.id,
      quantity: qty,
      remaining: updated.quantity_available,
      status: updated.status,
    });
  }
  return results;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const uid = cleanText(req.params?.uid || req.query?.uid, 160);
  if (!uid) {
    return res.status(400).json({ error: 'Missing seller uid.' });
  }

  try {
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();
    const sharedSecret = await decryptIntegrationSharedSecret(firestore, uid);
    const raw = await rawBodyBuffer(req);
    const signature = req.headers.signature || req.headers.Signature;
    if (!verifyWebhookSignature(raw, signature, sharedSecret)) {
      // Log rejections: a silent 401 hid that no delivery had ever verified.
      console.warn('cardtrader-webhook rejected', {
        uid,
        reason: 'invalid_signature',
        bodyBytes: raw.length,
        hasSignature: Boolean(signature),
      });
      return res.status(401).json({ error: 'Invalid webhook signature.' });
    }

    let payload = req.body;
    if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload)) {
      payload = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    }
    const cause = cleanText(payload.cause, 40).toLowerCase();
    if (cause !== 'order.create' && cause !== 'order.update' && cause !== 'order.destroy') {
      return res.status(200).json({ ok: true, skipped: true, reason: 'ignored_cause' });
    }
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    // A destroyed order never completed: same as a cancellation (restock once).
    const order = cause === 'order.destroy' ? { ...data, state: 'canceled' } : data;
    if (cleanText(order.order_as, 20).toLowerCase() === 'buyer') {
      return res.status(200).json({ ok: true, skipped: true, reason: 'buyer_order' });
    }
    const results = await handleOrderPayload({ admin, firestore, uid, cause, order });
    if (results.some((row) => row.reason === 'no_linked_listing' || row.reason === 'decrement_failed')) {
      try {
        const token = await decryptIntegrationToken(firestore, uid);
        enqueueCardTraderInventorySync({ firestore, uid, sellerName: 'Pokoin seller', token })
          .catch(() => {}); // the enqueue path logs its own failures
      } catch (error) {
        console.error('cardtrader-webhook fallback sync enqueue failed', { uid, message: error.message });
      }
    }
    console.log('cardtrader-webhook processed', {
      uid,
      cause,
      orderId: cleanText(order.id, 80),
      items: Array.isArray(order.order_items) ? order.order_items.length : 0,
      updated: results.filter((row) => row.ok === true).length,
      skipped: results.filter((row) => row.skipped === true).length,
      failed: results.filter((row) => row.ok === false).length,
      reasons: [...new Set(results.map((row) => row.reason).filter(Boolean))],
    });
    return res.status(200).json({ ok: true, results });
  } catch (error) {
    console.error('cardtrader-webhook failed', {
      uid,
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'CardTrader webhook failed.',
    });
  }
};

module.exports._test = {
  claimWebhookEvent,
  eventDocId,
  findLinkedListing,
  handleOrderPayload,
  isCancelledOrder,
  itemProductId,
  rawBodyBuffer,
  restoreCancelledItem,
  itemUserDataField,
  orderItemId,
  releaseWebhookEvent,
  shouldDecrementStock,
  verifyWebhookSignature,
};
