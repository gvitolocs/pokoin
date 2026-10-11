// Formatting and card stubs behind the Amazon-layout cart pieces
// (components/Basket.jsx, components/BasketShelf.jsx and their Solid ports).

import { gameBasename } from './game.js';
import { publicShopSellerLabel } from './listing-meta.js';
import { moneyFromPkn } from './pkn.js';

/** Copies left at or under this read "Only N left from this seller". */
export const LOW_STOCK = 3;

/** Amazon's price parts in local fiat: symbol, whole, cents (null when not convertible). */
export function fiatParts(pricePkn, currency) {
  const money = moneyFromPkn(pricePkn, currency);
  if (!money?.amount) return null;
  const [int, dec] = money.amount.split('.');
  if (currency === 'DKK') return { pre: '', int, dec, post: 'DKK' };
  if (currency === 'USD') return { pre: '$', int, dec, post: '' };
  return { pre: '€', int, dec, post: '' };
}

/** Native share sheet, else copy the card link. Returns the label to flash ('' when nothing happened). */
export async function shareCartRow(row) {
  const url = new URL(`${gameBasename()}${row.href || '/marketplace'}`, window.location.origin).href;
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: row.name, url });
      return 'Shared';
    } catch (err) {
      if (err?.name === 'AbortError') return '';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'Link copied';
  } catch (_) {
    return '';
  }
}

export function basketSellerOf(offer) {
  return publicShopSellerLabel(offer) || offer?.sellerName || 'Pokoin';
}

const MESSAGE_TEXT = {
  price_up: (note, fmt) => `The price of ${note.name} from ${basketSellerOf(note)} went up from ${fmt(note.from)} to ${fmt(note.to)}.`,
  price_down: (note, fmt) => `${note.name} from ${basketSellerOf(note)} dropped from ${fmt(note.from)} to ${fmt(note.to)}.`,
  qty: (note) => `${basketSellerOf(note)} has only ${note.to} of ${note.name} left, so the quantity went from ${note.from} to ${note.to}.`,
  gone: (note) => `${note.name} from ${basketSellerOf(note)} is no longer available. It is unticked and stays below until you delete it.`,
};

/** One "Important messages about items in your cart" line; `fmt` formats a PKN price. */
export function basketMessageText(note, fmt) {
  return (MESSAGE_TEXT[note.kind] || (() => ''))(note, fmt);
}

/** "Save 12%" for a cheaper copy of the same card. */
export function cheaperSavePercent(cheaper, row) {
  return Math.max(1, Math.round((1 - Number(cheaper.pricePkn) / Number(row.pricePkn)) * 100));
}

/** A catalogue tile as the card half of cartItemFromOffer. */
export function tileStub(card) {
  return {
    id: String(card.id),
    name: card.name || 'Card',
    canonicalPath: card.canonicalPath || card.canonical_path || '',
    imageUrl: card.imageUrl || card.image_url || '',
    gridImageUrl: card.gridImageUrl || card.grid_image_url || '',
    heroImageUrl: card.heroImageUrl || '',
    homepageImageUrl: card.homepageImageUrl || card.homepage_image_url || '',
    set: card.set || card.expansion || card.setName || '',
  };
}

/** A seller-shop listing as the card half of cartItemFromOffer. */
export function listingStub(offer) {
  const id = String(offer.cardId || offer.card_id || '');
  return {
    id,
    name: offer.cardName || offer.name || 'Card',
    canonicalPath: offer.canonicalPath || offer.canonical_path || `/marketplace/en/cards/${id}`,
    imageUrl: offer.cardImageUrl || offer.imageUrl || '',
    homepageImageUrl: offer.homepageImageUrl || '',
    gridImageUrl: offer.gridImageUrl || '',
    set: offer.setName || '',
  };
}

/** A recommendation (card + offer) as the card half of cartItemFromOffer. */
export function offerStub(card, offer) {
  const id = String(card?.id || card?.card_id || offer?.cardId || '');
  return {
    id,
    name: card?.name || offer?.cardName || 'Card',
    canonicalPath: card?.canonicalPath || card?.canonical_path || offer?.canonicalPath || `/marketplace/en/cards/${id}`,
    imageUrl: card?.imageUrl || card?.image_url || offer?.cardImageUrl || '',
    gridImageUrl: card?.gridImageUrl || '',
    heroImageUrl: card?.heroImageUrl || '',
    homepageImageUrl: card?.homepageImageUrl || '',
    set: card?.set || card?.set_name || offer?.setName || '',
  };
}

/** A cart row's card, rebuilt for a swap to another copy. */
export function rowCardStub(row) {
  return {
    id: row.cardId,
    name: row.name,
    canonicalPath: row.href,
    imageUrl: row.image,
    set: row.setName,
  };
}

/** Where the "… was removed" note sits: before the first later row of that seller, else at its end. */
export function removedNoteSlot(removed, groups, items, sellerKeyOf) {
  if (!removed || removed.all) return null;
  const key = sellerKeyOf(removed.row);
  const group = groups.find((row) => row.key === key);
  if (!group) return null;
  const index = new Map(items.map((row, at) => [row.id, at]));
  const before = group.rows.find((row) => index.get(row.id) >= removed.index);
  return { groupKey: key, beforeId: before?.id || '' };
}

/** "Buy it again" fallback rows: paid cards the tile API does not know still show by name. */
export function buyAgainFallback(cards) {
  return cards.map((row) => ({
    id: row.cardId,
    name: row.name,
    canonicalPath: `/marketplace/en/cards/${row.cardId}`,
  }));
}
