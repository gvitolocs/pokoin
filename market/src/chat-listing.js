import { displayName } from './identity.js';
import { sellerHandle } from './listing-meta.js';

export const LISTING_DRAG_TYPE = 'application/x-pokoin-listing';

const CHAT_HANDLE = /^[a-z0-9]{3,32}$/;
const USER_ID = /^[A-Za-z0-9]{8,128}$/;

export function chatHandle(value) {
  const handle = String(value || '').trim().toLowerCase();
  return CHAT_HANDLE.test(handle) ? handle : '';
}

export function sellerUserId(value) {
  const uid = String(value || '').trim();
  return USER_ID.test(uid) ? uid : '';
}

export function listingReference({ offer, card }) {
  return {
    kind: 'listing',
    listingId: String(offer?.id || ''),
    cardId: String(card?.id || ''),
    sellerUid: sellerUserId(offer?.sellerUid || offer?.seller_uid),
    seller: chatHandle(sellerHandle(offer)),
    cardName: card?.name || offer?.cardName || offer?.name || 'Card',
    setName: String(offer?.setName || ''),
    imageUrl: offer?.cardImageUrl || card?.heroImageUrl || card?.imageUrl || card?.gridImageUrl || '',
    path: card?.canonicalPath || offer?.canonicalPath || offer?.canonical_path || '',
    pricePkn: Number(offer?.pricePkn) || 0,
  };
}

export function cardReference(card) {
  return {
    kind: 'card',
    listingId: '',
    cardId: String(card?.id || ''),
    sellerUid: '',
    seller: '',
    cardName: displayName(card) || card?.name || 'Card',
    setName: '',
    imageUrl: card?.heroImageUrl || card?.imageUrl || card?.gridImageUrl || '',
    path: card?.canonicalPath || '',
    pricePkn: Number(card?.pricePkn) || 0,
  };
}

export function tagKey(row) {
  return `${row?.kind || 'listing'}:${row?.listingId || row?.cardId || row?.cardName || ''}`;
}

export function appendChatTag(tags, reference) {
  if (!reference?.cardName) return tags;
  const key = tagKey(reference);
  if ((tags || []).some((row) => tagKey(row) === key)) return tags;
  return [...(tags || []), reference].slice(-4);
}

export function writeListingDrag(event, reference) {
  if (!event?.dataTransfer || !reference?.cardName) return;
  event.dataTransfer.setData(LISTING_DRAG_TYPE, JSON.stringify(reference));
  event.dataTransfer.effectAllowed = 'copy';
}

export function readListingDrag(event) {
  const raw = event?.dataTransfer?.getData?.(LISTING_DRAG_TYPE);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data.cardName !== 'string' || !data.cardName.trim()) return null;
    return data;
  } catch (_) {
    return null;
  }
}
