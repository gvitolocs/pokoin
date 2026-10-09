// Browser cart rows (localStorage) without React: the row shape, the storage
// keys and the add reducer that market/src/cart.jsx and the Solid cart store
// share, so both UIs read and write one cart.

import { pruneStoredCardPages } from './card-page-cache.js';
import { cartImageFor, repairCartImage } from './cart-image.js';
import { listingStock, nextCartQty } from './cart-qty.js';

export const CART_KEY = 'pokoin.cartItems';
export const SAVED_KEY = 'pokoin.cartSaved';
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

/** Never throws: an uncaught quota error here unmounted the app (black screen). */
export function writeCartRows(key, items, max) {
  const raw = JSON.stringify(items.slice(0, max));
  try {
    localStorage.setItem(key, raw);
  } catch (_) {
    pruneStoredCardPages(0);
    try {
      localStorage.setItem(key, raw);
    } catch (__) {
      /* storage full or private mode: the list lives in memory this session */
    }
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

/** Add a row (or top up the same listing's qty), newest first. */
export function addCartRow(current, next, max = CART_MAX) {
  const match = current.find((row) => row.id === next.id);
  if (match) {
    const stock = listingStock(next.stock != null ? next : match);
    return current.map((row) => (
      row.id === next.id
        ? { ...row, stock, qty: nextCartQty(row.qty, next.qty, stock), selected: true }
        : row
    ));
  }
  return [next, ...current].slice(0, max);
}

/** Adding a saved copy moves it back rather than keeping it in both lists. */
export function dropSavedRow(saved, id) {
  return saved.some((row) => row.id === id) ? saved.filter((row) => row.id !== id) : saved;
}
