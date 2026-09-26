import { displayName } from './identity.js';
import { homepageDerivativeUrl, preferFullImage } from './image-urls.js';
import { sellerHandle } from './listing-meta.js';
import { tilePricePkn } from './pkn.js';

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

function cardImage(card, offer) {
  return String(
    offer?.cardImageUrl
    || offer?.imageUrl
    || card?.heroImageUrl
    || card?.imageUrl
    || card?.cdn_image_url
    || card?.image_url
    || card?.gridImageUrl
    || card?.tileImageUrl
    || card?.homepageImageUrl
    || '',
  ).trim();
}

function offerCopies(offer) {
  const n = Math.trunc(Number(offer?.quantityAvailable ?? offer?.quantity_available));
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(99, n);
}

export function listingReference({ offer, card }) {
  const stock = offerCopies(offer);
  return {
    kind: 'listing',
    listingId: String(offer?.id || ''),
    cardId: String(card?.id || ''),
    sellerUid: sellerUserId(offer?.sellerUid || offer?.seller_uid),
    seller: chatHandle(sellerHandle(offer)),
    cardName: card?.name || offer?.cardName || offer?.name || 'Card',
    setName: String(offer?.setName || ''),
    imageUrl: cardImage(card, offer),
    path: card?.canonicalPath || offer?.canonicalPath || offer?.canonical_path || '',
    pricePkn: Number(offer?.pricePkn) || 0,
    ...(stock != null ? { stock } : {}),
  };
}

export function cardReference(card) {
  return {
    kind: 'card',
    listingId: '',
    cardId: String(card?.id || card?.cardId || ''),
    sellerUid: '',
    seller: '',
    cardName: displayName(card) || card?.name || card?.cardName || 'Card',
    setName: '',
    imageUrl: cardImage(card),
    path: card?.canonicalPath || card?.path || '',
    pricePkn: Number(tilePricePkn(card) || card?.pricePkn) || 0,
  };
}

/** One drag for a Windows multi-select. A single card stays a normal card drag. */
export function cardsReference(cards) {
  const list = (cards || []).filter((card) => card?.id || card?.cardId).slice(0, 80);
  if (list.length === 1) return cardReference(list[0]);
  if (!list.length) return null;
  const first = cardReference(list[0]);
  return {
    kind: 'cards',
    listingId: '',
    cardId: first.cardId,
    sellerUid: '',
    seller: '',
    cardName: `${list.length} cards`,
    setName: '',
    imageUrl: first.imageUrl,
    path: '',
    pricePkn: 0,
    cards: list.map((card) => cardReference(card)),
  };
}

export function dragCardsOf(reference) {
  if (!reference) return [];
  if (reference.kind === 'cards' && Array.isArray(reference.cards)) {
    return reference.cards.filter((row) => row?.cardName);
  }
  return [reference];
}

export function tagKey(row) {
  return `${row?.kind || 'listing'}:${row?.listingId || row?.cardId || row?.cardName || ''}`;
}

/** 1–99, never past the copies this listing still has. */
export function listingQty(value, stock = 99) {
  const rawCap = Math.trunc(Number(stock));
  const cap = Number.isFinite(rawCap) && rawCap >= 1 ? Math.min(99, rawCap) : 99;
  const n = Math.trunc(Number(value));
  const qty = Number.isFinite(n) && n >= 1 ? n : 1;
  return Math.min(cap, qty);
}

/** Quantity the stepper can show, including a count past the seller's copies. */
export function chatQty(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(99, n);
}

/** Copies this listing actually has. Missing stock stays unknown. */
export function explicitStock(value) {
  if (value == null || value === '') return null;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(99, n);
}

export function overListingStock(qty, stock) {
  const cap = explicitStock(stock);
  return cap != null && chatQty(qty) > cap;
}

/** Copies the people actually list, preferring one listing id. */
export function listedCopies(listings, people = [], listingId = '') {
  const id = String(listingId || '');
  let best = null;
  for (const offer of listings || []) {
    const copies = offerCopies(offer);
    if (copies == null) continue;
    if (id && String(offer?.id || offer?.listingId || '') === id) return copies;
    if ((people || []).some((person) => samePerson(offer, person))) {
      best = best == null ? copies : Math.max(best, copies);
    }
  }
  return best;
}

export function listingStock(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 99;
  return Math.min(99, n);
}

/** A shop listing belongs to a seller. A homepage card does not. */
export function isSellerCard(row) {
  return Boolean(sellerUserId(row?.sellerUid) || chatHandle(row?.seller));
}

export function cardIdOf(row) {
  const id = String(row?.cardId || row?.id || '').trim();
  if (/^\d+$/.test(id)) return id;
  const path = String(row?.path || row?.canonicalPath || '');
  const match = path.match(/\/cards\/(\d+)/);
  return match ? match[1] : '';
}

function samePerson(offer, person) {
  if (!person) return false;
  const uid = sellerUserId(person.uid);
  const handle = chatHandle(person.username);
  const offerUid = sellerUserId(offer?.sellerUid || offer?.seller_uid);
  const offerHandle = chatHandle(sellerHandle(offer) || offer?.seller);
  return Boolean((uid && offerUid === uid) || (handle && offerHandle === handle));
}

/** True when one of these people has this card listed. */
export function personListsCard(listings, people = []) {
  return (listings || []).some((offer) => (people || []).some((person) => samePerson(offer, person)));
}

const OWNED_KEY = 'pokoin.chatOwned';

function personKeys(people) {
  const keys = [];
  for (const person of people || []) {
    const uid = sellerUserId(person?.uid);
    const handle = chatHandle(person?.username);
    if (uid) keys.push(`uid:${uid}`);
    if (handle) keys.push(`name:${handle}`);
  }
  return keys;
}

function readOwnedStore() {
  try {
    const data = JSON.parse(localStorage.getItem(OWNED_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return {};
  }
}

/** 'yes' or 'no' when this browser already learned whether these people list the card. */
export function readCardOwned(cardId, people) {
  const id = String(cardId || '').trim();
  if (!id) return '';
  const data = readOwnedStore();
  for (const key of personKeys(people)) {
    const value = data?.[key]?.[id];
    if (value === 'yes' || value === 'no') return value;
  }
  return '';
}

export function writeCardOwned(cardId, people, owned) {
  const id = String(cardId || '').trim();
  if (!id || (owned !== 'yes' && owned !== 'no')) return;
  const data = readOwnedStore();
  for (const key of personKeys(people)) {
    const bucket = data[key] && typeof data[key] === 'object' ? data[key] : {};
    bucket[id] = owned;
    const cards = Object.keys(bucket);
    if (cards.length > 60) {
      for (const extra of cards.slice(0, cards.length - 60)) delete bucket[extra];
    }
    data[key] = bucket;
  }
  const keys = Object.keys(data);
  if (keys.length > 40) {
    for (const extra of keys.slice(0, keys.length - 40)) delete data[extra];
  }
  try {
    localStorage.setItem(OWNED_KEY, JSON.stringify(data));
  } catch (_) {
    /* private mode */
  }
}

/** Color only a real listing, or a trade card this browser already saw them list. */
export function paintOwned(row, cardId, people) {
  if (isSellerCard(row)) return 'yes';
  if (!cardId) return 'no';
  return readCardOwned(cardId, people) || 'no';
}

/**
 * Dragging the catalog scan has no seller. If the open chat's person
 * lists this printing, attach that listing so it stays in color.
 */
export function referenceForPeer(card, offers, peer = {}) {
  const match = (offers || []).find((offer) => samePerson(offer, peer));
  if (match) return listingReference({ offer: match, card });
  return cardReference(card);
}

export function appendChatTag(tags, reference) {
  if (!reference?.cardName) return tags;
  const key = tagKey(reference);
  const stock = explicitStock(reference.stock);
  const qty = stock != null ? Math.min(stock, chatQty(reference.qty)) : chatQty(reference.qty);
  const next = { ...reference, qty };
  if (stock != null) next.stock = stock;
  else delete next.stock;
  const at = (tags || []).findIndex((row) => tagKey(row) === key);
  if (at >= 0) {
    const copy = tags.slice();
    const prior = explicitStock(copy[at].stock);
    const merged = stock != null && prior != null ? Math.max(prior, stock) : (stock ?? prior);
    copy[at] = { ...copy[at], ...next, qty };
    if (merged != null) copy[at].stock = merged;
    else delete copy[at].stock;
    return copy;
  }
  return [...(tags || []), next].slice(-4);
}

export function catalogPath(href, cardId) {
  const text = String(href || '').trim();
  if (text.startsWith('/marketplace/')) return text.split(/[?#]/)[0];
  try {
    const url = new URL(text, 'https://pokoin.com');
    if (url.pathname.startsWith('/marketplace/')) return url.pathname;
  } catch (_) {
    /* not a URL */
  }
  const id = String(cardId || '').trim();
  return id ? `/marketplace/en/cards/${id}` : '';
}

/** A dashboard miniature or any picture that is not a full catalog card. */
export function looseCardReference({
  imageUrl = '', name = 'Card', href = '', cardId = '', sellerUid = '', seller = '', pricePkn = 0, listingId = '',
} = {}) {
  return {
    kind: sellerUserId(sellerUid) ? 'listing' : 'card',
    listingId: String(listingId || ''),
    cardId: String(cardId || ''),
    sellerUid: sellerUserId(sellerUid),
    seller: chatHandle(seller),
    cardName: String(name || 'Card').trim() || 'Card',
    setName: '',
    imageUrl: String(imageUrl || '').trim(),
    path: catalogPath(href, cardId),
    pricePkn: Number(pricePkn) || 0,
  };
}

/** Full scan first, so the chat card shows the whole printing. */
export function chatImageSources(row) {
  const stored = String(row?.imageUrl || '').trim();
  const out = [];
  const push = (url) => {
    const value = String(url || '').trim();
    if (value && !out.includes(value)) out.push(value);
  };
  if (!stored) return out;
  push(preferFullImage(stored));
  push(stored);
  push(homepageDerivativeUrl(stored));
  return out;
}

/** Homepage rail card: 13.5rem wide, portrait 63:88. */
export const CARD_DRAG_WIDTH = 216;
export const CARD_DRAG_HEIGHT = 302;

let dragGhost;

function dragSourceImage(event) {
  const node = event?.currentTarget;
  if (!node || node.nodeType !== 1) return null;
  if (node.tagName === 'IMG') return node;
  const nested = node.querySelector?.(
    '.shop-card img, .tile-art img, .seller-listing-art img, .c-art img, .bag-art img, .seller-mover img',
  );
  if (nested) return nested;
  // The desk hero is the frame itself, so `.art-frame img` does not match a descendant.
  if (node.matches?.('.art-frame')) return node.querySelector?.('img') || null;
  return null;
}

function markCardDragging() {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (!root?.classList) return;
  root.classList.add('is-card-dragging');
  window.addEventListener('dragend', () => {
    root.classList.remove('is-card-dragging');
  }, { once: true, capture: true });
}

const readyImages = new Map();

/** Decode a wordmark or artist cover before the drag, so a text link can still show it. */
export function preloadDragImage(url) {
  const src = String(url || '').trim();
  if (!src || readyImages.has(src) || typeof Image === 'undefined') return;
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  readyImages.set(src, img);
}

function readyDragImage(url) {
  const img = readyImages.get(String(url || '').trim());
  return img?.complete && img.naturalWidth ? img : null;
}

export function bundleReference({ kind, slug, name, imageUrl, path }) {
  const cleanKind = kind === 'artist' || kind === 'species' ? kind : 'expansion';
  const id = String(slug || '').trim();
  const fallback = cleanKind === 'artist' ? 'Artist' : cleanKind === 'species' ? 'Pokémon' : 'Set';
  return {
    kind: cleanKind,
    listingId: `bundle:${cleanKind}:${id}`.slice(0, 120),
    cardId: '',
    sellerUid: '',
    seller: '',
    cardName: String(name || id || fallback),
    setName: cleanKind === 'expansion' ? String(name || '') : '',
    imageUrl: String(imageUrl || ''),
    path: String(path || ''),
    pricePkn: 0,
  };
}

export function bundleOf(row) {
  const match = String(row?.listingId || '').match(/^bundle:(artist|expansion|species):(.+)$/);
  if (!match) return null;
  return { kind: match[1], slug: match[2] };
}

let dragSlot;

function paintDragGhost(image, fit = 'cover') {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.style.position = 'fixed';
  canvas.style.top = '0';
  canvas.style.pointerEvents = 'none';
  document.body?.appendChild(canvas);
  if (dragGhost && dragGhost !== canvas) dragGhost.remove?.();
  dragGhost = canvas;
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
  dragGhost.width = Math.round(CARD_DRAG_WIDTH * dpr);
  dragGhost.height = Math.round(CARD_DRAG_HEIGHT * dpr);
  dragGhost.style.width = `${CARD_DRAG_WIDTH}px`;
  dragGhost.style.height = `${CARD_DRAG_HEIGHT}px`;
  dragGhost.style.left = `-${CARD_DRAG_WIDTH + 32}px`;
  const ctx = dragGhost.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, CARD_DRAG_WIDTH, CARD_DRAG_HEIGHT);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect?.(0, 0, CARD_DRAG_WIDTH, CARD_DRAG_HEIGHT, 10);
  if (!ctx.roundRect) ctx.rect(0, 0, CARD_DRAG_WIDTH, CARD_DRAG_HEIGHT);
  ctx.clip();
  ctx.fillStyle = '#07060b';
  ctx.fillRect(0, 0, CARD_DRAG_WIDTH, CARD_DRAG_HEIGHT);
  if (image?.naturalWidth) {
    try {
      const scale = fit === 'contain'
        ? Math.min(CARD_DRAG_WIDTH / image.naturalWidth, CARD_DRAG_HEIGHT / image.naturalHeight)
        : Math.max(CARD_DRAG_WIDTH / image.naturalWidth, CARD_DRAG_HEIGHT / image.naturalHeight);
      const dw = image.naturalWidth * scale;
      const dh = image.naturalHeight * scale;
      ctx.drawImage(image, (CARD_DRAG_WIDTH - dw) / 2, (CARD_DRAG_HEIGHT - dh) / 2, dw, dh);
      ctx.getImageData(0, 0, 1, 1);
    } catch (_) {
      return null;
    }
  }
  ctx.restore();
  return dragGhost;
}

/** A cover that cannot be painted still drags inside this box, never at natural size. */
function fixedDragSlot(src, fit) {
  if (typeof document === 'undefined') return null;
  if (!dragSlot || dragSlot.ownerDocument !== document) {
    dragSlot = document.createElement('img');
    dragSlot.alt = '';
    dragSlot.draggable = false;
    document.body?.appendChild(dragSlot);
  }
  dragSlot.width = CARD_DRAG_WIDTH;
  dragSlot.height = CARD_DRAG_HEIGHT;
  dragSlot.style.position = 'fixed';
  dragSlot.style.top = '0';
  dragSlot.style.left = `-${CARD_DRAG_WIDTH + 48}px`;
  dragSlot.style.width = `${CARD_DRAG_WIDTH}px`;
  dragSlot.style.height = `${CARD_DRAG_HEIGHT}px`;
  dragSlot.style.objectFit = fit === 'cover' ? 'cover' : 'contain';
  dragSlot.style.pointerEvents = 'none';
  dragSlot.style.background = '#07060b';
  const next = String(src || '');
  if (next && dragSlot.getAttribute('src') !== next) dragSlot.src = next;
  return dragSlot;
}

export function writeListingDrag(event, reference) {
  if (!event?.dataTransfer || !reference?.cardName) return;
  event.dataTransfer.setData(LISTING_DRAG_TYPE, JSON.stringify(reference));
  event.dataTransfer.effectAllowed = 'copy';
  const image = dragSourceImage(event) || readyDragImage(reference.imageUrl);
  const fit = reference.kind === 'card' || !reference.kind ? 'cover' : 'contain';
  const painted = paintDragGhost(image, fit);
  const ghost = painted || fixedDragSlot(image?.currentSrc || image?.src || reference.imageUrl, fit);
  try {
    if (ghost) {
      event.dataTransfer.setDragImage(ghost, CARD_DRAG_WIDTH / 2, CARD_DRAG_HEIGHT / 2);
    }
  } catch (_) {
    /* the browser keeps its default ghost */
  }
  markCardDragging();
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
