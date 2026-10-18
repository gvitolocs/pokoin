import { cardReference, chatQty } from './chat-listing.js';
import { game, knownGameId } from './game.js';

const CART_KEY = 'pokoin.cartItems';
const WATCH_KEY = 'pokoin.watchlistIds';

function peekBrowserCart(limit = 24) {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, limit).map((row) => ({
      cardId: String(row?.cardId || row?.card?.id || ''),
      name: String(row?.name || row?.card?.name || ''),
      qty: Number(row?.qty) || 0,
      pricePkn: Number(row?.pricePkn) || 0,
      sellerName: String(row?.sellerName || ''),
      condition: String(row?.condition || ''),
      language: String(row?.language || ''),
    })).filter((row) => row.cardId && row.qty > 0);
  } catch (_) {
    return [];
  }
}

function peekBrowserWatchlist(limit = 24) {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((id) => String(id)).filter((id) => /^\d+$/.test(id)).slice(0, limit);
  } catch (_) {
    return [];
  }
}

/** Reserved peer for the Poko assistant in Messages / chat dock. */
export const POKO_PEER = 'poko';
export const POKO_DISPLAY = 'Poko';
export const POKO_LEDE = 'Pokoin market assistant';

export function isPokoPeer(value) {
  return String(value || '').trim().toLowerCase() === POKO_PEER;
}

const HISTORY_PREFIX = 'pokoin.pokoChat.';

/**
 * The card desk the user is viewing, as a chat card reference. Card.jsx
 * publishes it so the Poko composer can offer it as a chip; it never reaches
 * Poko on its own.
 */
let activeDeskCard = null;
const deskListeners = new Set();

function publishDesk(next) {
  const same = (next?.cardId || '') === (activeDeskCard?.cardId || '')
    && (next?.cardName || '') === (activeDeskCard?.cardName || '')
    && (next?.imageUrl || '') === (activeDeskCard?.imageUrl || '');
  activeDeskCard = next;
  if (!same) for (const listener of deskListeners) listener(next);
  return next;
}

export function setActiveDeskCard(card) {
  const row = card ? cardReference(card) : null;
  return publishDesk(row?.cardId ? row : null);
}

export function getActiveDeskCard() {
  return activeDeskCard;
}

export function clearActiveDeskCard() {
  publishDesk(null);
}

export function subscribeActiveDeskCard(listener) {
  deskListeners.add(listener);
  return () => deskListeners.delete(listener);
}

function sameTags(a, b) {
  return a.length === b.length && a.every((row, index) => JSON.stringify(row) === JSON.stringify(b[index]));
}

/**
 * The page-card chip in the Poko composer: on a card desk, Poko offers that
 * card as an ordinary removable card tag (flagged `pageCard`). Only tags in
 * the composer reach Poko; there is no implicit "card being viewed".
 * - Seller chats never get one (`poko` false strips it).
 * - × turns page chips off for the rest of this Poko conversation (`off`).
 * - A sent chip is not offered again in this conversation (`used`), but a
 *   different card is: navigating swaps an unsent chip for the new card.
 * - Leaving card desks drops an unsent chip.
 * Returns `tags` itself when nothing changes.
 */
export function reconcilePokoPageChip(tags = [], { pageCard = null, poko = false, off = false, used = [] } = {}) {
  const list = Array.isArray(tags) ? tags : [];
  const id = String(pageCard?.cardId || '');
  const rest = list.filter((row) => !row?.pageCard);
  const wanted = poko && !off && id && !used.includes(id)
    && !rest.some((row) => String(row?.cardId || '') === id)
    && rest.length < 4;
  let next = rest;
  if (wanted) {
    const prior = list.find((row) => row?.pageCard && String(row.cardId || '') === id);
    next = [{ ...pageCard, qty: chatQty(prior?.qty ?? 1), pageCard: true }, ...rest];
  }
  return sameTags(list, next) ? list : next;
}

export function normalizePokoEvent(row = {}) {
  const role = row.role === 'assistant' || row.mine === false ? 'assistant' : 'user';
  const cards = Array.isArray(row.cards)
    ? row.cards
    : (Array.isArray(row.listings) ? row.listings : []);
  return {
    id: String(row.id || ''),
    role,
    mine: role === 'user',
    text: String(row.text || ''),
    cards,
    listings: cards,
    images: Array.isArray(row.images) ? row.images : [],
    source: String(row.source || ''),
    turnId: String(row.turnId || ''),
    clientTurnId: String(row.clientTurnId || ''),
    createdAt: row.createdAt || null,
  };
}

export const POKO_CHAT_PAGE = 20;
/** Soft cap for an open thread after scroll-up loads (not the initial page). */
const POKO_CHAT_MEMORY = 200;

const ROLE_ORDER = { user: 0, assistant: 1 };

/**
 * Chat order: time, then a question always before its answer. Old turns were
 * stored with one shared timestamp, so a tie must never fall to the random id.
 */
export function comparePokoEvents(a, b) {
  const at = Date.parse(a.createdAt) || 0;
  const bt = Date.parse(b.createdAt) || 0;
  if (a.turnId && a.turnId === b.turnId && a.role !== b.role) {
    return ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
  }
  if (at !== bt) return at - bt;
  if (a.role !== b.role) return ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
  return String(a.id).localeCompare(String(b.id));
}

export function mergePokoEvents(...pages) {
  const byId = new Map();
  for (const page of pages) {
    for (const raw of page || []) {
      const event = normalizePokoEvent(raw);
      if (!event.id) continue;
      byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort(comparePokoEvents).slice(-POKO_CHAT_MEMORY);
}

/** Fingerprint a user turn so optimistic local-* rows survive until the server twin arrives. */
export function pokoUserTurnKey(row = {}) {
  const text = String(row?.text || '');
  const images = Array.isArray(row?.images) ? row.images.length : 0;
  const cards = (Array.isArray(row?.cards) ? row.cards : (Array.isArray(row?.listings) ? row.listings : []))
    .map((card) => String(card?.cardId || card?.id || card?.card_id || card?.name || card?.cardName || ''))
    .filter(Boolean)
    .join(',');
  return `${text}\0${images}\0${cards}`;
}

/** Stable fingerprint so idle history polls can skip setState. */
export function pokoEventsSignature(events = []) {
  return (Array.isArray(events) ? events : []).map((row) => {
    const cards = (Array.isArray(row?.cards) ? row.cards : (Array.isArray(row?.listings) ? row.listings : []))
      .map((card) => String(card?.cardId || card?.id || card?.name || ''))
      .join(',');
    const images = Array.isArray(row?.images) ? row.images.length : 0;
    return [
      String(row?.id || ''),
      String(row?.role || ''),
      String(row?.text || ''),
      String(row?.source || ''),
      images,
      cards,
    ].join('\0');
  }).join('|');
}

/** Keep optimistic local-* rows until a matching server user turn arrives. */
export function reconcilePokoEvents(current, serverEvents) {
  const server = mergePokoEvents(serverEvents);
  const serverUsers = server.filter((row) => row.role === 'user');
  // The server echoes our optimistic id; the text fingerprint is the fallback
  // for turns stored before clientTurnId existed.
  const serverClientIds = new Set(serverUsers.map((row) => row.clientTurnId).filter(Boolean));
  const serverUserKeys = new Set(serverUsers.map((row) => pokoUserTurnKey(row)));
  const pendingLocal = (current || []).filter((row) => {
    const id = String(row?.id || '');
    if (!id.startsWith('local-')) return false;
    return !serverClientIds.has(id) && !serverUserKeys.has(pokoUserTurnKey(row));
  });
  return mergePokoEvents(
    (current || []).filter((row) => !String(row?.id || '').startsWith('local-')),
    server,
    pendingLocal,
  );
}

export function readPokoHistory(uid) {
  if (!uid) return { events: [], hasMore: false };
  try {
    const raw = JSON.parse(localStorage.getItem(`${HISTORY_PREFIX}${uid}`) || 'null');
    if (Array.isArray(raw)) {
      const events = mergePokoEvents(raw).slice(-POKO_CHAT_PAGE);
      return { events, hasMore: raw.length > events.length || events.length >= POKO_CHAT_PAGE };
    }
    if (raw && typeof raw === 'object' && Array.isArray(raw.events)) {
      const events = mergePokoEvents(raw.events).slice(-POKO_CHAT_PAGE);
      const hasMore = typeof raw.hasMore === 'boolean'
        ? raw.hasMore
        : (raw.events.length > events.length || events.length >= POKO_CHAT_PAGE);
      return { events, hasMore };
    }
    return { events: [], hasMore: false };
  } catch (_) {
    return { events: [], hasMore: false };
  }
}

export function writePokoHistory(uid, events, hasMore = false) {
  if (!uid) return;
  try {
    const page = mergePokoEvents(events).slice(-POKO_CHAT_PAGE);
    localStorage.setItem(`${HISTORY_PREFIX}${uid}`, JSON.stringify({
      events: page,
      hasMore: Boolean(hasMore) || (Array.isArray(events) && events.length > page.length),
    }));
  } catch (_) {
    /* private mode */
  }
}

export function pokoHistoryHasMore(result) {
  if (typeof result?.hasMore === 'boolean') return result.hasMore;
  return (result?.events || []).length >= POKO_CHAT_PAGE;
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
  const path = String(row?.canonicalPath || row?.canonical_path || row?.href || row?.path || '');
  return {
    cardId: String(row?.cardId || row?.id || row?.card_id || ''),
    name: String(row?.cardName || row?.name || ''),
    setName: String(row?.setName || row?.set || row?.set_name || ''),
    condition: String(row?.condition || ''),
    language: String(row?.language || ''),
    canonicalPath: path,
    path,
    imageUrl: String(row?.imageUrl || row?.cardImageUrl || row?.heroImageUrl || ''),
    game: knownGameId(row?.game) || game().id,
  };
}

/** Map dock / chat listing tags into the poko-chat BFF card shape. */
export function tagsToPokoCards(tags = []) {
  return (Array.isArray(tags) ? tags : []).slice(0, 8).map(toPokoCard).filter((row) => row.cardId || row.name);
}

/** The desk card fields name the first attached card only — never the page being viewed. */
export function buildPokoPageContext({ pathname = '', cards = [], images = [] } = {}) {
  const desk = cards[0] || null;
  return {
    channel: 'website-messages',
    path: String(pathname || '').slice(0, 300),
    deskCardId: desk?.cardId || '',
    deskCardName: desk?.name || '',
    deskSetName: desk?.setName || '',
    watchlistIds: peekBrowserWatchlist(24),
    cart: peekBrowserCart(24),
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
