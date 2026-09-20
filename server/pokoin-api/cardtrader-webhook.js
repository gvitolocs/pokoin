const crypto = require('node:crypto');
const { getFirebaseAdmin } = require('../server/_firebase');
const { decryptIntegrationSharedSecret } = require('./_cardtrader_integration');
const { marketplaceWriteQuery, marketplaceQuery } = require('../server/_marketplace_db');
const {
  ctSourceListingId,
  parsePokoinListingId,
} = require('./_cardtrader_seller_listings');
const { decrementSellerOwnershipForSale } = require('./_user_card_collection');

const EVENTS_COLLECTION = 'cardtrader_webhook_events';

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function rawBodyBuffer(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody, 'utf8');
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }
  return Buffer.alloc(0);
}

function verifyWebhookSignature(rawBody, signatureHeader, sharedSecret) {
  const expected = crypto
    .createHmac('sha256', String(sharedSecret || ''))
    .update(rawBody)
    .digest('base64');
  const provided = String(signatureHeader || '').trim();
  if (!provided || !expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * CardTrader How-to-sell stock gate:
 * hub_pending + via_cardtrader_zero → yes (pre-sale: order.id == item.hub_pending_order_id)
 * paid + !via_cardtrader_zero → yes
 * else → no
 */
function shouldDecrementStock(order = {}, item = {}) {
  const state = cleanText(order.state, 40).toLowerCase();
  const viaZero = order.via_cardtrader_zero === true;
  if (viaZero && state === 'hub_pending') {
    const hubPendingOrderId = item.hub_pending_order_id ?? item.hubPendingOrderId;
    if (hubPendingOrderId == null || hubPendingOrderId === '') {
      return true;
    }
    return String(hubPendingOrderId) === String(order.id);
  }
  if (!viaZero && state === 'paid') {
    return true;
  }
  return false;
}

function eventDocId(uid, orderId, orderItemId) {
  return `${cleanText(uid, 80)}_${cleanText(orderId, 40)}_${cleanText(orderItemId, 40)}`;
}

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

async function findLinkedListing(sellerUid, item = {}) {
  const listingId = parsePokoinListingId(item.user_data_field || item.userDataField);
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
  const productId = item.product_id ?? item.productId;
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

async function handleOrderPayload({ admin, firestore, uid, cause, order }) {
  if (!shouldDecrementStock(order)) {
    // Still need per-item check for pre-sale hub_pending_order_id.
  }
  const items = Array.isArray(order.order_items) ? order.order_items : [];
  const results = [];
  for (const item of items) {
    if (!shouldDecrementStock(order, item)) {
      results.push({ orderItemId: item.id, skipped: true, reason: 'not_sale_state' });
      continue;
    }
    const claim = await claimWebhookEvent(firestore, {
      uid,
      orderId: order.id,
      orderItemId: item.id,
      cause,
    });
    if (!claim.claimed) {
      results.push({ orderItemId: item.id, skipped: true, reason: 'already_processed' });
      continue;
    }
    const listing = await findLinkedListing(uid, item);
    if (!listing) {
      results.push({ orderItemId: item.id, skipped: true, reason: 'no_linked_listing' });
      continue;
    }
    const qty = Math.max(1, Math.trunc(Number(item.quantity) || 1));
    const updated = await decrementPokoinListing(listing, qty);
    if (!updated) {
      results.push({ orderItemId: item.id, ok: false, reason: 'decrement_failed', listingId: listing.id });
      continue;
    }
    await marketplaceQuery(
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
      orderItemId: item.id,
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
    const raw = rawBodyBuffer(req);
    const signature = req.headers.signature || req.headers.Signature;
    if (!verifyWebhookSignature(raw, signature, sharedSecret)) {
      return res.status(401).json({ error: 'Invalid webhook signature.' });
    }

    let payload = req.body;
    if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload)) {
      payload = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    }
    const cause = cleanText(payload.cause, 40).toLowerCase();
    if (cause !== 'order.create' && cause !== 'order.update') {
      return res.status(200).json({ ok: true, skipped: true, reason: 'ignored_cause' });
    }
    const order = payload.data && typeof payload.data === 'object' ? payload.data : {};
    if (cleanText(order.order_as, 20).toLowerCase() === 'buyer') {
      return res.status(200).json({ ok: true, skipped: true, reason: 'buyer_order' });
    }
    const results = await handleOrderPayload({ admin, firestore, uid, cause, order });
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
  shouldDecrementStock,
  verifyWebhookSignature,
};
