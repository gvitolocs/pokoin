/**
 * Pure CardTrader ↔ Pokoin inventory sync helpers (no DB / Firebase).
 * Invariant: CardTrader inventory ⊆ Pokoin inventory for a connected seller.
 */

'use strict';

const POKEMON_GAME_ID = 5;
const SOURCE_IMPORT = 'cardtrader_seller_import';
const CT_PREFIX = 'ct:';
const PKN_USDT_PRICE = 0.005;

const CONDITION_FROM_CT = {
  mint: 'NM',
  'near mint': 'NM',
  'slightly played': 'LP',
  'moderately played': 'MP',
  played: 'HP',
  'heavily played': 'HP',
  poor: 'PO',
  'lightly played': 'LP',
};

const LANG_FROM_CT = {
  en: 'EN',
  it: 'IT',
  de: 'DE',
  fr: 'FR',
  es: 'ES',
  pt: 'PT',
  jp: 'JP',
  ja: 'JP',
  kr: 'KO',
  ko: 'KO',
  zh: 'ZH',
  'zh-cn': 'ZH',
  'zh-tw': 'ZHT',
  zht: 'ZHT',
  id: 'ID',
  th: 'TH',
  vi: 'VI',
};

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function emptySummary() {
  return {
    inventory: 0,
    pokemonInventory: 0,
    alreadyLinked: 0,
    matchedExisting: 0,
    imported: 0,
    updated: 0,
    removed: 0,
    unresolved: 0,
    skippedNonPokemon: 0,
    errors: 0,
    unresolvedItems: [],
    errorItems: [],
  };
}

function propertiesOf(product = {}) {
  const props = product.properties_hash || product.properties || {};
  return props && typeof props === 'object' ? props : {};
}

function ctConditionToPokoin(raw) {
  const key = cleanText(raw, 40).toLowerCase();
  return CONDITION_FROM_CT[key] || 'NM';
}

function ctLanguageToPokoin(raw) {
  const key = cleanText(raw, 20).toLowerCase();
  return LANG_FROM_CT[key] || 'EN';
}

function eurPriceFromProduct(product = {}) {
  const currency = cleanText(product.price_currency || product.currency, 8).toUpperCase() || 'EUR';
  if (product.price != null && Number.isFinite(Number(product.price))) {
    return Number(product.price);
  }
  const cents = product.price_cents;
  if (cents != null && typeof cents === 'object') {
    const eur = cents.EUR ?? cents.eur;
    if (eur != null && Number.isFinite(Number(eur))) return Number(eur) / 100;
    const first = Object.values(cents).find((v) => Number.isFinite(Number(v)));
    if (first != null) return Number(first) / 100;
  }
  if (cents != null && Number.isFinite(Number(cents))) {
    return Number(cents) / 100;
  }
  return null;
}

function pknFromProduct(product) {
  const eur = eurPriceFromProduct(product);
  if (eur == null || !(eur > 0)) return null;
  return Math.round((eur / PKN_USDT_PRICE) * 100) / 100;
}

/** CT blueprint id → Pokoin public card_id (ct_id × 2). */
function publicCardIdFromBlueprint(blueprintId) {
  const raw = cleanText(blueprintId, 80);
  if (!/^\d+$/.test(raw)) return null;
  try {
    const value = BigInt(raw);
    if (value <= 0n) return null;
    return String(value * 2n);
  } catch (_) {
    return null;
  }
}

function ctSourceListingId(productId) {
  const id = cleanText(productId, 80);
  return id ? `${CT_PREFIX}${id}` : '';
}

function parseCtProductId(sourceListingId) {
  const raw = cleanText(sourceListingId, 160);
  const match = raw.match(/^(?:ct|cardtrader):(\d+)$/i);
  return match ? match[1] : '';
}

function parsePokoinListingId(userDataField) {
  const raw = cleanText(userDataField, 160);
  const match = raw.match(/^pokoin:([0-9a-f-]{36})$/i);
  return match ? match[1] : '';
}

function normalizeProduct(product = {}) {
  const id = cleanText(product.id, 80);
  const blueprintId = cleanText(product.blueprint_id ?? product.blueprintId, 80);
  const props = propertiesOf(product);
  const gameId = Number(product.game_id ?? product.gameId);
  const quantity = Math.max(0, Math.trunc(Number(product.quantity ?? product.qty) || 0));
  return {
    id,
    blueprintId,
    gameId: Number.isFinite(gameId) ? gameId : null,
    quantity,
    name: cleanText(product.name_en || product.name || product.blueprint?.name, 240),
    condition: ctConditionToPokoin(props.condition),
    language: ctLanguageToPokoin(props.pokemon_language || props.mtg_language || props.language),
    reverse: props.pokemon_reverse === true || props.mtg_foil === true || props.foil === true,
    firstEdition: props.pokemon_first_edition === true || props.first_edition === true,
    signed: props.signed === true,
    altered: props.altered === true,
    graded: product.graded === true
      || (Boolean(product.graded) && product.graded !== false && product.graded !== 'false'),
    pricePkn: pknFromProduct(product),
    userDataField: cleanText(product.user_data_field || product.userDataField, 160),
    description: cleanText(product.description, 500),
    raw: product,
  };
}

function isPokemonProduct(product) {
  if (product.gameId == null) {
    const props = propertiesOf(product.raw || product);
    if (props.pokemon_language != null || props.pokemon_reverse != null) return true;
    return Boolean(product.blueprintId);
  }
  return product.gameId === POKEMON_GAME_ID;
}

function facetKey(row) {
  return [
    cleanText(row.card_id || row.cardId, 80),
    cleanText(row.condition, 20).toUpperCase() || 'NM',
    cleanText(row.language, 10).toUpperCase() || 'EN',
    row.reverse === true || row.reverse === 't' ? '1' : '0',
    row.first_edition === true || row.firstEdition === true || row.first_edition === 't' ? '1' : '0',
    row.signed === true || row.signed === 't' ? '1' : '0',
    row.altered === true || row.altered === 't' ? '1' : '0',
    row.graded === true || row.graded === 't' ? '1' : '0',
  ].join('|');
}

function isCtLinkedSource(sourceListingId) {
  return cleanText(sourceListingId, 160).startsWith(CT_PREFIX);
}

/**
 * Safety gate: incomplete/failed exports must never trigger disappearance.
 * @returns {{ allowDestructive: boolean, reason: string }}
 */
function destructiveReconcileGate({ complete, exportOk, products } = {}) {
  if (exportOk === false) {
    return { allowDestructive: false, reason: 'export_failed' };
  }
  if (complete !== true) {
    return { allowDestructive: false, reason: 'incomplete_snapshot' };
  }
  if (!Array.isArray(products)) {
    return { allowDestructive: false, reason: 'invalid_products' };
  }
  return { allowDestructive: true, reason: 'complete_ok' };
}

/**
 * Decide how to attach one CT product given existing seller listings.
 * Pure: no writes. Ambiguous facet matches stay unresolved.
 */
function resolveProductAttachment(product, {
  bySourceId = new Map(),
  byListingId = new Map(),
  unlinkedByFacet = new Map(),
} = {}) {
  const sourceId = ctSourceListingId(product.id);
  const cardId = publicCardIdFromBlueprint(product.blueprintId);

  let listing = bySourceId.get(sourceId) || null;
  let origin = 'import';
  if (listing) {
    return { action: 'already_linked', listing, sourceId, cardId, origin: 'push' };
  }

  const pokoinId = parsePokoinListingId(product.userDataField);
  if (pokoinId && byListingId.has(pokoinId)) {
    return {
      action: 'link_existing',
      listing: byListingId.get(pokoinId),
      sourceId,
      cardId,
      origin: 'match',
    };
  }

  if (cardId) {
    const key = facetKey({
      card_id: cardId,
      condition: product.condition,
      language: product.language,
      reverse: product.reverse,
      first_edition: product.firstEdition,
      signed: product.signed,
      altered: product.altered,
      graded: product.graded,
    });
    const candidates = unlinkedByFacet.get(key) || [];
    if (candidates.length === 1) {
      return {
        action: 'link_existing',
        listing: candidates[0],
        sourceId,
        cardId,
        origin: 'match',
        facetKey: key,
      };
    }
    if (candidates.length > 1) {
      return {
        action: 'unresolved',
        reason: 'ambiguous_facet_match',
        sourceId,
        cardId,
        candidates: candidates.length,
      };
    }
  }

  if (!cardId) {
    return {
      action: 'unresolved',
      reason: 'unmapped_blueprint',
      sourceId,
      cardId: null,
      name: product.name,
    };
  }

  return { action: 'import', sourceId, cardId, origin };
}

/**
 * Pure plan of one reconcile pass (no DB). Encodes CT ⊆ Pokoin + incomplete safety.
 * pokoinOnlyListings must never appear in actions.
 */
function planInventoryReconcile({
  products = [],
  listings = [],
  exportComplete = true,
  exportOk = true,
} = {}) {
  const gate = destructiveReconcileGate({
    complete: exportComplete,
    exportOk,
    products,
  });
  const summary = emptySummary();
  summary.inventory = products.length;

  const bySourceId = new Map();
  const byListingId = new Map();
  const unlinkedByFacet = new Map();
  const pokoinOnlyIds = new Set();

  for (const row of listings) {
    byListingId.set(String(row.id), row);
    const sourceId = cleanText(row.source_listing_id, 160);
    if (isCtLinkedSource(sourceId)) {
      bySourceId.set(sourceId, row);
    } else {
      pokoinOnlyIds.add(String(row.id));
      if (row.status === 'active' || row.status === 'paused' || !row.status) {
        const key = facetKey(row);
        const bucket = unlinkedByFacet.get(key) || [];
        bucket.push(row);
        unlinkedByFacet.set(key, bucket);
      }
    }
  }

  const actions = [];
  const seenProductIds = new Set();
  const normalized = products.map(normalizeProduct).filter((p) => p.id);

  for (const product of normalized) {
    if (!isPokemonProduct(product)) {
      summary.skippedNonPokemon += 1;
      continue;
    }
    summary.pokemonInventory += 1;
    seenProductIds.add(product.id);
    const decision = resolveProductAttachment(product, {
      bySourceId,
      byListingId,
      unlinkedByFacet,
    });
    if (decision.action === 'unresolved') {
      summary.unresolved += 1;
      actions.push({ type: 'unresolved', productId: product.id, reason: decision.reason });
      continue;
    }
    if (decision.action === 'already_linked') {
      summary.alreadyLinked += 1;
      const qty = Number(decision.listing.quantity_available) || 0;
      if (qty !== product.quantity) {
        summary.updated += 1;
        actions.push({
          type: 'update_qty',
          productId: product.id,
          listingId: decision.listing.id,
          quantity: product.quantity,
        });
      } else {
        actions.push({ type: 'noop', productId: product.id, listingId: decision.listing.id });
      }
      continue;
    }
    if (decision.action === 'link_existing') {
      summary.matchedExisting += 1;
      if (decision.facetKey) unlinkedByFacet.set(decision.facetKey, []);
      bySourceId.set(decision.sourceId, decision.listing);
      pokoinOnlyIds.delete(String(decision.listing.id));
      actions.push({
        type: 'link',
        productId: product.id,
        listingId: decision.listing.id,
      });
      continue;
    }
    if (decision.action === 'import') {
      summary.imported += 1;
      const syntheticId = `import:${product.id}`;
      bySourceId.set(decision.sourceId, { id: syntheticId, source_listing_id: decision.sourceId });
      actions.push({
        type: 'import',
        productId: product.id,
        cardId: decision.cardId,
        listingId: syntheticId,
      });
    }
  }

  if (gate.allowDestructive) {
    for (const [sourceId, listing] of bySourceId.entries()) {
      const productId = parseCtProductId(sourceId);
      if (!productId || seenProductIds.has(productId)) continue;
      if (!isCtLinkedSource(listing.source_listing_id || sourceId)) continue;
      summary.removed += 1;
      actions.push({
        type: 'remove',
        productId,
        listingId: listing.id,
        sourceId,
      });
    }
  }

  return {
    allowDestructive: gate.allowDestructive,
    gateReason: gate.reason,
    summary,
    actions,
    pokoinOnlyIds: [...pokoinOnlyIds],
  };
}

/**
 * Sale webhook idempotency: same order item must not decrement twice.
 * Pure claim map simulation (Firestore create semantics).
 */
function claimSaleEventOnce(seen, { uid, orderId, orderItemId }) {
  const key = `${cleanText(uid, 80)}_${cleanText(orderId, 40)}_${cleanText(orderItemId, 40)}`;
  if (seen.has(key)) return { claimed: false, key };
  seen.add(key);
  return { claimed: true, key };
}

/**
 * A CardTrader 1-Day Ready product as a seller dashboard asset. That stock is
 * in CardTrader's warehouse and CardTrader sells it, so it never becomes a
 * Pokoin listing (docs/API.md, 091_cardtrader_one_day_ready_assets.sql).
 */
function oneDayReadyAssetRow(product = {}, { cardId = '', meta = {} } = {}) {
  return {
    ctProductId: cleanText(product.id, 80),
    blueprintId: cleanText(product.blueprintId, 80),
    cardId: cleanText(cardId, 80),
    cardName: cleanText(product.name || meta.card_name, 240),
    setName: cleanText(meta.set_name, 240),
    collectorNumber: cleanText(meta.collector_number, 80),
    cardImageUrl: cleanText(meta.card_image_url, 800),
    condition: cleanText(product.condition, 20),
    language: cleanText(product.language, 10),
    reverse: product.reverse === true,
    firstEdition: product.firstEdition === true,
    signed: product.signed === true,
    altered: product.altered === true,
    graded: product.graded === true,
    quantity: Math.max(0, Math.min(999999, Math.trunc(Number(product.quantity) || 0))),
    pricePkn: Number(product.pricePkn) > 0 ? Number(product.pricePkn) : 0,
  };
}

/**
 * Dashboard price for a 1-Day Ready row. Today's sold median only.
 * A CardTrader ask or EUR conversion stored on the row is not shown.
 */
function marketPricePkn(row = {}) {
  const market = Number(row.market_pkn ?? row.marketPkn);
  if (!(market > 0)) return null;
  return Math.round(market * 100) / 100;
}

/** Sold price for today, keyed by CardTrader blueprint. Own asks stay off the row. */
function applyDumpMinimums(rows, priceRows) {
  const byId = new Map();
  for (const price of priceRows || []) {
    const id = String(price.blueprint_id || '');
    const pkn = Number(price.pkn);
    if (id && pkn > 0) byId.set(id, pkn);
  }
  return (rows || []).map((row) => {
    const market = byId.get(String(row.blueprint_id || ''));
    return { ...row, market_pkn: market > 0 ? market : null };
  });
}

/** Quantity-weighted totals of 1-Day Ready assets; empty stacks do not count. */
function oneDayReadyTotals(rows = []) {
  let products = 0;
  let cards = 0;
  let valuePkn = 0;
  for (const row of rows) {
    const qty = Math.max(0, Math.trunc(Number(row.quantity) || 0));
    if (!qty) continue;
    products += 1;
    cards += qty;
    valuePkn += qty * Math.max(0, Number(row.pricePkn ?? row.price_pkn) || 0);
  }
  return { products, cards, valuePkn: Math.round(valuePkn * 100) / 100 };
}

module.exports = {
  CT_PREFIX,
  POKEMON_GAME_ID,
  PKN_USDT_PRICE,
  SOURCE_IMPORT,
  claimSaleEventOnce,
  cleanText,
  ctConditionToPokoin,
  ctLanguageToPokoin,
  ctSourceListingId,
  destructiveReconcileGate,
  emptySummary,
  eurPriceFromProduct,
  facetKey,
  isCtLinkedSource,
  isPokemonProduct,
  normalizeProduct,
  applyDumpMinimums,
  marketPricePkn,
  oneDayReadyAssetRow,
  oneDayReadyTotals,
  parseCtProductId,
  parsePokoinListingId,
  planInventoryReconcile,
  pknFromProduct,
  publicCardIdFromBlueprint,
  resolveProductAttachment,
};
