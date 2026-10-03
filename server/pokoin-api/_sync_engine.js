'use strict';

const { claimOne, finishClaim, withWriterTransaction } = require('./_outbox');
const { invalidateMarketplaceReads } = require('./_marketplace_cache_invalidate');
const { publishListing } = require('./marketplace-live');
const { timed } = require('./_request_timing');

let draining = false;
let timer = null;

async function refreshPrice(cardId) {
  if (!cardId) return;
  const db = require('./_marketplace_db');
  await timed('sqlMs', () => db.marketplaceWriteQuery(
    'select public.refresh_marketplace_blueprint_price_summary($1)',
    [cardId],
  ));
}

async function linkedSourceListingId(payload) {
  if (payload.sourceListingId) return String(payload.sourceListingId);
  if (!payload.listingId) return '';
  const db = require('./_marketplace_db');
  const found = await db.marketplaceWriteQuery(
    'select source_listing_id from public.marketplace_user_listings where id = $1',
    [payload.listingId],
  );
  return String(found.rows[0]?.source_listing_id || '');
}

async function pushCardTrader(payload) {
  if (!payload.wantsCardtrader || payload.steps?.cardtrader) return payload;
  payload.sourceListingId = await linkedSourceListingId(payload);
  if (payload.sourceListingId) {
    payload.steps = { ...(payload.steps || {}), cardtrader: 'already_linked' };
    return payload;
  }
  const { pushAndLinkListing } = require('./_cardtrader_seller_listings');
  const { getFirebaseAdmin } = require('./_firebase');
  const pushed = await timed('cardtraderMs', () => pushAndLinkListing({
    firestore: getFirebaseAdmin().firestore(),
    uid: payload.sellerUid,
    listing: payload.listing,
  }));
  payload.steps = { ...(payload.steps || {}), cardtrader: 'pushed' };
  payload.sourceListingId = pushed?.sourceListingId || payload.sourceListingId || '';
  return payload;
}

async function applyListingEvent(payload) {
  const next = { ...(payload || {}), steps: { ...(payload?.steps || {}) } };
  if (!next.steps.price && next.cardId) {
    await refreshPrice(next.cardId);
    next.steps.price = true;
  }
  const game = next.game || 'pokemon';
  await invalidateMarketplaceReads({
    game,
    cardId: next.cardId,
    sellerUid: next.sellerUid,
    reason: 'listing.changed',
  });
  publishListing({
    cardId: next.cardId,
    listingId: next.listingId,
    sellerUid: next.sellerUid,
    quantityAvailable: next.quantityAvailable,
    status: next.status,
  });
  next.steps.publishedAt = Date.now();
  if (next.wantsCardtrader) await pushCardTrader(next);
  if (next.destroyCardtrader && next.sourceListingId && !next.steps.destroyed) {
    const { destroyLinkedCardTraderProduct } = require('./_cardtrader_seller_listings');
    const { getFirebaseAdmin } = require('./_firebase');
    await timed('cardtraderMs', () => destroyLinkedCardTraderProduct({
      firestore: getFirebaseAdmin().firestore(),
      uid: next.sellerUid,
      sourceListingId: next.sourceListingId,
      quantity: Number(next.quantityAvailable) || 0,
    }));
    next.steps.destroyed = true;
  }
  return next;
}

async function handleClaimed(row) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  if (row.event_type === 'listing.changed') return applyListingEvent(payload);
  return payload;
}

async function drainOnce() {
  if (draining) return false;
  draining = true;
  try {
    const claimed = await withWriterTransaction(async (client) => claimOne(client));
    if (!claimed) return false;
    try {
      const payload = await handleClaimed(claimed);
      await withWriterTransaction(async (client) => {
        await finishClaim(client, claimed.id, { payload });
      });
      return true;
    } catch (error) {
      await withWriterTransaction(async (client) => {
        await finishClaim(client, claimed.id, {
          error: error.message || 'sync failed',
          payload: claimed.payload,
        });
      });
      return false;
    }
  } catch (error) {
    if (error.code !== '42P01') {
      console.warn(JSON.stringify({ msg: 'pokoin_sync_drain_failed', message: error.message }));
    }
    return false;
  } finally {
    draining = false;
  }
}

function kickSync() {
  setImmediate(() => {
    drainOnce().catch(() => {});
  });
}

function start() {
  if (timer || process.env.NODE_TEST_CONTEXT || process.env.POKOIN_SYNC_CONSUMER === '0') return;
  timer = setInterval(() => {
    drainOnce().catch(() => {});
  }, 250);
  timer.unref?.();
}

module.exports = {
  applyListingEvent,
  drainOnce,
  kickSync,
  start,
};
