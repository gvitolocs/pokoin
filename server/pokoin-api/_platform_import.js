'use strict';

/**
 * Platform inventory import: match the seller's external stock to Pokoin
 * listings by SKU, then import unmatched items through the catalog resolver.
 *
 * Progress is written to the integration document via patchIntegration so the
 * dashboard can poll it. The job runs in the background (setImmediate) with a
 * per-uid+provider in-memory running guard.
 */

const { getAdapter } = require('./_platform_adapters');
const { getProvider } = require('./_platform_providers');
const { upsertLink } = require('./_platform_links');
const {
  readIntegration,
  decryptSecrets,
  patchIntegration,
} = require('./_platform_integration');
const {
  resolveCard,
  insertListing,
  cleanText,
} = require('./_stock_listing_import');
const {
  mapConditionFromCm,
  mapConditionFromCt,
  mapLanguageFromName,
  priceToPkn,
} = require('./_stock_csv');

const PROGRESS_EVERY = 50;

// ---------------------------------------------------------------------------
// Condition / language mapping per provider
// ---------------------------------------------------------------------------

function mapCondition(provider, raw) {
  if (provider === 'tcgplayer') return mapConditionFromCt(raw);
  return mapConditionFromCm(raw);
}

function mapLanguage(raw) {
  return mapLanguageFromName(raw || 'English');
}

// ---------------------------------------------------------------------------
// Core import logic
// ---------------------------------------------------------------------------

/**
 * Load all of the seller's listings (active, paused, inactive) so we can
 * match incoming inventory items by SKU / listing id / source_listing_id.
 *
 * @returns {Promise<Map<string, object>>} keyed by lowercased id and source_listing_id
 */
async function loadSellerListings(query, sellerUid) {
  const { rows } = await query(
    `select id, source_listing_id, status, quantity_available
       from public.marketplace_user_listings
      where seller_uid = $1
        and status in ('active', 'paused', 'inactive')`,
    [sellerUid],
  );
  const byId = new Map();
  for (const row of rows) {
    const id = String(row.id || '').toLowerCase();
    if (id) byId.set(id, row);
    const src = String(row.source_listing_id || '').toLowerCase();
    if (src) byId.set(src, row);
  }
  return byId;
}

/**
 * Check whether a listing with this source_listing_id already exists for the
 * seller (i.e. a previous sync already imported it). Returns the listing id
 * or null.
 */
async function findExistingBySource(query, sellerUid, source, sourceListingId) {
  const { rows } = await query(
    `select id from public.marketplace_user_listings
      where seller_uid = $1 and source = $2 and source_listing_id = $3
      limit 1`,
    [sellerUid, source, sourceListingId],
  );
  return rows?.[0] ? String(rows[0].id) : null;
}

/**
 * Link and import the seller's inventory for one provider.
 *
 * @param {object} args
 * @param {string} args.provider  - provider key (cardmarket, tcgplayer, shopify, ...)
 * @param {string} args.uid       - Firebase seller uid
 * @param {object} args.firestore - Firestore instance
 * @param {object} [args.deps]    - dependency overrides for tests
 * @returns {Promise<object>} summary
 */
async function linkAndImportInventory(args = {}) {
  const deps = args.deps || {};
  const provider = cleanText(args.provider, 40);
  const uid = cleanText(args.uid, 160);
  const firestore = args.firestore;

  const providerDef = getProvider(provider);
  if (!providerDef) {
    const error = new Error(`Unknown provider: ${provider}`);
    error.statusCode = 400;
    throw error;
  }
  if (!uid) {
    const error = new Error('Missing seller uid.');
    error.statusCode = 400;
    throw error;
  }

  const query = deps.query || (async () => {
    throw new Error('No query executor provided');
  });
  const getAdapterFn = deps.getAdapter || getAdapter;
  const readIntegrationFn = deps.readIntegration || readIntegration;
  const decryptFn = deps.decryptSecrets || decryptSecrets;
  const patchFn = deps.patchIntegration || patchIntegration;
  const resolveCardFn = deps.resolveCard || resolveCard;
  const insertListingFn = deps.insertListing || insertListing;
  const upsertLinkFn = deps.upsertLink || upsertLink;
  const fetchFn = deps.fetchFn || fetch;

  const integration = await readIntegrationFn(firestore, uid, provider);
  if (!integration || !integration.exists) {
    const error = new Error('No integration for this provider.');
    error.statusCode = 400;
    throw error;
  }
  const integrationData = integration.data() || {};
  if (!integrationData.enabled) {
    const error = new Error('Integration is disabled.');
    error.statusCode = 400;
    throw error;
  }

  const adapter = getAdapterFn(provider);
  if (!adapter || typeof adapter.listInventory !== 'function') {
    const error = new Error('Provider does not support inventory listing.');
    error.statusCode = 400;
    throw error;
  }

  const secrets = await decryptFn(firestore, uid, provider);
  const ctx = {
    credentials: secrets,
    metadata: integrationData.metadata || {},
    fetchFn,
    env: process.env,
  };

  const { complete, items } = await adapter.listInventory(ctx);
  if (!complete) {
    const error = new Error('Incomplete inventory read from provider.');
    error.statusCode = 502;
    throw error;
  }

  const listingsById = await loadSellerListings(query, uid);
  const canImport = !!(providerDef.capabilities && providerDef.capabilities.import === true);
  const sourcePrefix = provider === 'cardmarket' ? 'cm' : 'tp';
  const total = items.length;
  let processed = 0;
  let linked = 0;
  let imported = 0;
  let unmatched = 0;
  const unmatchedSample = [];

  const pushUnmatched = (item, reason, extra = {}) => {
    unmatched += 1;
    if (unmatchedSample.length < 10) {
      unmatchedSample.push({
        externalId: cleanText(item.externalId, 80),
        name: cleanText(item.name, 120),
        reason,
        ...extra,
      });
    }
  };

  const summary = () => ({
    phase: 'importing',
    processed,
    total,
    linked,
    imported,
    unmatched,
    unmatchedSample: unmatchedSample.slice(0, 10),
    complete: false,
  });

  const sellerName =
    cleanText(integrationData.metadata?.username || integrationData.userEmail || 'Pokoin seller', 160) ||
    'Pokoin seller';

  for (const item of items) {
    processed += 1;
    const quantity = Math.trunc(Number(item.quantity) || 0);
    if (quantity <= 0) continue;

    const sku = cleanText(item.sku || '', 160);
    let matchMethod = '';
    let listingId = '';

    // 1. Try SKU match against existing listings.
    if (sku) {
      const match = listingsById.get(sku.toLowerCase());
      if (match) {
        listingId = String(match.id);
        matchMethod = 'sku';
      }
    }

    // 2. No SKU match → import through the catalog (if the provider supports it).
    if (!listingId) {
      const source = `${provider}_sync`;
      const sourceListingId = `${sourcePrefix}:${cleanText(item.externalId, 80)}`;

      if (!canImport) {
        pushUnmatched(item, 'no_sku_match');
        continue;
      }

      // 2a. If a previous sync already imported this external item, link it.
      const existingId = await findExistingBySource(query, uid, source, sourceListingId);
      if (existingId) {
        listingId = existingId;
        matchMethod = 'import';
      } else {
        // 2b. Resolve the card in the catalog.
        const resolved = await resolveCardFn(
          {
            name: cleanText(item.name, 240),
            collectorNumber: cleanText(item.collectorNumber, 40),
            setName: cleanText(item.setName, 240),
          },
          query,
        );

        if (!resolved || resolved.error) {
          pushUnmatched(
            item,
            resolved?.candidates?.length ? 'ambiguous' : 'not_in_catalog',
            resolved?.candidates ? { candidates: resolved.candidates.length } : {},
          );
          continue;
        }

        const condition = mapCondition(provider, item.condition);
        const language = mapLanguage(item.language);
        const pricePkn =
          item.priceCents != null
            ? priceToPkn(item.priceCents / 100, { currency: item.currency || 'EUR' })
            : null;

        const inserted = await insertListingFn(
          { uid, sellerName },
          {
            name: cleanText(item.name, 240),
            setName: cleanText(item.setName, 240),
            collectorNumber: cleanText(item.collectorNumber, 40),
            condition,
            language,
            quantity,
            pricePkn,
            foilState: item.foil ? 'foil' : 'standard',
            location: '',
          },
          resolved,
          { source, sourceListingId },
          query,
        );

        if (inserted?.skipped) {
          listingId = String(inserted.id || '');
          matchMethod = 'import';
        } else {
          listingId = String(inserted?.id || '');
          matchMethod = 'import';
          imported += 1;
        }
      }
    }

    if (listingId) {
      await upsertLinkFn(
        {
          listingId,
          sellerUid: uid,
          provider,
          externalId: cleanText(item.externalId, 160),
          externalMeta: sku ? { sku } : {},
          matchMethod,
        },
        query,
      );
      linked += 1;
    }

    // Write progress every N items.
    if (processed % PROGRESS_EVERY === 0) {
      await patchFn(firestore, uid, provider, { inventorySync: summary() });
    }
  }

  const finalSummary = {
    phase: 'complete',
    processed,
    total,
    linked,
    imported,
    unmatched,
    unmatchedSample: unmatchedSample.slice(0, 10),
    complete: true,
  };
  await patchFn(firestore, uid, provider, { inventorySync: finalSummary });

  return finalSummary;
}

// ---------------------------------------------------------------------------
// Background job
// ---------------------------------------------------------------------------

const running = new Map(); // `${uid}:${provider}` -> true

function runningKey(uid, provider) {
  return `${cleanText(uid, 160)}:${cleanText(provider, 40)}`;
}

/**
 * Start a background link-and-import job. Safe to call twice — second call
 * returns alreadyRunning.
 *
 * @returns {Promise<{ started: boolean, alreadyRunning: boolean }>}
 */
function enqueueLinkAndImport(args = {}) {
  const key = runningKey(args.uid, args.provider);
  if (running.has(key)) {
    return Promise.resolve({ started: false, alreadyRunning: true });
  }
  running.set(key, true);
  setImmediate(async () => {
    try {
      await linkAndImportInventory(args);
    } catch (error) {
      console.error('platform inventory import job failed', {
        uid: args.uid,
        provider: args.provider,
        message: error.message,
      });
    } finally {
      running.delete(key);
    }
  });
  return Promise.resolve({ started: true, alreadyRunning: false });
}

function isImportRunning(uid, provider) {
  return running.has(runningKey(uid, provider));
}

module.exports = {
  linkAndImportInventory,
  enqueueLinkAndImport,
  isImportRunning,
};
