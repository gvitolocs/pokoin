import { cardStubFromRoute } from './card-stub.js';

/** Reserved peer for the Poko assistant in Messages / chat dock. */
export const POKO_PEER = 'poko';
export const POKO_DISPLAY = 'Poko';
export const POKO_LEDE = 'Pokoin market assistant';

export function isPokoPeer(value) {
  return String(value || '').trim().toLowerCase() === POKO_PEER;
}

const HISTORY_PREFIX = 'pokoin.pokoChat.';

/** Live desk card published by Card.jsx so dock chat knows what the user is viewing. */
let activeDeskCard = null;

export function setActiveDeskCard(card) {
  if (!card) {
    activeDeskCard = null;
    return null;
  }
  const row = toPokoCard(card);
  activeDeskCard = row.cardId || row.name ? row : null;
  return activeDeskCard;
}

export function getActiveDeskCard() {
  return activeDeskCard;
}

export function clearActiveDeskCard() {
  activeDeskCard = null;
}

export function readPokoHistory(uid) {
  if (!uid) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(`${HISTORY_PREFIX}${uid}`) || '[]');
    return Array.isArray(raw) ? raw.slice(-80) : [];
  } catch (_) {
    return [];
  }
}

export function writePokoHistory(uid, events) {
  if (!uid) return;
  try {
    localStorage.setItem(`${HISTORY_PREFIX}${uid}`, JSON.stringify((events || []).slice(-80)));
  } catch (_) {
    /* private mode */
  }
}

export function pokoPreview(events = []) {
  const last = [...events].reverse().find((row) => row?.text || (row?.listings || row?.cards || []).length || (row?.images || []).length);
  if (!last) return 'Ask about cards, prices, and liquidity';
  if (last.text) return last.text;
  if ((last.images || []).length) return 'Photo attached';
  const card = (last.listings || last.cards || [])[0];
  return card?.cardName || card?.name || 'Card attached';
}

function toPokoCard(row = {}) {
  return {
    cardId: String(row?.cardId || row?.id || row?.card_id || ''),
    name: String(row?.cardName || row?.name || ''),
    setName: String(row?.setName || row?.set || row?.set_name || ''),
    condition: String(row?.condition || ''),
    language: String(row?.language || ''),
    canonicalPath: String(row?.canonicalPath || row?.canonical_path || row?.href || row?.path || ''),
    imageUrl: String(row?.imageUrl || row?.cardImageUrl || row?.heroImageUrl || ''),
  };
}

/** Map dock / chat listing tags into the poko-chat BFF card shape. */
export function tagsToPokoCards(tags = []) {
  return (Array.isArray(tags) ? tags : []).slice(0, 8).map(toPokoCard).filter((row) => row.cardId || row.name);
}

/** Parse `/marketplace/:lang/cards/:cardId/:slug?` into a poko card when no live desk publish. */
export function deskCardFromPath(pathname = '') {
  const match = String(pathname || '').match(/\/marketplace\/([a-z]{2})\/cards\/(\d+)(?:\/([^/?#]+))?/i);
  if (!match) return null;
  const stub = cardStubFromRoute({ lang: match[1], cardId: match[2], slug: match[3] || '' });
  return stub ? toPokoCard(stub) : null;
}

/**
 * Prefer explicit attaches; otherwise the live desk card, else URL stub.
 * Keeps Hermes from inventing a different card when the user is on a desk.
 */
export function resolvePokoCards({ tags = [], pathname = '' } = {}) {
  const attached = tagsToPokoCards(tags);
  if (attached.length) return attached;
  const live = getActiveDeskCard();
  if (live?.cardId || live?.name) return [live];
  const fromPath = deskCardFromPath(pathname);
  return fromPath ? [fromPath] : [];
}

export function buildPokoPageContext({ pathname = '', cards = [], images = [] } = {}) {
  const desk = cards[0] || getActiveDeskCard() || deskCardFromPath(pathname);
  return {
    channel: 'website-messages',
    path: String(pathname || '').slice(0, 300),
    deskCardId: desk?.cardId || '',
    deskCardName: desk?.name || '',
    deskSetName: desk?.setName || '',
    attachedCards: cards,
    attachedImages: images,
  };
}

/** Default ask when the user sends from a desk with no typed message. */
export function defaultPokoDeskPrompt(card) {
  const name = String(card?.name || 'this card').trim();
  const set = String(card?.setName || '').trim();
  const id = String(card?.cardId || '').trim();
  const label = [name, set ? `(${set})` : '', id ? `id=${id}` : ''].filter(Boolean).join(' ');
  return `Quote Pokoin sold median, current asks, and liquidity for ${label}. Lead with site analytics — do not invent a different card.`;
}

export function cleanPokoImages(urls = []) {
  return (Array.isArray(urls) ? urls : [])
    .map((url) => String(url || '').trim())
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, 8);
}
