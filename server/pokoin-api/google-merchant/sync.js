'use strict';

const { merchantConfig } = require('./config');
const { MerchantClient } = require('./client');
const { shippingOptionsForListing } = require('./shipping');

let commercePromise;
function loadCommerce() {
  if (!commercePromise) commercePromise = import('../../../market/src/google-commerce.js');
  return commercePromise;
}

function feedLabel(config, currency) {
  return currency === 'DKK' ? config.feedLabelDkk : config.feedLabelEur;
}

async function recordMerchantStatus(listing, result) {
  let db;
  try {
    db = require('../_marketplace_db');
  } catch (_) {
    return;
  }
  if (!db?.marketplaceWriteQuery) return;
  try {
    await db.marketplaceWriteQuery(
      `
        insert into public.google_merchant_products (
          listing_id, currency, offer_id, seller_uid, card_id, status, reason_code,
          price_amount, price_currency, google_name, last_error, updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
        on conflict (listing_id, currency) do update set
          offer_id = excluded.offer_id,
          seller_uid = excluded.seller_uid,
          card_id = excluded.card_id,
          status = excluded.status,
          reason_code = excluded.reason_code,
          price_amount = excluded.price_amount,
          price_currency = excluded.price_currency,
          google_name = excluded.google_name,
          last_error = excluded.last_error,
          updated_at = now()
      `,
      [
        String(listing?.id || ''),
        result.currency || '',
        result.offerId || '',
        String(listing?.sellerUid || ''),
        String(listing?.cardId || ''),
        result.status || '',
        result.reason || '',
        result.display?.amount || '',
        result.display?.currency || result.currency || '',
        result.googleName || '',
        result.error || '',
      ],
    );
  } catch (error) {
    if (error.code === '42P01') return;
    console.warn(JSON.stringify({
      msg: 'google_merchant_status_write_failed',
      code: error.code || '',
      listingId: String(listing?.id || ''),
    }));
  }
}

function statusFor(action, reason) {
  if (action === 'upsert') return 'PUBLISHED';
  if (action === 'dry_run') return reason === 'ELIGIBLE' ? 'SYNC_PENDING' : reason;
  if (action === 'delete') return 'REMOVED';
  if (action === 'failed') return 'SYNC_FAILED';
  return reason || 'SYNC_PENDING';
}

async function syncListingEvent(payload = {}, deps = {}) {
  const config = deps.config || merchantConfig(deps.env);
  const commerce = await loadCommerce();
  const listing = payload.merchantListing || payload.listing || null;
  const card = {
    id: listing?.cardId || '',
    name: listing?.cardName || '',
    set: listing?.setName || '',
    number: listing?.collectorNumber || '',
    canonicalPath: listing?.canonicalPath || '',
    heroImageUrl: listing?.cardImageUrl || '',
    imageUrl: listing?.cardImageUrl || '',
  };
  const client = deps.client || new MerchantClient({
    config,
    fetchImpl: deps.fetchImpl,
    attempts: payload.merchantAttempts || payload._merchantAttempts || 1,
  });
  const results = [];
  for (const currency of config.currencies) {
    const offerId = listing ? commerce.offerIdFor(listing.id, currency) : '';
    let shipping = [];
    if (listing && commerce.isPurchasableListing(listing)) {
      shipping = await shippingOptionsForListing(listing, {
        currency,
        countries: config.countries,
        quote: deps.quote,
        catalog: deps.catalog,
      });
    }
    const built = listing
      ? commerce.buildMerchantProduct({
        listing,
        card,
        currency,
        shipping,
        origin: config.siteOrigin,
        feedLabel: feedLabel(config, currency),
        currencies: config.currencies,
      })
      : { eligible: false, reason: 'NOT_ACTIVE', offerId, feedLabel: feedLabel(config, currency), input: null };
    const reason = built.reason;
    try {
      if (!config.enabled) {
        results.push({
          offerId: built.offerId,
          currency,
          action: 'skip',
          reason: 'disabled',
          status: 'SYNC_PENDING',
          input: built.input,
          display: built.display || null,
          stripe: built.stripe || null,
        });
        continue;
      }
      if (!built.eligible) {
        const removed = await client.deleteProduct({
          offerId: built.offerId,
          feedLabel: built.feedLabel,
        });
        results.push({
          offerId: built.offerId,
          currency,
          action: 'delete',
          reason,
          status: 'REMOVED',
          dryRun: Boolean(removed?.dryRun),
          input: null,
        });
        continue;
      }
      const saved = await client.upsertProduct(built.input);
      const action = config.dryRun ? 'dry_run' : 'upsert';
      results.push({
        offerId: built.offerId,
        currency,
        action,
        reason: 'ELIGIBLE',
        status: statusFor(action, 'ELIGIBLE'),
        dryRun: Boolean(saved?.dryRun) || config.dryRun,
        input: built.input,
        display: built.display,
        stripe: built.stripe,
        link: built.link,
        canonical: built.canonical,
        googleName: built.input?.productAttributes?.title || '',
      });
    } catch (error) {
      results.push({
        offerId,
        currency,
        action: 'failed',
        reason: error.reason || 'MERCHANT_API_REJECTED',
        status: 'SYNC_FAILED',
        error: String(error.message || 'merchant failed').slice(0, 300),
      });
      error.merchantResults = results;
      throw error;
    }
  }
  const record = deps.recordStatus || recordMerchantStatus;
  for (const result of results) {
    await record(listing, result);
  }
  return {
    mutation: payload.mutation || 'LISTING_UPDATED',
    listingId: String(listing?.id || ''),
    results,
  };
}

module.exports = {
  feedLabel,
  recordMerchantStatus,
  syncListingEvent,
};
