'use strict';

/**
 * Account cart for pokoin.com/cart: cart lines, Saved for later and the gift
 * flag, one row per Firebase user in public.marketplace_user_carts on the
 * nezopt writer (the Pi replica streams it). Rows are the SPA's own cart
 * lines, cleaned to a fixed field list so the table never stores arbitrary
 * client blobs. `card_ids` (cart + saved) feeds "customers also carried".
 *
 * Writes are revision-checked: a PUT carries the revision it was based on and
 * loses (409 + current state) when another device saved in between.
 */

const CART_MAX = 400;
const SAVED_MAX = 200;

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function bool(value) {
  return value === true || value === 'true' || value === 1;
}

function count(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1e9, Math.round(n * 100) / 100);
}

function digits(value, max = 20) {
  const id = text(value, max);
  return /^\d+$/.test(id) ? id : '';
}

/** Only app paths: no protocol-relative or scheme links survive. */
function appPath(value) {
  const path = text(value, 800);
  return path.startsWith('/') && !path.startsWith('//') && !/[\s<>"']/.test(path) ? path : '';
}

/** App path or https URL for a card scan. */
function imageUrl(value) {
  const url = text(value, 800);
  if (url.startsWith('/') && !url.startsWith('//')) return /[\s<>"']/.test(url) ? '' : url;
  return /^https:\/\/[^\s<>"']+$/.test(url) ? url : '';
}

/** One cart line as the SPA stores it, minus anything it does not need. */
function cleanCartRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = text(raw.id, 80);
  const cardId = digits(raw.cardId ?? raw.card?.id);
  if (!id || !cardId) return null;
  const pricePkn = money(raw.pricePkn);
  return {
    id,
    listingId: text(raw.listingId, 80),
    sellerUid: text(raw.sellerUid, 160),
    cardId,
    name: text(raw.name ?? raw.card?.name, 240) || 'Card',
    image: imageUrl(raw.image),
    href: appPath(raw.href),
    pricePkn,
    addedPricePkn: money(raw.addedPricePkn) || pricePkn,
    addedAt: count(raw.addedAt, 0, 4102444800000, 0),
    sellerAcceptsPkn: raw.sellerAcceptsPkn !== false,
    qty: count(raw.qty, 1, 99, 1),
    stock: count(raw.stock, 1, 99, 1),
    selected: raw.selected !== false,
    unavailable: bool(raw.unavailable),
    condition: text(raw.condition, 40),
    language: text(raw.language, 16),
    reverse: bool(raw.reverse),
    firstEdition: bool(raw.firstEdition),
    graded: bool(raw.graded),
    gradingCompany: text(raw.gradingCompany, 40),
    grade: text(raw.grade, 20),
    signed: bool(raw.signed),
    sealed: bool(raw.sealed),
    setName: text(raw.setName, 240),
    collectorNumber: text(raw.collectorNumber, 80),
    sellerName: text(raw.sellerName, 120),
    sellerUsername: text(raw.sellerUsername, 64).replace(/^@/, ''),
    sellerCountry: text(raw.sellerCountry, 8).toUpperCase(),
    nftAvailable: bool(raw.nftAvailable),
    reserveAvailable: bool(raw.reserveAvailable),
    game: text(raw.game, 40),
  };
}

function cleanRows(list, max) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const row = cleanCartRow(raw);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

/** Whole account cart from a PUT body or a stored row. */
function cleanCartState(raw = {}) {
  return {
    items: cleanRows(raw.items, CART_MAX),
    saved: cleanRows(raw.saved, SAVED_MAX),
    gift: bool(raw.gift),
  };
}

/** Distinct numeric card ids across cart and saved, for the overlap index. */
function cartCardIds(state) {
  const ids = new Set();
  for (const row of [...(state.items || []), ...(state.saved || [])]) {
    if (row.cardId) ids.add(row.cardId);
  }
  return [...ids].slice(0, CART_MAX + SAVED_MAX);
}

function emptyCart() {
  return { items: [], saved: [], gift: false, rev: 0, updatedAt: null };
}

function isUndefinedTable(error) {
  return error?.code === '42P01' || /relation .* does not exist/i.test(String(error?.message || ''));
}

function fromRow(row) {
  if (!row) return emptyCart();
  const state = cleanCartState({ items: row.items, saved: row.saved, gift: row.gift });
  return {
    ...state,
    rev: Number(row.rev) || 0,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

const SELECT_CART = `
  select items, saved, gift, rev, updated_at
    from public.marketplace_user_carts
   where user_uid = $1
   limit 1`;

async function readCart(query, uid) {
  try {
    const result = await query(SELECT_CART, [uid]);
    return fromRow(result.rows?.[0]);
  } catch (error) {
    if (isUndefinedTable(error)) return emptyCart();
    throw error;
  }
}

/**
 * Save the account cart if nobody saved since `baseRev`. Returns
 * { ok: true, cart } or { ok: false, cart: <current> } on a lost race.
 */
async function writeCart(writeQuery, uid, raw, baseRev) {
  const state = cleanCartState(raw);
  const base = Math.max(0, Math.trunc(Number(baseRev) || 0));
  const result = await writeQuery(
    `insert into public.marketplace_user_carts (user_uid, items, saved, gift, card_ids, rev, updated_at)
     values ($1, $2::jsonb, $3::jsonb, $4, $5::bigint[], 1, now())
     on conflict (user_uid) do update
        set items = excluded.items,
            saved = excluded.saved,
            gift = excluded.gift,
            card_ids = excluded.card_ids,
            rev = public.marketplace_user_carts.rev + 1,
            updated_at = now()
      where public.marketplace_user_carts.rev = $6
     returning items, saved, gift, rev, updated_at`,
    [
      uid,
      JSON.stringify(state.items),
      JSON.stringify(state.saved),
      state.gift,
      cartCardIds(state),
      base,
    ],
  );
  const row = result.rows?.[0];
  if (row) return { ok: true, cart: fromRow(row) };
  const current = await writeQuery(SELECT_CART, [uid]);
  return { ok: false, cart: fromRow(current.rows?.[0]) };
}

module.exports = {
  CART_MAX,
  SAVED_MAX,
  cleanCartRow,
  cleanCartState,
  cartCardIds,
  emptyCart,
  isUndefinedTable,
  readCart,
  writeCart,
};
