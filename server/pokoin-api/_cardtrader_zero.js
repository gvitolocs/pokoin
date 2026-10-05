'use strict';

/**
 * CardTrader Zero picking list for a connected seller.
 *
 * CardTrader is the source of truth (API v2 Orders):
 *   - every Zero sale reaches the seller as an order with
 *     `via_cardtrader_zero: true` in state `hub_pending`;
 *   - once a week CardTrader merges them into ONE new order in state `paid`
 *     (still `via_cardtrader_zero: true`) and the merged sources become
 *     `closed`. That merged `paid` order is the weekly shipment to the hub —
 *     the list Power Tools shows on Thursday (`isCtZeroClosing`, picking list
 *     variant `cardtrader_zero`).
 *
 * Power Tools only mirrors those CardTrader orders (`sourceOrderId` = CT
 * order id), so it is an optional overlay here, never the source.
 */

const {
  cleanText,
  ctConditionToPokoin,
  ctLanguageToPokoin,
  ctSourceListingId,
  parsePokoinListingId,
  publicCardIdFromBlueprint,
} = require('./_cardtrader_inventory_sync_core');

const WEEKLY_STATE = 'paid';
const PENDING_STATE = 'hub_pending';

function isZeroOrder(order = {}) {
  return order?.via_cardtrader_zero === true;
}

function orderState(order = {}) {
  return cleanText(order.state, 40).toLowerCase();
}

function propertiesOf(item = {}) {
  const props = item.properties_hash || item.properties || {};
  return props && typeof props === 'object' ? props : {};
}

function truthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function languageOf(props = {}) {
  const raw = props.pokemon_language || props.mtg_language || props.language;
  return raw ? ctLanguageToPokoin(raw) : '';
}

function moneyCents(money) {
  if (money == null) return null;
  if (typeof money === 'object') {
    const cents = Number(money.cents);
    return Number.isFinite(cents) ? Math.round(cents) : null;
  }
  const value = Number(money);
  return Number.isFinite(value) ? Math.round(value) : null;
}

function moneyCurrency(money, fallback = 'EUR') {
  return cleanText(money?.currency, 8).toUpperCase() || fallback;
}

function quantityOf(item = {}) {
  return Math.max(0, Math.trunc(Number(item.quantity) || 0));
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** One CardTrader order item as a picking-list line. */
function zeroItemRow(order = {}, item = {}) {
  const props = propertiesOf(item);
  const productId = cleanText(item.product_id ?? item.productId ?? item.product?.id, 80);
  const blueprintId = cleanText(item.blueprint_id ?? item.blueprintId, 80);
  const unitCents = moneyCents(item.seller_price);
  const quantity = quantityOf(item);
  return {
    orderId: cleanText(order.id, 40),
    orderCode: cleanText(order.code, 80),
    itemId: cleanText(item.id, 40),
    productId,
    blueprintId,
    cardId: publicCardIdFromBlueprint(blueprintId),
    hubPendingOrderId: cleanText(item.hub_pending_order_id ?? item.hubPendingOrderId, 40),
    name: cleanText(item.name, 240) || 'Card',
    expansion: cleanText(item.expansion?.name ?? item.expansion, 160),
    collectorNumber: cleanText(props.collector_number ?? props.collectorNumber, 40),
    // Blank stays blank: an empty CardTrader language is the print language
    // (D00000F), never a default EN/NM on a picking list.
    condition: props.condition ? ctConditionToPokoin(props.condition) : '',
    language: languageOf(props),
    reverse: truthy(props.pokemon_reverse) || truthy(props.mtg_foil) || truthy(props.foil),
    firstEdition: truthy(props.pokemon_first_edition) || truthy(props.first_edition),
    signed: truthy(props.signed),
    altered: truthy(props.altered),
    graded: Boolean(item.graded) && item.graded !== 'false',
    quantity,
    unitCents,
    lineCents: unitCents == null ? null : unitCents * quantity,
    currency: moneyCurrency(item.seller_price),
    userDataField: cleanText(item.user_data_field ?? item.userDataField, 160),
    tag: cleanText(item.tag, 160),
    soldAt: iso(item.created_at || order.paid_at || order.created_at),
    location: '',
    listingId: parsePokoinListingId(item.user_data_field ?? item.userDataField),
    powerTools: null,
  };
}

function orderSummary(order = {}) {
  const items = (Array.isArray(order.order_items) ? order.order_items : [])
    .filter((item) => item && !item.deleted_at)
    .map((item) => zeroItemRow(order, item));
  return {
    orderId: cleanText(order.id, 40),
    code: cleanText(order.code, 80),
    state: orderState(order),
    paidAt: iso(order.paid_at),
    createdAt: iso(order.created_at),
    packingNumber: order.packing_number == null ? null : Number(order.packing_number),
    presale: order.presale === true,
    sellerTotalCents: moneyCents(order.seller_total),
    currency: moneyCurrency(order.seller_total),
    items,
  };
}

function totalsOf(items = []) {
  return {
    lines: items.length,
    units: items.reduce((sum, item) => sum + item.quantity, 0),
    cents: items.reduce((sum, item) => sum + (item.lineCents || 0), 0),
  };
}

/**
 * Split seller orders into the weekly shipment (merged `paid` Zero order) and
 * the Zero sales still waiting for the next weekly merge (`hub_pending`).
 * Direct (non-Zero) orders and `closed` merged sources are ignored, so an item
 * is never counted twice.
 */
function buildZeroList(orders = []) {
  const seen = new Set();
  const weekly = [];
  const pendingOrders = [];
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!isZeroOrder(order)) continue;
    const id = cleanText(order?.id, 40);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const state = orderState(order);
    if (state === WEEKLY_STATE) weekly.push(orderSummary(order));
    else if (state === PENDING_STATE) pendingOrders.push(orderSummary(order));
  }
  weekly.sort((a, b) => String(b.paidAt || '').localeCompare(String(a.paidAt || '')));
  const pendingItems = pendingOrders.flatMap((order) => order.items);
  const weeklyItems = weekly.flatMap((order) => order.items);
  return {
    weekly,
    pending: {
      orderCount: pendingOrders.length,
      items: pendingItems,
    },
    totals: {
      weekly: totalsOf(weeklyItems),
      pending: totalsOf(pendingItems),
    },
  };
}

function allItems(list) {
  return [
    ...(list?.weekly || []).flatMap((order) => order.items),
    ...(list?.pending?.items || []),
  ];
}

/** CardTrader product ids → `ct:<id>` source ids of the linked Pokoin listings. */
function linkedSourceIds(list) {
  return [...new Set(allItems(list).map((item) => item.productId).filter(Boolean))]
    .map((productId) => ctSourceListingId(productId));
}

/**
 * Attach the seller's own Pokoin listing (MyPokoin location, card id) to each
 * line. `rows` are marketplace_user_listings rows of this seller.
 */
function attachPokoinListings(list, rows = []) {
  const byProduct = new Map();
  const byId = new Map();
  for (const row of rows || []) {
    const match = /^(?:ct|cardtrader):(\d+)$/i.exec(cleanText(row?.source_listing_id, 160));
    if (match) byProduct.set(match[1], row);
    if (row?.id) byId.set(String(row.id), row);
  }
  for (const item of allItems(list)) {
    const row = byProduct.get(item.productId) || (item.listingId ? byId.get(item.listingId) : null);
    if (!row) continue;
    item.listingId = cleanText(row.id, 80);
    item.location = cleanText(row.location, 64);
    if (row.card_id) item.cardId = cleanText(row.card_id, 80);
    if (!item.collectorNumber && row.collector_number) {
      item.collectorNumber = cleanText(row.collector_number, 40);
    }
    if (row.card_image_url) item.imageUrl = cleanText(row.card_image_url, 800);
  }
  return list;
}

function ptLocationName(article = {}) {
  const info = article.locationInfo && typeof article.locationInfo === 'object' ? article.locationInfo : null;
  const fromInfo = cleanText(info?.name, 120);
  if (fromInfo) return fromInfo;
  const names = (Array.isArray(article.locations) ? article.locations : [])
    .filter((loc) => Number(loc?.quantity) > 0 || Number(loc?.deltaQuantity) < 0)
    .map((loc) => cleanText(loc?.name, 120))
    .filter(Boolean);
  return names.join(', ');
}

/** Power Tools "" / unknown* location names, as its UI shows them. */
function ptDisplayLocation(name) {
  const value = cleanText(name, 120);
  if (!value) return '';
  if (/^unknown/i.test(value)) return '';
  return value;
}

/**
 * Overlay Power Tools order state on CardTrader lines. Power Tools keys
 * CardTrader orders by `sourceOrderId` (= CT order id) and articles by
 * `sourceArticleId` (CT order item id; product id accepted as a fallback).
 */
function attachPowerToolsOrders(list, ptOrders = []) {
  const orders = new Map();
  for (const order of Array.isArray(ptOrders) ? ptOrders : []) {
    if (cleanText(order?.source, 40).toLowerCase() !== 'cardtrader') continue;
    const id = cleanText(order?.sourceOrderId, 40);
    if (id) orders.set(id, order);
  }
  let matchedOrders = 0;
  let matchedItems = 0;
  const counted = new Set();
  for (const item of allItems(list)) {
    const order = orders.get(item.orderId)
      || (item.hubPendingOrderId ? orders.get(item.hubPendingOrderId) : null);
    if (!order) continue;
    if (!counted.has(order.sourceOrderId)) {
      counted.add(order.sourceOrderId);
      matchedOrders += 1;
    }
    const articles = Array.isArray(order.articles) ? order.articles : [];
    const index = articles.findIndex((row) => cleanText(row?.sourceArticleId, 40) === item.itemId);
    const fallback = index < 0
      ? articles.findIndex((row) => item.productId && cleanText(row?.sourceArticleId, 40) === item.productId)
      : index;
    const article = fallback >= 0 ? articles[fallback] : null;
    if (article) matchedItems += 1;
    item.powerTools = {
      orderState: cleanText(order.state?.state ?? order.state, 40),
      isCtZeroClosing: order.isCtZeroClosing === true,
      articleState: cleanText(article?.articleState ?? article?.state?.state ?? '', 40),
      pickedQuantity: article ? Math.max(0, Math.trunc(Number(article.pickedQuantity) || 0)) : null,
      location: article ? ptDisplayLocation(ptLocationName(article)) : '',
      bin: cleanText(article?.pickingId, 40),
      // Power Tools list order. An explicit position wins; otherwise the
      // article's place in the Power Tools order is the position.
      position: article ? ptArticlePosition(article, fallback) : null,
    };
  }
  return { matchedOrders, matchedItems, ptOrderCount: orders.size };
}

const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function pickLocation(item) {
  return item.location || item.powerTools?.location || '';
}

/** Box name, then each stock number from smaller to bigger. */
function locationRank(value) {
  const raw = String(value || '').trim();
  const nums = [];
  const name = raw.replace(/\d+/g, (n) => {
    nums.push(Number(n));
    return ' ';
  }).replace(/[·.\s]+/g, ' ').trim().toLowerCase();
  return { name, nums };
}

function compareLocations(a, b) {
  const ka = locationRank(a);
  const kb = locationRank(b);
  const name = COLLATOR.compare(ka.name, kb.name);
  if (name) return name;
  const len = Math.max(ka.nums.length, kb.nums.length);
  for (let i = 0; i < len; i += 1) {
    const da = ka.nums[i];
    const db = kb.nums[i];
    if (da == null) return -1;
    if (db == null) return 1;
    if (da !== db) return da - db;
  }
  return 0;
}

function ptArticlePosition(article, index) {
  // Power Tools assigns `pos` as the 0-based place in its article list.
  const pos = Number(article?.pos);
  if (Number.isFinite(pos) && pos >= 0) return pos + 1;
  const explicit = Number(article?.position ?? article?.pickingPosition ?? article?.sortIndex);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return index + 1;
}

/** Picking order: location box, then stock numbers small to big, then set and name. */
function comparePickingLines(a, b) {
  const la = pickLocation(a);
  const lb = pickLocation(b);
  if (!la !== !lb) return la ? -1 : 1;
  return compareLocations(la, lb)
    || COLLATOR.compare(a.expansion, b.expansion)
    || COLLATOR.compare(a.collectorNumber, b.collectorNumber)
    || COLLATOR.compare(a.name, b.name)
    || COLLATOR.compare(a.itemId, b.itemId);
}

function sortForPicking(list) {
  for (const order of list?.weekly || []) order.items.sort(comparePickingLines);
  list?.pending?.items?.sort(comparePickingLines);
  return list;
}

module.exports = {
  PENDING_STATE,
  WEEKLY_STATE,
  attachPokoinListings,
  attachPowerToolsOrders,
  buildZeroList,
  compareLocations,
  comparePickingLines,
  isZeroOrder,
  linkedSourceIds,
  ptDisplayLocation,
  sortForPicking,
  zeroItemRow,
};
