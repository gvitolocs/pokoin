const { beginRequest, finishRequest, timed } = require('./_request_timing');
const { getFirebaseAdmin, verifyBearerToken } = require('./_firebase');
const { marketplaceQuery, marketplaceWriteQuery } = require('./_marketplace_db');
const { sendSellerSaleNotificationsForPaidOrder } = require('./_marketplace_sale_notifications');
const {
  addProductToCart,
  fetchCart,
  purchaseCart,
} = require('./_cardtrader_client');
const { decrementLinkedCardTraderProduct } = require('./_cardtrader_seller_listings');
const {
  _test: {
    readLiveCardTraderListings,
  },
} = require('./cardtrader-live-listings');
const { decrementSellerOwnershipForSale } = require('./_user_card_collection');
const { assertSellersAcceptPkn } = require('./_seller_pkn_policy');
const {
  SALES_COLLECTION,
  orderIsSold,
  recordNativeSales,
  sellerCardTraderRow,
  sellerHistoryRow,
  voidNativeSales,
} = require('./_native_sales');

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanExternalListingId(value) {
  const text = cleanText(value, 160);
  return /^[A-Za-z0-9:_-]{3,160}$/.test(text) ? text : '';
}

function cleanOrderId(value) {
  const text = cleanText(value, 160);
  return /^[A-Za-z0-9_-]{6,160}$/.test(text) ? text : '';
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pknEqual(left, right) {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) < 0.000001;
}

function priceMismatch(listingId) {
  const error = new Error(`Listing ${listingId} price does not match the current ask.`);
  error.statusCode = 409;
  error.code = 'price_mismatch';
  return error;
}

function assertListingPrice(listingId, clientUnit, storedUnit) {
  if (!pknEqual(clientUnit, storedUnit)) throw priceMismatch(listingId);
  return Number(storedUnit);
}

function liveAskPkn(listing = {}) {
  const price = Number(listing.displayPricePkn);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function withStoredUnitPrice(item, unitPricePkn) {
  const quantity = itemQuantity(item);
  const unit = Number(unitPricePkn);
  return {
    ...item,
    unitPricePkn: unit,
    totalPricePkn: unit * quantity,
  };
}

function timestampToIso(value) {
  return value?.toDate?.().toISOString?.() || null;
}

function orderPayload(orderId, data) {
  return {
    id: orderId,
    uid: data.uid || data.buyerUid || '',
    buyerUid: data.buyerUid || data.uid || '',
    items: Array.isArray(data.items) ? data.items : [],
    subtotalPkn: numberValue(data.subtotalPkn),
    taxPkn: numberValue(data.taxPkn),
    shippingPkn: numberValue(data.shippingPkn),
    totalPkn: numberValue(data.totalPkn),
    status: data.status || 'pending',
    paymentStatus: data.paymentStatus || 'pending',
    fulfillmentStatus: data.fulfillmentStatus || 'pending',
    fulfillmentMode: data.fulfillmentMode || 'physical',
    sellerUids: Array.isArray(data.sellerUids) ? data.sellerUids : [],
    disputeStatus: data.disputeStatus || '',
    shippedAt: timestampToIso(data.shippedAt),
    trackingCode: data.trackingCode || '',
    escrowReleasedAt: timestampToIso(data.escrowReleasedAt),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
    paidAt: timestampToIso(data.paidAt),
    currency: data.currency === 'EUR' ? 'EUR' : 'PKN',
    paymentMethod: data.paymentMethod || 'pkn',
    totalEURCents: numberValue(data.totalEURCents),
    refundedTotal: numberValue(data.refundedTotal),
    cancelReason: data.cancelReason || '',
  };
}

function itemListingId(item = {}) {
  return cleanText(item.listingId ?? item.listing_id, 80);
}

function itemQuantity(item = {}) {
  const quantity = Number(item.quantity || 0);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0;
}

function itemSellerUid(item = {}) {
  return cleanText(item.sellerUid ?? item.seller_uid, 160);
}

function itemTotalPkn(item = {}) {
  const explicit = numberValue(item.totalPricePkn ?? item.total_pkn, NaN);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return numberValue(item.unitPricePkn ?? item.pricePkn ?? item.price_pkn) * itemQuantity(item);
}

function cleanFulfillmentMode(value) {
  return cleanText(value, 40) === 'nft_only' ? 'nft_only' : 'physical';
}

function normalizeItem(item = {}) {
  const raw = item && typeof item === 'object' ? item : {};
  const card = raw.card && typeof raw.card === 'object' ? raw.card : {};
  const listingId = itemListingId(raw);
  const quantity = itemQuantity(raw);
  const unitPricePkn = numberValue(raw.unitPricePkn ?? raw.pricePkn ?? raw.price_pkn);
  return {
    card: {
      ...card,
      id: cleanText(card.id || raw.cardId || raw.card_id, 120),
      name: cleanText(card.name || raw.cardName || raw.card_name, 240),
    },
    quantity,
    listingId,
    sellerUid: itemSellerUid(raw),
    sellerName: cleanText(raw.sellerName ?? raw.seller_name, 120),
    condition: cleanText(raw.condition, 40),
    language: cleanText(raw.language, 20),
    unitPricePkn,
    totalPricePkn: itemTotalPkn({ ...raw, quantity, unitPricePkn }),
    reverse: raw.reverse === true,
    sealed: raw.sealed === true,
    graded: raw.graded === true,
    gradingCompany: cleanText(raw.gradingCompany, 80),
    grade: cleanText(raw.grade, 40),
    certificationId: cleanText(raw.certificationId, 120),
    shippingAvailable: raw.shippingAvailable === true,
    reserveAvailable: raw.reserveAvailable === true,
    nftAvailable: raw.nftAvailable === true,
    fulfillmentMode: cleanFulfillmentMode(raw.fulfillmentMode),
    buyerNotes: cleanText(raw.buyerNotes, 500),
    source: cleanText(raw.source, 80),
    sourceListingId: cleanText(raw.sourceListingId ?? raw.source_listing_id, 160),
    sourceMetadata: raw.sourceMetadata && typeof raw.sourceMetadata === 'object'
      ? raw.sourceMetadata
      : {},
  };
}

function normalizedItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(normalizeItem).filter((item) =>
    item.listingId &&
    item.sellerUid &&
    item.quantity > 0 &&
    item.unitPricePkn > 0);
}

function uniqueSellerUids(items) {
  return [...new Set(items.map((item) => item.sellerUid).filter(Boolean))];
}

function physicalUsesEscrow(fulfillmentMode) {
  return cleanFulfillmentMode(fulfillmentMode) !== 'nft_only';
}

function sellerTotalsFromItems(items) {
  const sellerTotals = new Map();
  for (const item of items) {
    sellerTotals.set(item.sellerUid, (sellerTotals.get(item.sellerUid) || 0) + itemTotalPkn(item));
  }
  return sellerTotals;
}

function createdAtMs(value) {
  if (!value) return 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

const SHIP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function canAutoRefundNotShipped(order, now = Date.now()) {
  if (!order || order.paymentStatus !== 'escrow') return false;
  if (order.shippedAt || order.fulfillmentStatus === 'shipped' || order.fulfillmentStatus === 'delivered') {
    return false;
  }
  const created = createdAtMs(order.createdAt);
  return created > 0 && now - created >= SHIP_WINDOW_MS;
}

function collectionPayloadForItem({ uid, item, orderId, now }) {
  const card = item.card || {};
  return {
    uid,
    cardId: cleanText(card.id, 120),
    blueprintId: cleanText(card.id, 120),
    quantity: item.quantity,
    condition: item.condition || 'NM',
    language: item.language || 'EN',
    firstEdition: false,
    holo: card.isHolo === true || card.isFoil === true,
    reverse: item.reverse === true,
    graded: item.graded === true,
    gradingCompany: item.gradingCompany || null,
    grade: item.grade || null,
    certificationId: item.certificationId || null,
    cardName: cleanText(card.name || item.cardName, 240),
    cardImageUrl: cleanText(card.imageUrl || card.previewImageUrl || item.cardImageUrl, 800),
    setName: cleanText(card.set || item.setName, 240),
    collectorNumber: cleanText(card.number || item.collectorNumber, 80),
    ownershipType: 'nft',
    nftStatus: 'owned',
    fulfillmentMode: 'nft_only',
    physicalShippingStatus: 'not_requested',
    sourceOrderId: orderId,
    sourceListingId: item.listingId,
    source: cleanText(item.source, 80),
    createdAt: now,
    updatedAt: now,
  };
}

function shippingAddressFromBody(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    name: cleanText(raw.name, 120),
    line1: cleanText(raw.line1, 180),
    line2: cleanText(raw.line2, 180),
    city: cleanText(raw.city, 120),
    region: cleanText(raw.region, 120),
    postalCode: cleanText(raw.postalCode || raw.postal_code, 40),
    country: cleanText(raw.country, 80),
    phone: cleanText(raw.phone, 80),
  };
}

function validateShippingAddress(address) {
  if (!address.name || !address.line1 || !address.city || !address.postalCode || !address.country) {
    const error = new Error('Shipping address requires name, line1, city, postal code, and country.');
    error.statusCode = 400;
    throw error;
  }
}

function requestPayload(id, data) {
  return {
    id,
    uid: data.uid || '',
    collectionItemId: data.collectionItemId || '',
    status: data.status || 'pending_ops_review',
    chargeStatus: data.chargeStatus || 'not_charged',
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

function isCardTraderLiveItem(item = {}) {
  const source = cleanText(item.source, 80).toLowerCase();
  const sourceListingId = cleanText(item.sourceListingId, 160).toLowerCase();
  return source === 'cardtrader_live' || sourceListingId.startsWith('cardtrader:live:');
}

function cardTraderProductIdForItem(item = {}) {
  const metadata = item.sourceMetadata && typeof item.sourceMetadata === 'object' ? item.sourceMetadata : {};
  const fromMetadata = cleanExternalListingId(
    metadata.cardtraderProductId || metadata.externalProductId || metadata.externalListingId,
  );
  if (fromMetadata) return fromMetadata;
  const match = cleanText(item.sourceListingId, 160).match(/^cardtrader:live:([A-Za-z0-9_-]+)$/i);
  return match ? cleanExternalListingId(match[1]) : '';
}

function configuredCardTraderBuyToken(env = process.env) {
  return cleanText(
    env.CARDTRADER_AUTH_TOKEN ||
      env.CARDTRADER_BUY_API_TOKEN ||
      env.CARDTRADER_PURCHASE_API_TOKEN ||
      env.CARDTRADER_API_TOKEN ||
      '',
    500,
  );
}

function cardTraderBuyEnabled(env = process.env) {
  return String(env.CARDTRADER_BUY_ENABLED || '').trim().toLowerCase() === 'true';
}

function cardTraderDryRun(env = process.env) {
  return String(env.CARDTRADER_BUY_DRY_RUN || '').trim().toLowerCase() === 'true' ||
    !cardTraderBuyEnabled(env);
}

function assertCardTraderBuyConfigured(env = process.env) {
  if (!cardTraderBuyEnabled(env)) {
    const error = new Error('CardTrader live buying is disabled.');
    error.statusCode = 503;
    error.code = 'CARDTRADER_BUY_DISABLED';
    throw error;
  }
  const token = configuredCardTraderBuyToken(env);
  if (!token) {
    const error = new Error('CardTrader buy token is not configured.');
    error.statusCode = 503;
    error.code = 'CARDTRADER_BUY_TOKEN_MISSING';
    throw error;
  }
  return token;
}

function cardTraderCartItems(cart = {}) {
  if (Array.isArray(cart)) return cart;
  if (!cart || typeof cart !== 'object') return [];
  for (const key of ['order_items', 'orderItems', 'items', 'products', 'cart_items']) {
    if (Array.isArray(cart[key])) return cart[key];
  }
  if (cart.cart && typeof cart.cart === 'object') {
    return cardTraderCartItems(cart.cart);
  }
  return [];
}

async function assertCardTraderCartIsEmpty(token, { getCart = fetchCart } = {}) {
  const cart = await getCart(token);
  const items = cardTraderCartItems(cart);
  if (items.length > 0) {
    const error = new Error('CardTrader cart is not empty; refusing automatic purchase.');
    error.statusCode = 409;
    error.code = 'CARDTRADER_CART_NOT_EMPTY';
    throw error;
  }
}

function assertCardTraderCheckoutCanProceed(items, body = {}, env = process.env) {
  if (!items.some(isCardTraderLiveItem)) return;
  if (body.cardTraderDryRun === true) return;
  if (cleanFulfillmentMode(body.fulfillmentMode) === 'nft_only') return;
  assertCardTraderBuyConfigured(env);
}

async function verifyCardTraderLiveItems(items, { query = marketplaceQuery } = {}) {
  const cardTraderItems = items.filter(isCardTraderLiveItem);
  for (const item of cardTraderItems) {
    const productId = cardTraderProductIdForItem(item);
    const blueprintId = cleanText(item.sourceMetadata?.cardtraderBlueprintId || item.card?.id, 80);
    if (!productId || !blueprintId) {
      const error = new Error('CardTrader listing metadata is incomplete.');
      error.statusCode = 409;
      throw error;
    }
    const payload = await readLiveCardTraderListings(
      {
        blueprintId,
        cardId: '',
        requestedId: blueprintId,
        requestedParam: 'blueprintId',
        language: '',
        limit: null,
      },
      { query },
    );
    const liveListing = (payload.listings || []).find((listing) =>
      cleanText(listing.cardtraderProductId || listing.externalProductId || listing.externalListingId, 160) === productId);
    if (!liveListing || Number(liveListing.quantity || 0) < item.quantity) {
      const error = new Error(`CardTrader listing ${productId} is no longer available.`);
      error.statusCode = 409;
      throw error;
    }
    assertListingPrice(productId, item.unitPricePkn, liveAskPkn(liveListing));
  }
}

async function markCardTraderPurchaseStatus({
  admin,
  firestore,
  orderId,
  item,
  status,
  payload = {},
}) {
  const productId = cardTraderProductIdForItem(item);
  if (!orderId || !productId) return;
  await firestore
    .collection('cardtrader_purchase_markers')
    .doc(`${orderId}__${productId}`)
    .set(
      {
        orderId,
        productId,
        listingId: item.listingId,
        quantity: item.quantity,
        status,
        ...payload,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

async function buyCardTraderItemsForPaidOrder({
  admin,
  firestore,
  orderId,
  orderData,
  env = process.env,
  addToCart = addProductToCart,
  buyCart = purchaseCart,
  getCart = fetchCart,
}) {
  const items = (orderData.items || []).filter(isCardTraderLiveItem);
  if (items.length === 0) {
    return { ok: true, skipped: true, reason: 'No CardTrader live items.' };
  }

  if (cardTraderDryRun(env)) {
    for (const item of items) {
      await markCardTraderPurchaseStatus({
        admin,
        firestore,
        orderId,
        item,
        status: 'dry_run',
        payload: {
          dryRun: true,
          reason: 'CARDTRADER_BUY_ENABLED is not true.',
        },
      });
    }
    return {
      ok: true,
      dryRun: true,
      attempted: 0,
      items: items.map((item) => ({
        productId: cardTraderProductIdForItem(item),
        quantity: item.quantity,
        status: 'dry_run',
      })),
    };
  }

  const token = assertCardTraderBuyConfigured(env);
  const results = [];
  for (const item of items) {
    const productId = cardTraderProductIdForItem(item);
    const markerRef = firestore.collection('cardtrader_purchase_markers').doc(`${orderId}__${productId}`);
    let claimed = false;
    await firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(markerRef);
      const status = cleanText(existing.data?.()?.status, 40);
      if (existing.exists && ['purchased', 'cart_added', 'claimed'].includes(status)) {
        return;
      }
      transaction.set(markerRef, {
        orderId,
        productId,
        listingId: item.listingId,
        quantity: item.quantity,
        status: 'claimed',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      claimed = true;
    });
    if (!claimed) {
      results.push({ productId, quantity: item.quantity, skipped: true, reason: 'Purchase already claimed.' });
      continue;
    }

    try {
      await assertCardTraderCartIsEmpty(token, { getCart });
      const viaCardTraderZero = item.sourceMetadata?.shippingMode === 'zero';
      const cartPayload = {
        product_id: Number(productId),
        quantity: item.quantity,
        via_cardtrader_zero: viaCardTraderZero,
      };
      await addToCart(token, cartPayload);
      await markCardTraderPurchaseStatus({
        admin,
        firestore,
        orderId,
        item,
        status: 'cart_added',
        payload: { viaCardTraderZero },
      });
      const purchase = await buyCart(token);
      await markCardTraderPurchaseStatus({
        admin,
        firestore,
        orderId,
        item,
        status: 'purchased',
        payload: {
          purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
          cardtraderOrderId: cleanText(purchase?.id || purchase?.order_id || purchase?.uuid, 160),
        },
      });
      results.push({
        productId,
        quantity: item.quantity,
        ok: true,
        status: 'purchased',
      });
    } catch (error) {
      const purchaseStatus = error.code === 'CARDTRADER_CART_NOT_EMPTY'
        ? 'blocked_non_empty_cart'
        : 'failed';
      await markCardTraderPurchaseStatus({
        admin,
        firestore,
        orderId,
        item,
        status: purchaseStatus,
        payload: {
          error: error.message || 'CardTrader purchase failed.',
        },
      }).catch(() => {});
      results.push({
        productId,
        quantity: item.quantity,
        ok: false,
        error: error.message || 'CardTrader purchase failed.',
      });
    }
  }
  return { ok: results.every((result) => result.ok || result.skipped), dryRun: false, items: results };
}

async function verifyAndDecrementListings(items, { writeQuery = marketplaceWriteQuery } = {}) {
  const decremented = [];
  try {
    for (const item of items) {
      if (isCardTraderLiveItem(item)) {
        decremented.push({
          listingId: item.listingId,
          quantity: item.quantity,
          cardId: item.card.id,
          unitPricePkn: Number(item.unitPricePkn),
          external: true,
        });
        continue;
      }
      const result = await writeQuery(
        `
          update public.marketplace_user_listings
          set
            quantity_available = quantity_available - $2,
            status = case when quantity_available - $2 <= 0 then 'sold_out' else status end,
            updated_at = now()
          where id = $1
            and seller_uid = $3
            and status = 'active'
            and quantity_available >= $2
          returning card_id, source_listing_id, source, seller_uid, quantity_available, price_pkn
        `,
        [item.listingId, item.quantity, item.sellerUid],
      );
      const row = result.rows[0];
      if (!row) {
        const error = new Error(`Listing ${item.listingId} is no longer available.`);
        error.statusCode = 409;
        throw error;
      }
      decremented.push({
        listingId: item.listingId,
        quantity: item.quantity,
        unitPricePkn: Number(row.price_pkn),
        cardId: row.card_id || item.card.id,
        sellerUid: row.seller_uid || item.sellerUid,
        sourceListingId: cleanText(row.source_listing_id || item.sourceListingId, 160),
        source: cleanText(row.source || item.source, 80),
        remainingQuantity: Number(row.quantity_available) || 0,
      });
      assertListingPrice(item.listingId, item.unitPricePkn, row.price_pkn);
    }
  } catch (error) {
    for (const entry of decremented.reverse()) {
      if (entry.external) continue;
      await writeQuery(
        `
          update public.marketplace_user_listings
          set
            quantity_available = quantity_available + $2,
            status = case when status = 'sold_out' then 'active' else status end,
            updated_at = now()
          where id = $1
        `,
        [entry.listingId, entry.quantity],
      ).catch((rollbackError) => {
        console.error('marketplace listing rollback failed', rollbackError);
      });
    }
    throw error;
  }

  for (const cardId of [...new Set(decremented.filter((entry) => !entry.external).map((entry) => entry.cardId).filter(Boolean))]) {
    await writeQuery(
      'select public.refresh_marketplace_blueprint_price_summary($1)',
      [cardId],
    ).catch((error) => {
      console.error('marketplace price summary refresh failed', error);
    });
  }
  return decremented;
}

/** Put held/sold quantity back (EUR hold release, rollbacks). */
async function restoreListingQuantities(entries = [], { writeQuery = marketplaceWriteQuery } = {}) {
  const cardIds = new Set();
  for (const entry of entries) {
    if (!entry || entry.external || !entry.listingId || !(Number(entry.quantity) > 0)) continue;
    await writeQuery(
      `
        update public.marketplace_user_listings
        set
          quantity_available = quantity_available + $2,
          status = case when status = 'sold_out' then 'active' else status end,
          updated_at = now()
        where id = $1
      `,
      [entry.listingId, Number(entry.quantity)],
    );
    if (entry.cardId) cardIds.add(entry.cardId);
  }
  for (const cardId of cardIds) {
    await writeQuery('select public.refresh_marketplace_blueprint_price_summary($1)', [cardId])
      .catch((error) => console.error('marketplace price summary refresh failed', error));
  }
  return { restored: entries.length };
}

async function syncCardTraderAfterPokoinSale({ admin, firestore, decremented = [] }) {
  const results = [];
  for (const entry of decremented) {
    if (!entry || entry.external || !entry.sourceListingId) {
      results.push({ skipped: true, reason: 'not_linked' });
      continue;
    }
    const result = await decrementLinkedCardTraderProduct({
      firestore,
      uid: entry.sellerUid,
      sourceListingId: entry.sourceListingId,
      quantity: entry.quantity,
      remainingQuantity: entry.remainingQuantity,
    }).catch((error) => ({ ok: false, error: error.message }));
    results.push({ listingId: entry.listingId, ...result });
  }
  return {
    ok: results.every((row) => row.ok !== false || row.skipped),
    items: results,
  };
}

async function syncSellerOwnershipAfterPhysicalSale({ admin, firestore, decremented = [] }) {
  const results = [];
  for (const entry of decremented) {
    if (!entry || entry.external) {
      results.push({ ok: true, skipped: true, reason: 'external' });
      continue;
    }
    const result = await decrementSellerOwnershipForSale({
      firestore,
      admin,
      sellerUid: entry.sellerUid,
      listingId: entry.listingId,
      quantity: entry.quantity,
      sourceListingId: entry.sourceListingId,
    });
    results.push({ listingId: entry.listingId, ...result });
  }
  return {
    ok: results.every((row) => row.ok !== false),
    items: results,
  };
}

async function createPaidOrder({ admin, firestore, decoded, body }) {
  const requestedItems = normalizedItems(body?.items);
  if (requestedItems.length === 0) {
    const error = new Error('Add at least one available marketplace listing.');
    error.statusCode = 400;
    throw error;
  }
  const fulfillmentMode = cleanFulfillmentMode(body?.fulfillmentMode);
  if (fulfillmentMode === 'nft_only' && requestedItems.some((item) => !item.nftAvailable && !item.reserveAvailable)) {
    const error = new Error('NFT-only checkout requires every item to have the NFT tag.');
    error.statusCode = 400;
    throw error;
  }
  const taxPkn = Math.max(0, numberValue(body?.taxPkn));
  const shippingPkn = fulfillmentMode === 'nft_only'
    ? 0
    : Math.max(0, numberValue(body?.shippingPkn));

  if (fulfillmentMode !== 'nft_only') {
    assertCardTraderCheckoutCanProceed(requestedItems, body, process.env);
  }
  // Sellers who opted out of PKN are paid by card only (Stripe checkout).
  await assertSellersAcceptPkn(firestore, uniqueSellerUids(requestedItems));
  await verifyCardTraderLiveItems(requestedItems);
  const decremented = await verifyAndDecrementListings(requestedItems);
  const storedByListing = new Map(decremented.map((entry) => [entry.listingId, entry.unitPricePkn]));
  const items = requestedItems.map((item) => withStoredUnitPrice(item, storedByListing.get(item.listingId)));
  const subtotalPkn = items.reduce((sum, item) => sum + item.totalPricePkn, 0);
  const computedTotal = subtotalPkn + taxPkn + shippingPkn;
  const requestedTotal = numberValue(body?.totalPkn, computedTotal);
  const totalPkn = Math.max(computedTotal, requestedTotal);
  if (!Number.isFinite(totalPkn) || totalPkn <= 0) {
    for (const entry of decremented) {
      if (!entry || entry.external) continue;
      await marketplaceWriteQuery(
        `
          update public.marketplace_user_listings
          set
            quantity_available = quantity_available + $2,
            status = case when status = 'sold_out' then 'active' else status end,
            updated_at = now()
          where id = $1
        `,
        [entry.listingId, entry.quantity],
      ).catch((rollbackError) => {
        console.error('marketplace listing rollback failed', rollbackError);
      });
    }
    const error = new Error('Order total is invalid.');
    error.statusCode = 400;
    throw error;
  }

  const orderRef = firestore.collection('orders').doc();
  const buyerBalanceRef = firestore.collection('balances').doc(decoded.uid);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const sellerUids = uniqueSellerUids(items);
  const sellerTotals = sellerTotalsFromItems(items);
  const escrow = physicalUsesEscrow(fulfillmentMode);

  let orderData = null;
  try {
    await timed('firestoreMs', () => firestore.runTransaction(async (transaction) => {
      const buyerBalance = await transaction.get(buyerBalanceRef);
      const available = numberValue(buyerBalance.data()?.availablePkn);
      if (available < totalPkn) {
        const error = new Error('Your account balance is too low.');
        error.statusCode = 400;
        throw error;
      }

      transaction.set(
        buyerBalanceRef,
        {
          availablePkn: admin.firestore.FieldValue.increment(-totalPkn),
          updatedAt: now,
        },
        { merge: true },
      );
      transaction.set(firestore.collection('ledger_entries').doc(), {
        uid: decoded.uid,
        type: escrow ? 'marketplace_order_escrow' : 'marketplace_order_paid',
        amountPkn: -totalPkn,
        orderId: orderRef.id,
        createdAt: now,
      });

      if (!escrow) {
        for (const [sellerUid, amountPkn] of sellerTotals.entries()) {
          const sellerBalanceRef = firestore.collection('balances').doc(sellerUid);
          transaction.set(
            sellerBalanceRef,
            {
              availablePkn: admin.firestore.FieldValue.increment(amountPkn),
              updatedAt: now,
            },
            { merge: true },
          );
          transaction.set(firestore.collection('ledger_entries').doc(), {
            uid: sellerUid,
            type: 'marketplace_sale_paid',
            amountPkn,
            orderId: orderRef.id,
            buyerUid: decoded.uid,
            createdAt: now,
          });
        }
      }

      orderData = {
        uid: decoded.uid,
        buyerUid: decoded.uid,
        buyerEmail: cleanText(decoded.email || body?.buyerEmail, 320).toLowerCase(),
        items,
        subtotalPkn,
        taxPkn,
        shippingPkn,
        totalPkn,
        status: escrow ? 'escrow' : 'paid',
        paymentStatus: escrow ? 'escrow' : 'paid',
        fulfillmentStatus: fulfillmentMode === 'nft_only'
          ? 'nft_ownership_recorded'
          : 'awaiting_shipment',
        fulfillmentMode,
        sellerUids,
        source: 'marketplace_checkout',
        createdAt: now,
        paidAt: now,
        updatedAt: now,
      };
      transaction.set(orderRef, orderData);
      if (fulfillmentMode === 'nft_only') {
        for (const item of items) {
          const collectionRef = firestore.collection('user_card_collections').doc();
          transaction.set(
            collectionRef,
            collectionPayloadForItem({
              uid: decoded.uid,
              item,
              orderId: orderRef.id,
              now,
            }),
          );
        }
      }
    }));
  } catch (error) {
    for (const item of items) {
      if (isCardTraderLiveItem(item)) continue;
      await marketplaceWriteQuery(
        `
          update public.marketplace_user_listings
          set
            quantity_available = quantity_available + $2,
            status = case when status = 'sold_out' then 'active' else status end,
            updated_at = now()
          where id = $1
        `,
        [item.listingId, item.quantity],
      ).catch((rollbackError) => {
        console.error('marketplace listing rollback failed', rollbackError);
      });
    }
    throw error;
  }

  // Physical sale: seller no longer owns the sold quantity. NFT-only checkout
  // keeps NFT custody semantics unchanged (buyer collection write above).
  let sellerOwnership = { ok: true, skipped: true, reason: 'nft_only' };
  let cardTraderSync = { ok: true, skipped: true, reason: 'nft_only' };
  if (fulfillmentMode !== 'nft_only') {
    sellerOwnership = await syncSellerOwnershipAfterPhysicalSale({
      admin,
      firestore,
      decremented,
    }).catch((error) => {
      console.error('seller collection ownership decrement failed', error);
      return { ok: false, error: error.message || 'ownership decrement failed' };
    });
    cardTraderSync = await syncCardTraderAfterPokoinSale({
      admin,
      firestore,
      decremented,
    }).catch((error) => {
      console.error('linked CardTrader decrement failed', error);
      return { ok: false, error: error.message || 'cardtrader decrement failed' };
    });
  }

  const notification = orderData.fulfillmentMode === 'nft_only'
    ? { ok: true, skipped: true, reason: 'NFT-only checkout does not start physical seller fulfillment.' }
    : await sendSellerSaleNotificationsForPaidOrder({
      admin,
      firestore,
      orderId: orderRef.id,
      orderData,
    }).catch((error) => {
      console.error('marketplace seller notification failed', error);
      return { ok: false, error: error.message || 'Seller notification failed.' };
    });

  // Native sold history (desk "Sold on Pokoin" + seller sold history).
  const cardIdByListing = new Map(decremented.map((entry) => [entry.listingId, entry.cardId]));
  await recordNativeSales({
    admin,
    firestore,
    orderId: orderRef.id,
    order: {
      ...orderData,
      items: orderData.items.map((item) => ({
        ...item,
        card: { ...item.card, id: cardIdByListing.get(item.listingId) || item.card?.id },
      })),
    },
  }).catch((error) => {
    console.error('marketplace native sale record failed', error);
  });

  const cardTraderPurchase = orderData.fulfillmentMode === 'nft_only'
    ? { ok: true, skipped: true, reason: 'NFT-only checkout keeps reserve custody and skips live CardTrader buy-through.' }
    : await buyCardTraderItemsForPaidOrder({
      admin,
      firestore,
      orderId: orderRef.id,
      orderData,
      env: body?.cardTraderDryRun === true
        ? { ...process.env, CARDTRADER_BUY_DRY_RUN: 'true', CARDTRADER_BUY_ENABLED: '' }
        : process.env,
    }).catch((error) => {
      console.error('cardtrader buy-through failed', {
        code: error.code || '',
        statusCode: error.statusCode || 500,
        message: error.message,
      });
      return {
        ok: false,
        error: error.message || 'CardTrader buy-through failed.',
        code: error.code,
      };
    });
  if (orderData.fulfillmentMode !== 'nft_only' && (orderData.items || []).some(isCardTraderLiveItem)) {
    orderData.cardTraderPurchase = cardTraderPurchase;
    if (cardTraderPurchase.ok && cardTraderPurchase.dryRun) {
      orderData.fulfillmentStatus = 'external_purchase_dry_run';
    } else if (cardTraderPurchase.ok) {
      orderData.fulfillmentStatus = 'awaiting_cardtrader_fulfillment';
    } else {
      orderData.fulfillmentStatus = 'external_purchase_failed';
    }
    await orderRef.set({
      cardTraderPurchase,
      fulfillmentStatus: orderData.fulfillmentStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch((error) => {
      console.error('marketplace order cardtrader status update failed', error);
    });
  }

  return {
    order: orderPayload(orderRef.id, orderData),
    sellerNotification: notification,
    cardTraderPurchase,
    sellerOwnership,
  };
}

async function sendNotificationsForExistingOrder({ admin, firestore, decoded, orderId }) {
  const orderRef = firestore.collection('orders').doc(orderId);
  const doc = await orderRef.get();
  if (!doc.exists) {
    const error = new Error('Marketplace order was not found.');
    error.statusCode = 404;
    throw error;
  }
  const data = doc.data() || {};
  const canAccess = data.uid === decoded.uid ||
    data.buyerUid === decoded.uid ||
    (Array.isArray(data.sellerUids) && data.sellerUids.includes(decoded.uid));
  if (!canAccess) {
    const error = new Error('You cannot access this marketplace order.');
    error.statusCode = 403;
    throw error;
  }
  const notification = await sendSellerSaleNotificationsForPaidOrder({
    admin,
    firestore,
    orderId,
    orderData: data,
  }).catch((error) => {
    console.error('marketplace seller notification failed', error);
    return { ok: false, error: error.message || 'Seller notification failed.' };
  });
  return {
    order: orderPayload(orderId, data),
    sellerNotification: notification,
  };
}

async function createNftShippingRequests({ admin, firestore, decoded, body }) {
  const rawIds = Array.isArray(body?.collectionItemIds)
    ? body.collectionItemIds
    : [body?.collectionItemId];
  const collectionItemIds = [...new Set(rawIds.map((value) => cleanOrderId(value)).filter(Boolean))];
  if (collectionItemIds.length === 0) {
    const error = new Error('Choose at least one NFT collection item to ship.');
    error.statusCode = 400;
    throw error;
  }
  if (collectionItemIds.length > 50) {
    const error = new Error('Request shipping for 50 NFTs or fewer at a time.');
    error.statusCode = 400;
    throw error;
  }
  const shippingAddress = shippingAddressFromBody(body?.shippingAddress);
  validateShippingAddress(shippingAddress);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = firestore.batch();
  const requests = [];

  for (const collectionItemId of collectionItemIds) {
    const itemRef = firestore.collection('user_card_collections').doc(collectionItemId);
    const itemDoc = await itemRef.get();
    const itemData = itemDoc.data() || {};
    if (!itemDoc.exists || itemData.uid !== decoded.uid) {
      const error = new Error(`NFT collection item ${collectionItemId} was not found.`);
      error.statusCode = 404;
      throw error;
    }
    if (itemData.ownershipType !== 'nft' &&
        itemData.fulfillmentMode !== 'nft_only' &&
        itemData.nftStatus !== 'owned') {
      const error = new Error(`Collection item ${collectionItemId} is not an owned NFT.`);
      error.statusCode = 400;
      throw error;
    }
    if (itemData.physicalShippingStatus && itemData.physicalShippingStatus !== 'not_requested') {
      const error = new Error(`Shipping is already requested for ${collectionItemId}.`);
      error.statusCode = 409;
      throw error;
    }

    const requestRef = firestore.collection('nft_shipping_requests').doc();
    const requestData = {
      uid: decoded.uid,
      collectionItemId,
      cardId: cleanText(itemData.cardId || itemData.blueprintId, 120),
      cardName: cleanText(itemData.cardName, 240),
      sourceOrderId: cleanText(itemData.sourceOrderId, 160),
      sourceListingId: cleanText(itemData.sourceListingId, 160),
      quantity: numberValue(itemData.quantity, 1),
      shippingAddress,
      notes: cleanText(body?.notes, 500),
      status: 'pending_ops_review',
      chargeStatus: 'not_charged',
      externalFulfillmentStatus: 'not_sent',
      createdAt: now,
      updatedAt: now,
    };
    batch.set(requestRef, requestData);
    batch.set(itemRef, {
      physicalShippingStatus: 'requested',
      physicalShippingRequestId: requestRef.id,
      physicalShippingRequestedAt: now,
      updatedAt: now,
    }, { merge: true });
    requests.push(requestPayload(requestRef.id, requestData));
  }

  await batch.commit();
  return {
    request: requests[0],
    requests,
  };
}

function buyerOwnsOrder(data, uid) {
  return data.uid === uid || data.buyerUid === uid;
}

function sellerOnOrder(data, uid) {
  return Array.isArray(data.sellerUids) && data.sellerUids.includes(uid);
}

async function loadOrderOrThrow(firestore, orderId) {
  const orderRef = firestore.collection('orders').doc(orderId);
  const doc = await orderRef.get();
  if (!doc.exists) {
    const error = new Error('Marketplace order was not found.');
    error.statusCode = 404;
    throw error;
  }
  return { orderRef, data: doc.data() || {} };
}

async function confirmDelivery({ admin, firestore, decoded, orderId }) {
  const { orderRef, data } = await loadOrderOrThrow(firestore, orderId);
  if (!buyerOwnsOrder(data, decoded.uid)) {
    const error = new Error('You cannot confirm this order.');
    error.statusCode = 403;
    throw error;
  }

  // EUR Stripe orders: paid at Checkout; confirm-delivery releases Connect transfers.
  if (data.paymentMethod === 'stripe' || data.currency === 'EUR') {
    if (data.paymentStatus !== 'paid' && data.paymentStatus !== 'escrow') {
      const error = new Error('This EUR order is not paid yet.');
      error.statusCode = 400;
      throw error;
    }
    const stripe = stripeFromEnv();
    const { releaseSellerTransfers } = require('./_marketplace_order_stripe');
    await releaseSellerTransfers({ admin, stripe, orderId });
    const now = admin.firestore.FieldValue.serverTimestamp();
    await orderRef.set({
      fulfillmentStatus: 'delivered',
      updatedAt: now,
    }, { merge: true });
    const next = await orderRef.get();
    return { order: orderPayload(orderId, next.data() || data) };
  }

  if (data.paymentStatus !== 'escrow') {
    const error = new Error('This order is not in escrow.');
    error.statusCode = 400;
    throw error;
  }
  const now = admin.firestore.FieldValue.serverTimestamp();
  const sellerTotals = sellerTotalsFromItems(data.items || []);
  // Partial refunds already went back to the buyer out of escrow.
  const refunded = data.refundsBySeller && typeof data.refundsBySeller === 'object' ? data.refundsBySeller : {};
  for (const [sellerUid, amountPkn] of sellerTotals.entries()) {
    sellerTotals.set(sellerUid, Math.max(0, amountPkn - numberValue(refunded[sellerUid])));
  }
  await firestore.runTransaction(async (transaction) => {
    for (const [sellerUid, amountPkn] of sellerTotals.entries()) {
      if (amountPkn <= 0) continue;
      transaction.set(
        firestore.collection('balances').doc(sellerUid),
        {
          availablePkn: admin.firestore.FieldValue.increment(amountPkn),
          updatedAt: now,
        },
        { merge: true },
      );
      transaction.set(firestore.collection('ledger_entries').doc(), {
        uid: sellerUid,
        type: 'marketplace_sale_paid',
        amountPkn,
        orderId,
        buyerUid: decoded.uid,
        createdAt: now,
      });
    }
    transaction.set(orderRef, {
      paymentStatus: 'released',
      status: 'paid',
      fulfillmentStatus: 'delivered',
      escrowReleasedAt: now,
      updatedAt: now,
    }, { merge: true });
  });
  const next = await orderRef.get();
  return { order: orderPayload(orderId, next.data() || data) };
}

function decryptOrderShippingForSeller(data, sellerUid) {
  if (!data?.shippingAddressSnapshotEncrypted) return null;
  const { decryptAddressPayload } = require('./_address_crypto');
  const plain = decryptAddressPayload(data.shippingAddressSnapshotEncrypted);
  const shipment = (Array.isArray(data.shipments) ? data.shipments : [])
    .find((row) => String(row.sellerId || '') === String(sellerUid));
  return {
    countryCode: data.shippingAddressCountryCode || plain.countryCode || '',
    fullName: plain.fullName || '',
    companyName: plain.companyName || '',
    addressLine1: plain.addressLine1 || '',
    addressLine2: plain.addressLine2 || '',
    postalCode: plain.postalCode || '',
    city: plain.city || '',
    stateProvinceRegion: plain.stateProvinceRegion || '',
    phoneNumber: plain.phoneNumber || '',
    deliveryInstructions: plain.deliveryInstructions || '',
    shipment: shipment
      ? {
          sellerId: shipment.sellerId,
          fromCountry: shipment.fromCountry,
          toCountry: shipment.toCountry,
          packageTier: shipment.packageTier,
          cardCount: shipment.cardCount,
          shippingAmountEURCents: shipment.shippingAmountEURCents,
          serviceName: shipment.serviceName,
        }
      : null,
  };
}

async function revealShippingAddress({ firestore, decoded, orderId }) {
  const { data } = await loadOrderOrThrow(firestore, orderId);
  if (!sellerOnOrder(data, decoded.uid)) {
    const error = new Error('You cannot view this shipping address.');
    error.statusCode = 403;
    throw error;
  }
  if (data.paymentStatus !== 'paid' && data.paymentStatus !== 'escrow' && data.paymentStatus !== 'released') {
    const error = new Error('Order is not paid yet.');
    error.statusCode = 409;
    throw error;
  }
  const shippingAddress = decryptOrderShippingForSeller(data, decoded.uid);
  if (!shippingAddress) {
    const error = new Error('No encrypted shipping snapshot on this order.');
    error.statusCode = 404;
    throw error;
  }
  return { shippingAddress };
}

async function markShipped({ admin, firestore, decoded, orderId, trackingCode }) {
  const { orderRef, data } = await loadOrderOrThrow(firestore, orderId);
  if (!sellerOnOrder(data, decoded.uid)) {
    const error = new Error('You cannot mark this order shipped.');
    error.statusCode = 403;
    throw error;
  }
  if (data.paymentStatus !== 'escrow' && data.paymentStatus !== 'paid') {
    const error = new Error('This order is not ready to ship.');
    error.statusCode = 400;
    throw error;
  }
  const tracking = cleanText(trackingCode, 80);
  if (!tracking) {
    const error = new Error('Add the shipping tracking code before marking shipped.');
    error.statusCode = 400;
    throw error;
  }
  const now = admin.firestore.FieldValue.serverTimestamp();
  await orderRef.set({
    fulfillmentStatus: 'shipped',
    shippedAt: now,
    trackingCode: tracking,
    updatedAt: now,
  }, { merge: true });
  const next = await orderRef.get();
  const shippingAddress = data.shippingAddressSnapshotEncrypted
    ? decryptOrderShippingForSeller(data, decoded.uid)
    : null;
  return {
    order: orderPayload(orderId, next.data() || data),
    shippingAddress,
  };
}

async function reportProblem({ admin, firestore, decoded, orderId, reason, notes }) {
  const { orderRef, data } = await loadOrderOrThrow(firestore, orderId);
  if (!buyerOwnsOrder(data, decoded.uid)) {
    const error = new Error('You cannot dispute this order.');
    error.statusCode = 403;
    throw error;
  }
  const why = cleanText(reason, 40) || 'not_as_described';
  const now = admin.firestore.FieldValue.serverTimestamp();
  if (why === 'not_shipped' && canAutoRefundNotShipped(data)) {
    const totalPkn = numberValue(data.totalPkn);
    await firestore.runTransaction(async (transaction) => {
      transaction.set(
        firestore.collection('balances').doc(decoded.uid),
        {
          availablePkn: admin.firestore.FieldValue.increment(totalPkn),
          updatedAt: now,
        },
        { merge: true },
      );
      transaction.set(firestore.collection('ledger_entries').doc(), {
        uid: decoded.uid,
        type: 'marketplace_order_refund',
        amountPkn: totalPkn,
        orderId,
        createdAt: now,
      });
      transaction.set(orderRef, {
        paymentStatus: 'refunded',
        status: 'refunded',
        disputeStatus: 'refunded_not_shipped',
        disputeReason: why,
        disputeNotes: cleanText(notes, 500),
        fulfillmentStatus: 'cancelled_not_shipped',
        updatedAt: now,
      }, { merge: true });
    });
    await voidNativeSales({ admin, firestore, orderId, reason: 'refunded_not_shipped' }).catch((error) => {
      console.error('marketplace native sale void failed', error);
    });
  } else {
    await orderRef.set({
      disputeStatus: 'open',
      disputeReason: why,
      disputeNotes: cleanText(notes, 500),
      updatedAt: now,
    }, { merge: true });
  }
  const next = await orderRef.get();
  return { order: orderPayload(orderId, next.data() || data) };
}

function stripeFromEnv() {
  const Stripe = require('stripe');
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) {
    const error = new Error('Stripe is not configured.');
    error.statusCode = 500;
    throw error;
  }
  return new Stripe(stripeSecret, process.env.STRIPE_API_VERSION
    ? { apiVersion: process.env.STRIPE_API_VERSION }
    : {});
}

/** Buyer backs out of an unpaid EUR checkout: expire Stripe, release the hold. */
async function cancelEurOrder({ admin, firestore, decoded, orderId }) {
  const stripe = stripeFromEnv();
  const { cancelPendingEurOrder } = require('./_eur_order_inventory');
  const { handleMarketplaceOrderPaid } = require('./_marketplace_order_stripe');
  const result = await cancelPendingEurOrder({
    admin,
    firestore,
    stripe,
    orderId,
    uid: decoded.uid,
    onPaid: (session) => handleMarketplaceOrderPaid({ admin, stripe, session }),
  });
  const next = await firestore.collection('orders').doc(orderId).get();
  return { ...result, order: orderPayload(orderId, next.data() || {}) };
}

async function refundOrder({ admin, firestore, decoded, orderId, body = {} }) {
  const { refundSellerShare } = require('./_order_refund');
  const { data } = await loadOrderOrThrow(firestore, orderId);
  if (!sellerOnOrder(data, decoded.uid)) {
    const error = new Error('Only a seller on this order can refund it.');
    error.statusCode = 403;
    throw error;
  }
  const eur = data.currency === 'EUR' || data.paymentMethod === 'stripe';
  const result = await refundSellerShare({
    admin,
    firestore,
    stripe: eur ? stripeFromEnv() : null,
    orderId,
    sellerUid: decoded.uid,
    amount: Number(body.amount),
    reason: body.reason,
    clientToken: body.clientToken,
  });
  const next = await firestore.collection('orders').doc(orderId).get();
  return { ...result, sale: sellerHistoryRow(orderId, next.data() || {}, decoded.uid) };
}

/** Seller sold history: native Pokoin orders (refundable) + CardTrader sales. */
async function sellerSoldHistory({ firestore, decoded, limit = 200 }) {
  const [orders, cardTrader] = await Promise.all([
    firestore.collection('orders').where('sellerUids', 'array-contains', decoded.uid).get(),
    firestore.collection(SALES_COLLECTION).where('sellerUid', '==', decoded.uid).get(),
  ]);
  const rows = [];
  for (const doc of orders.docs) {
    const data = doc.data() || {};
    const refundedAway = data.paymentStatus === 'refunded';
    if (!orderIsSold(data) && !refundedAway) continue;
    rows.push({ ...sellerHistoryRow(doc.id, data, decoded.uid), source: 'pokoin' });
  }
  for (const doc of cardTrader.docs) {
    const data = doc.data() || {};
    if (data.source !== 'cardtrader') continue;
    rows.push(sellerCardTraderRow(doc.id, data));
  }
  rows.sort((a, b) => String(b.soldAt || '').localeCompare(String(a.soldAt || '')));
  return { sales: rows.slice(0, limit) };
}

module.exports = async function handler(req, res) {
  const span = beginRequest('marketplace-orders', req.method);
  try {
    const decoded = await verifyBearerToken(req);
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();
    const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
    const action = cleanText(url.searchParams.get('action') || req.body?.action, 40);

    if (req.method === 'GET' && action === 'sold-history') {
      const result = await sellerSoldHistory({ firestore, decoded });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, ...result });
    }

    if (req.method === 'POST' && (!action || action === 'checkout')) {
      const result = await createPaidOrder({
        admin,
        firestore,
        decoded,
        body: req.body || {},
      });
      return res.status(200).json({ ok: true, ...result });
    }

    if (req.method === 'POST' && action === 'notify-sellers') {
      const orderId = cleanOrderId(url.searchParams.get('orderId') || req.body?.orderId);
      if (!orderId) {
        return res.status(400).json({ error: 'Order id is required.' });
      }
      const result = await sendNotificationsForExistingOrder({
        admin,
        firestore,
        decoded,
        orderId,
      });
      return res.status(200).json({ ok: true, ...result });
    }

    if (req.method === 'POST' && action === 'nft-shipping-request') {
      const result = await createNftShippingRequests({
        admin,
        firestore,
        decoded,
        body: req.body || {},
      });
      return res.status(200).json({ ok: true, ...result });
    }

    if (req.method === 'POST' && (
      action === 'confirm-delivery'
      || action === 'mark-shipped'
      || action === 'report-problem'
      || action === 'reveal-shipping'
      || action === 'cancel-eur'
      || action === 'refund'
    )) {
      const orderId = cleanOrderId(url.searchParams.get('orderId') || req.body?.orderId);
      if (!orderId) {
        return res.status(400).json({ error: 'Order id is required.' });
      }
      if (action === 'confirm-delivery') {
        const result = await confirmDelivery({ admin, firestore, decoded, orderId });
        return res.status(200).json({ ok: true, ...result });
      }
      if (action === 'mark-shipped') {
        const result = await markShipped({
          admin,
          firestore,
          decoded,
          orderId,
          trackingCode: req.body?.trackingCode,
        });
        return res.status(200).json({ ok: true, ...result });
      }
      if (action === 'reveal-shipping') {
        const result = await revealShippingAddress({ firestore, decoded, orderId });
        return res.status(200).json({ ok: true, ...result });
      }
      if (action === 'cancel-eur') {
        const result = await cancelEurOrder({ admin, firestore, decoded, orderId });
        return res.status(200).json({ ok: true, ...result });
      }
      if (action === 'refund') {
        const result = await refundOrder({ admin, firestore, decoded, orderId, body: req.body || {} });
        return res.status(200).json({ ok: true, ...result });
      }
      const result = await reportProblem({
        admin,
        firestore,
        decoded,
        orderId,
        reason: req.body?.reason,
        notes: req.body?.notes,
      });
      return res.status(200).json({ ok: true, ...result });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (error) {
    console.error('marketplace-orders failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Marketplace order failed.',
      ...(error.code ? { code: error.code } : {}),
    });
  } finally {
    finishRequest(span);
  }
};

// Shared with the EUR (Stripe) order lifecycle in _eur_order_inventory.js.
module.exports.fulfillment = {
  buyCardTraderItemsForPaidOrder,
  isCardTraderLiveItem,
  normalizedItems,
  restoreListingQuantities,
  syncCardTraderAfterPokoinSale,
  syncSellerOwnershipAfterPhysicalSale,
  verifyAndDecrementListings,
  verifyCardTraderLiveItems,
};

module.exports._test = {
  cleanOrderId,
  buyCardTraderItemsForPaidOrder,
  assertCardTraderBuyConfigured,
  assertCardTraderCartIsEmpty,
  assertCardTraderCheckoutCanProceed,
  cardTraderCartItems,
  cardTraderBuyEnabled,
  cardTraderDryRun,
  cardTraderProductIdForItem,
  configuredCardTraderBuyToken,
  cleanFulfillmentMode,
  collectionPayloadForItem,
  createNftShippingRequests,
  createPaidOrder,
  canAutoRefundNotShipped,
  physicalUsesEscrow,
  isCardTraderLiveItem,
  normalizeItem,
  normalizedItems,
  orderPayload,
  shippingAddressFromBody,
  verifyCardTraderLiveItems,
  syncSellerOwnershipAfterPhysicalSale,
  verifyAndDecrementListings,
  assertListingPrice,
  liveAskPkn,
  pknEqual,
  withStoredUnitPrice,
};
