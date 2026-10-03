// Pure cart rules behind the Amazon-layout /cart: which rows check out,
// seller parcels and their shipping preview, live-listing reconcile, the
// Saved-for-later moves and Buy-it-again. No React — node:test covers them.

import ratesCatalog from './shipping-rates.json' with { type: 'json' };
import { isSoldOrder } from './order-status.js';
import { conditionTone, listingLanguageCode } from './listing-meta.js';
import { defaultShippingService, previewShipment, shippingServiceOptions } from './shipping-quote.js';

/** Rows default to selected, like Amazon's basket; only an explicit false opts out. */
export function isSelected(row) {
  return row?.selected !== false;
}

export function rowQty(row) {
  return Math.max(0, Math.trunc(Number(row?.qty) || 0));
}

export function rowTotalPkn(row) {
  return (Number(row?.pricePkn) || 0) * rowQty(row);
}

/** Header badge counts every copy; the Subtotal counts only the ticked rows. */
export function cartTotals(items = []) {
  const totals = {
    lines: 0,
    count: 0,
    subtotalPkn: 0,
    selectedLines: 0,
    selectedCount: 0,
    selectedSubtotalPkn: 0,
    allSelected: false,
  };
  for (const row of items || []) {
    const qty = rowQty(row);
    const line = rowTotalPkn(row);
    totals.lines += 1;
    totals.count += qty;
    totals.subtotalPkn += line;
    if (isSelected(row)) {
      totals.selectedLines += 1;
      totals.selectedCount += qty;
      totals.selectedSubtotalPkn += line;
    }
  }
  totals.allSelected = totals.lines > 0 && totals.selectedLines === totals.lines;
  return totals;
}

/** "Deselect all items" when every row is ticked, otherwise "Select all items". */
export function nextSelectAll(items = []) {
  return !(items.length > 0 && items.every(isSelected));
}

export function sellerKeyOf(row) {
  const uid = String(row?.sellerUid || '').trim();
  if (uid) return uid;
  return `name:${String(row?.sellerName || 'pokoin').trim().toLowerCase()}`;
}

/** One group per seller in first-seen order — each group ships as one parcel. */
export function groupBySeller(items = []) {
  const groups = new Map();
  for (const row of items || []) {
    const key = sellerKeyOf(row);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        sellerUid: String(row?.sellerUid || ''),
        sellerName: String(row?.sellerName || ''),
        sellerUsername: String(row?.sellerUsername || ''),
        sellerCountry: '',
        rows: [],
        count: 0,
        selectedCount: 0,
        subtotalPkn: 0,
        selectedSubtotalPkn: 0,
      };
      groups.set(key, group);
    }
    const qty = rowQty(row);
    group.rows.push(row);
    group.count += qty;
    group.subtotalPkn += rowTotalPkn(row);
    if (isSelected(row)) {
      group.selectedCount += qty;
      group.selectedSubtotalPkn += rowTotalPkn(row);
    }
    group.sellerCountry = group.sellerCountry || String(row?.sellerCountry || '').trim().toUpperCase();
    group.sellerUsername = group.sellerUsername || String(row?.sellerUsername || '');
    group.sellerName = group.sellerName || String(row?.sellerName || '');
  }
  return [...groups.values()];
}

const TIERS = [...(ratesCatalog.tiers || [])].sort((a, b) => a.maxCards - b.maxCards);

/** Cards past this many are not worth a "room for N more" line. */
export const PARCEL_ROOM_MAX = 200;

/**
 * One seller parcel as checkout would first quote it: the pre-selected
 * service (a few cards go as the untracked letter) and how many more cards
 * ride in the same parcel before that service's price changes.
 */
export function parcelEstimate({ from, to, cards, serviceId: preferredId } = {}) {
  const n = Math.max(0, Math.trunc(Number(cards) || 0));
  const fromCode = String(from || '').trim().toUpperCase();
  const toCode = String(to || '').trim().toUpperCase();
  if (n < 1 || !/^[A-Z]{2}$/.test(fromCode) || !/^[A-Z]{2}$/.test(toCode)) return null;
  const options = shippingServiceOptions({ fromCountry: fromCode, toCountry: toCode, cardCount: n })
    .filter((row) => !row.unavailable);
  if (!options.length) return null;
  const preferred = options.find((row) => row.id === preferredId);
  const serviceId = preferred ? preferred.id : defaultShippingService(options);
  const picked = options.find((row) => row.id === serviceId) || options[0];
  const tracked = picked.tracked !== false;
  let room = 0;
  for (const tier of TIERS) {
    const max = Number(tier.maxCards) || 0;
    if (max < n) continue;
    const at = previewShipment({ fromCountry: fromCode, toCountry: toCode, cardCount: max, tracked });
    if (!at || at.amountCents !== picked.amountCents || at.tracked !== tracked) break;
    room = max - n;
  }
  return {
    amountCents: Number(picked.amountCents) || 0,
    tracked,
    serviceName: picked.serviceName || '',
    carrier: picked.carrier || '',
    packageTier: picked.packageTier || '',
    room: Math.min(room, PARCEL_ROOM_MAX),
  };
}

/** Shipping preview for the ticked rows: one parcel per seller. */
export function shippingEstimate(groups = [], to = '', serviceId = '') {
  const parcels = [];
  let cents = 0;
  let missing = 0;
  for (const group of groups || []) {
    if (!group.selectedCount) continue;
    const estimate = parcelEstimate({
      from: group.sellerCountry,
      to,
      cards: group.selectedCount,
      serviceId,
    });
    parcels.push({ key: group.key, estimate });
    if (estimate) cents += estimate.amountCents;
    else missing += 1;
  }
  return { parcels, cents, missing, count: parcels.length };
}

/**
 * Pokoin's "Add €30.21 to qualify for FREE Delivery": the ticked parcel with
 * the dearest shipping that still has room for more cards at the same price.
 */
export function parcelNudge(groups = [], to = '', serviceId = '') {
  let best = null;
  for (const group of groups || []) {
    if (!group.selectedCount) continue;
    const estimate = parcelEstimate({
      from: group.sellerCountry,
      to,
      cards: group.selectedCount,
      serviceId,
    });
    if (!estimate || estimate.room < 1) continue;
    if (!best || estimate.amountCents > best.estimate.amountCents) {
      best = { group, estimate };
    }
  }
  return best;
}

function liveStock(offer) {
  return Math.max(0, Math.trunc(Number(offer?.quantityAvailable ?? offer?.quantity_available) || 0));
}

function facetKey(row) {
  return [
    conditionTone(row?.condition) || 'nm',
    listingLanguageCode(row?.language) || '',
    row?.reverse ? 'r' : '',
    row?.firstEdition ? '1' : '',
    row?.graded ? `g:${row?.gradingCompany || ''}:${row?.grade || ''}` : '',
    row?.signed ? 's' : '',
  ].join('|');
}

/** Other live copies of the same printing, condition, language and finish, cheapest first. */
export function equivalentCopies(row, listings = [], { excludeSellerUid = '' } = {}) {
  const want = facetKey(row);
  const own = String(row?.listingId || '');
  const skip = String(excludeSellerUid || '');
  return (listings || [])
    .filter((offer) => {
      const id = String(offer?.id || '');
      if (!id || id === own) return false;
      if (skip && String(offer?.sellerUid || '') === skip) return false;
      if (liveStock(offer) < 1 || !(Number(offer?.pricePkn) > 0)) return false;
      return facetKey(offer) === want;
    })
    .sort((a, b) => Number(a.pricePkn) - Number(b.pricePkn));
}

/** The cheapest equivalent copy, only when it beats this row's price. */
export function cheaperCopy(row, listings = [], options = {}) {
  const price = Number(row?.pricePkn) || 0;
  if (!(price > 0)) return null;
  const best = equivalentCopies(row, listings, options)[0] || null;
  return best && Number(best.pricePkn) < price ? best : null;
}

/**
 * Compare one cart row with its card's live native listings. `complete`
 * means the call returned the whole book, so a missing listing id really
 * sold or was withdrawn; otherwise a miss stays "unknown".
 *
 * Returns { status: ok | gone | unknown, patch, priceChange, qtyCapped, stock, cheaper }.
 * The patch is what the cart row should hold now: live price, live stock,
 * quantity capped at stock, and a gone row unticked so checkout cannot fail on it.
 * For a gone row `cheaper` is the cheapest equivalent copy at any price — the replacement.
 */
export function reconcileRow(row, listings = [], { complete = true, excludeSellerUid = '' } = {}) {
  const rows = Array.isArray(listings) ? listings : [];
  const id = String(row?.listingId || '');
  const live = id ? rows.find((offer) => String(offer?.id || '') === id) : null;
  const stock = live ? liveStock(live) : 0;
  if (!live || stock < 1) {
    if (!live && !complete) {
      return {
        status: 'unknown',
        patch: {},
        priceChange: null,
        qtyCapped: null,
        stock: null,
        cheaper: cheaperCopy(row, rows, { excludeSellerUid }),
      };
    }
    const patch = {};
    if (!row?.unavailable) patch.unavailable = true;
    if (isSelected(row)) patch.selected = false;
    return {
      status: 'gone',
      patch,
      priceChange: null,
      qtyCapped: null,
      stock: 0,
      cheaper: equivalentCopies(row, rows, { excludeSellerUid })[0] || null,
    };
  }
  const cheaper = cheaperCopy({ ...row, pricePkn: Number(live.pricePkn) || row?.pricePkn }, rows, { excludeSellerUid });
  const patch = {};
  const was = Number(row?.pricePkn) || 0;
  const now = Number(live.pricePkn) || 0;
  if (now > 0 && now !== was) patch.pricePkn = now;
  const cap = Math.min(99, stock);
  if (cap !== Number(row?.stock)) patch.stock = cap;
  const qty = rowQty(row) || 1;
  if (qty > cap) patch.qty = cap;
  const accepts = live.sellerAcceptsPkn !== false;
  if (accepts !== (row?.sellerAcceptsPkn !== false)) patch.sellerAcceptsPkn = accepts;
  if (row?.unavailable) patch.unavailable = false;
  return {
    status: 'ok',
    patch,
    priceChange: patch.pricePkn ? { from: was, to: now } : null,
    qtyCapped: patch.qty ? { from: qty, to: cap } : null,
    stock,
    cheaper,
  };
}

/**
 * Amazon's "Important messages about items in your basket" for one card's
 * live check: price moved, quantity capped at the seller's stock, copy sold.
 */
export function liveMessages(rows = [], entry = {}, options = {}) {
  const out = [];
  for (const row of rows || []) {
    const result = reconcileRow(row, entry.listings, { complete: entry.complete !== false, ...options });
    const base = {
      rowId: row.id,
      cardId: String(row.cardId || ''),
      name: String(row.name || 'Card'),
      sellerName: String(row.sellerName || ''),
      sellerUsername: String(row.sellerUsername || ''),
      href: row.href || '',
    };
    if (result.status === 'gone' && !row.unavailable) {
      out.push({ ...base, id: `${row.id}:gone`, kind: 'gone' });
      continue;
    }
    if (result.priceChange) {
      out.push({
        ...base,
        id: `${row.id}:price`,
        kind: result.priceChange.to > result.priceChange.from ? 'price_up' : 'price_down',
        from: result.priceChange.from,
        to: result.priceChange.to,
      });
    }
    if (result.qtyCapped) {
      out.push({ ...base, id: `${row.id}:qty`, kind: 'qty', from: result.qtyCapped.from, to: result.qtyCapped.to });
    }
  }
  return out;
}

/** Amazon "Was:" — the price when this copy first went in the cart, if it has dropped since. */
export function priceDrop(row) {
  const was = Number(row?.addedPricePkn) || 0;
  const now = Number(row?.pricePkn) || 0;
  if (!(now > 0) || !(was > now)) return null;
  const percent = Math.round(((was - now) / was) * 100);
  return percent >= 1 ? { was, now, percent } : null;
}

/** Move one row between two lists (cart ↔ saved); the moved row lands on top. */
export function moveRow(from = [], to = [], id, max = 400) {
  const row = (from || []).find((item) => item.id === id);
  if (!row) return { from, to, row: null };
  return {
    from: from.filter((item) => item.id !== id),
    to: [row, ...(to || []).filter((item) => item.id !== id)].slice(0, max),
    row,
  };
}

/**
 * Rows a finished checkout takes out of the cart: the row ids recorded when
 * it started, else the listings of the paid order. With neither, nothing is
 * removed — a paid copy left behind turns sold out on the next live check,
 * which beats deleting rows that were never in that order.
 */
export function settleCheckoutRows(items = [], { rowIds = [], listingIds = [] } = {}) {
  const rows = new Set((rowIds || []).map(String).filter(Boolean));
  const listings = new Set((listingIds || []).map(String).filter(Boolean));
  if (!rows.size && !listings.size) return items;
  const next = items.filter((row) => !rows.has(String(row.id)) && !listings.has(String(row.listingId || '')));
  return next.length === items.length ? items : next;
}

function unionRows(local = [], remote = [], max = 400) {
  const out = [];
  const seen = new Set();
  for (const row of [...local, ...remote]) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * What the browser cart becomes when it meets the account cart on sign-in or
 * page load. `meta` is this browser's sync record { uid, rev, dirty }.
 *
 * - Same account, nothing unsynced here: the account copy wins (another
 *   device may have changed it) unless it is older than what this browser
 *   last saved (replica lag) — then keep local and do nothing.
 * - Guest cart (never synced) or unsynced edits: union, the browser's copy of
 *   a shared line wins, browser lines first; the result must be saved.
 * - A different account last synced here: take this account's cart as is,
 *   never merge one person's cart into another's.
 *
 * Returns { state, save } — `save` means PUT the state back.
 */
export function mergeCartStates(local, remote, meta = {}, uid = '') {
  const remoteState = { items: remote?.items || [], saved: remote?.saved || [], gift: Boolean(remote?.gift) };
  const localState = { items: local?.items || [], saved: local?.saved || [], gift: Boolean(local?.gift) };
  const remoteRev = Number(remote?.rev) || 0;
  const knownRev = Number(meta?.rev) || 0;
  if (meta?.uid && meta.uid !== uid) {
    return { state: remoteState, save: false };
  }
  if (meta?.uid === uid && !meta?.dirty) {
    if (remoteRev < knownRev) return { state: localState, save: false };
    return { state: remoteState, save: false };
  }
  const empty = !localState.items.length && !localState.saved.length && !localState.gift;
  if (empty) return { state: remoteState, save: false };
  return {
    state: {
      items: unionRows(localState.items, remoteState.items, 400),
      saved: unionRows(localState.saved, remoteState.saved, 200)
        .filter((row) => !localState.items.some((item) => item.id === row.id)),
      gift: localState.gift || remoteState.gift,
    },
    save: true,
  };
}

/** Comparable fingerprint of a cart state, to tell real edits from sync echoes. */
export function cartSignature({ items = [], saved = [], gift = false } = {}) {
  return JSON.stringify([items, saved, Boolean(gift)]);
}

function msFrom(value) {
  if (!value) return 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Cards from paid orders, newest purchase first, one entry per card. */
export function buyAgainCards(orders = [], { limit = 24 } = {}) {
  const sorted = (orders || [])
    .filter((order) => isSoldOrder(order))
    .sort((a, b) => msFrom(b.createdAt) - msFrom(a.createdAt));
  const seen = new Set();
  const out = [];
  for (const order of sorted) {
    for (const item of Array.isArray(order.items) ? order.items : []) {
      const id = String(item?.card?.id || item?.cardId || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        cardId: id,
        name: String(item?.card?.name || item?.cardName || ''),
        purchasedAt: msFrom(order.createdAt),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** "Purchased Sep 2026". */
export function purchasedLabel(ms) {
  if (!(Number(ms) > 0)) return '';
  const date = new Date(Number(ms));
  return `Purchased ${date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
}

/** Carousel "Page 1 of 3" from the track's scroll geometry. */
export function carouselPage({ scrollLeft = 0, clientWidth = 0, scrollWidth = 0 } = {}) {
  if (!(clientWidth > 0) || !(scrollWidth > 0)) return { page: 1, pages: 1 };
  const pages = Math.max(1, Math.ceil((scrollWidth - 2) / clientWidth));
  if (scrollLeft + clientWidth >= scrollWidth - 2) return { page: pages, pages };
  return { page: Math.min(pages, Math.floor((scrollLeft + 2) / clientWidth) + 1), pages };
}
