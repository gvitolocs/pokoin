// Browser cart rows: storage keys, the localStorage read/write guards and the
// row edits (add, quantity, remove) behind useCart(). No React, so the Solid
// UI writes the same rows with the same rules (market/src/cart.jsx wraps it).

import { pruneStoredCardPages } from './card-page-cache.js';
import { cartImageFor, repairCartImage } from './cart-image.js';
import { listingStock, nextCartQty } from './cart-qty.js';

export const CART_KEY = 'pokoin.cartItems';
export const SAVED_KEY = 'pokoin.cartSaved';
export const GIFT_KEY = 'pokoin.cartGift';
export const CART_MAX = 400;
export const SAVED_MAX = 200;

export function readCartRows(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((row) => row && row.id).map((row) => ({
        ...row,
        image: repairCartImage(row) || row.image || '',
        // Rows saved before price tracking: today's price is the reference.
        addedPricePkn: Number(row.addedPricePkn) || Number(row.pricePkn) || 0,
      }))
      : [];
  } catch (_) {
    return [];
  }
}

/** Account-cart rows from the API back into the browser's row shape. */
export function fromAccountRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row && row.id).map((row) => ({
    ...row,
    card: { id: String(row.cardId || ''), name: row.name || 'Card' },
    image: repairCartImage(row) || row.image || '',
  }));
}

/** Never throws: an uncaught quota error here unmounted the app (black screen). */
export function writeCartRows(items) {
  const raw = JSON.stringify(items.slice(0, CART_MAX));
  try {
    localStorage.setItem(CART_KEY, raw);
  } catch (_) {
    pruneStoredCardPages(0);
    try {
      localStorage.setItem(CART_KEY, raw);
    } catch (__) {
      /* storage full or private mode: the cart lives in memory this session */
    }
  }
}

/** Saved for later: same row shape as the cart, same quota guard. */
export function writeSavedRows(items) {
  const raw = JSON.stringify(items.slice(0, SAVED_MAX));
  try {
    localStorage.setItem(SAVED_KEY, raw);
  } catch (_) {
    pruneStoredCardPages(0);
    try {
      localStorage.setItem(SAVED_KEY, raw);
    } catch (__) {
      /* storage full or private mode: the list lives in memory this session */
    }
  }
}

export function writeCartFlag(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (_) {
    /* private mode: the flag lives in memory this session */
  }
}

export function readCartGift() {
  try {
    return localStorage.getItem(GIFT_KEY) === '1';
  } catch (_) {
    return false;
  }
}

export function cartItemFromOffer(card, offer) {
  const stock = listingStock(offer);
  const pricePkn = Number(offer?.pricePkn) || 0;
  return {
    id: String(offer?.id || `${card.id}-${offer?.sellerName || 'listing'}`),
    listingId: String(offer?.id || offer?.listingId || ''),
    sellerUid: String(offer?.sellerUid || offer?.seller_uid || ''),
    cardId: String(card.id),
    name: card.name || 'Card',
    image: cartImageFor(card, offer),
    pricePkn,
    // Amazon "Was:" — the price when this copy first went in the cart.
    addedPricePkn: pricePkn,
    addedAt: Date.now(),
    // false = seller takes card payments only (local currency first in the bag).
    sellerAcceptsPkn: offer?.sellerAcceptsPkn !== false,
    qty: Math.min(stock, Math.max(1, Math.trunc(Number(offer?.qty) || 1))),
    stock,
    selected: true,
    condition: offer?.condition || 'NM',
    language: offer?.language || '',
    reverse: Boolean(offer?.reverse),
    firstEdition: Boolean(offer?.firstEdition),
    graded: Boolean(offer?.graded),
    gradingCompany: offer?.gradingCompany || '',
    grade: offer?.grade || '',
    signed: Boolean(offer?.signed),
    sealed: Boolean(offer?.sealed),
    setName: String(offer?.setName || card?.set || card?.expansion || ''),
    collectorNumber: String(offer?.collectorNumber || offer?.publicNumber || ''),
    sellerName: offer?.sellerName || offer?.sellerDisplayName || 'Pokoin',
    sellerUsername: String(offer?.sellerUsername || '').replace(/^@/, ''),
    sellerCountry: String(offer?.sellerCountry || offer?.seller_country || offer?.shipFromCountry || '').trim().toUpperCase(),
    nftAvailable: Boolean(offer?.nftAvailable || offer?.isNftEligible),
    reserveAvailable: Boolean(offer?.reserveAvailable),
    href: card.canonicalPath || `/marketplace/en/cards/${card.id}`,
    card: { id: String(card.id), name: card.name || 'Card' },
  };
}

/** Add a copy: a row already in the cart gains qty (capped by stock) and is re-ticked. */
export function addCartRow(current, next) {
  const match = current.find((row) => row.id === next.id);
  if (match) {
    const stock = listingStock(next.stock != null ? next : match);
    return current.map((row) => (
      row.id === next.id
        ? { ...row, stock, qty: nextCartQty(row.qty, next.qty, stock), selected: true }
        : row
    ));
  }
  return [next, ...current].slice(0, CART_MAX);
}

/** Adding a saved copy moves it back rather than keeping it in both lists. */
export function dropSavedRow(saved, id) {
  return saved.some((row) => row.id === id) ? saved.filter((row) => row.id !== id) : saved;
}

/** Quantity below 1 removes the row; above stock is capped. */
export function setCartRowQty(current, id, qty) {
  const row = current.find((item) => item.id === id);
  const cap = row ? listingStock(row) : 99;
  const next = Math.max(0, Math.min(cap, Number.parseInt(qty, 10) || 0));
  return next < 1
    ? current.filter((item) => item.id !== id)
    : current.map((item) => (item.id === id ? { ...item, qty: next } : item));
}

export function removeCartRow(current, id) {
  return current.filter((row) => row.id !== id);
}
