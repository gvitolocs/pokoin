/**
 * The landing hero binder for a signed-in visitor: the first page (nine
 * holdings, in collection order) of their own collection, from
 * `GET /api/marketplace-collection?limit=9`.
 *
 * The last page is kept per uid in localStorage, so the next visit paints it
 * at once and revalidates in the background. A stored page is only ever shown
 * to the uid it was read for; clearAuthSession (sign-out) drops it.
 */

import { LANDING_BINDER_KEY } from './auth-session.js';

export const BINDER_SLOTS = 9;
const VERSION = 1;

function store(override) {
  if (override) return override;
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

const PICTURE = /^(?:https:\/\/cdn\.pokoin\.com\/|\/(?!\/))/;
const DESK = /^\/marketplace\/[a-z-]+\/cards\/\d+$/;
export const MISSING_CARD = '/home/missing-card.webp';

/** Desk links stay on Pokoin; pictures come from the CDN or this origin. */
function safeCard(card) {
  if (!card) return null;
  const src = String(card.src || '');
  const full = String(card.full || '');
  const href = String(card.href || '');
  return {
    id: String(card.id || ''),
    name: String(card.name || 'Card').slice(0, 120),
    src: PICTURE.test(src) ? src : MISSING_CARD,
    full: PICTURE.test(full) ? full : '',
    href: DESK.test(href) ? href : '',
  };
}

/**
 * The collection answer as a binder page: `{ uid, total, cards }`, where
 * `total` is the whole collection's entry count and `cards` its first nine.
 * An empty collection has no cards. `null` when the answer has no owner.
 * `image(row)` gives `{ src, full }`; `href(row)` the card's desk path.
 */
export function binderPage(body, { image, href }) {
  const uid = String(body?.uid || '').trim();
  if (!uid) return null;
  const items = Array.isArray(body?.items) ? body.items : [];
  const cards = [];
  for (const row of items) {
    if (cards.length >= BINDER_SLOTS) break;
    const id = String(row?.cardId || row?.blueprintId || '').trim();
    const picture = image(row) || {};
    cards.push(safeCard({
      id,
      name: row?.cardName || row?.name || 'Card',
      src: picture.src,
      full: picture.full,
      href: href(row),
    }));
  }
  const counted = Number(body?.itemCount);
  const total = Math.max(Number.isFinite(counted) ? Math.floor(counted) : 0, items.length);
  return { uid, total: cards.length ? total : 0, cards };
}

/** The stored page for `uid`, or null (none, another account's, or unreadable). */
export function readBinderCache(uid, overrideStore) {
  const owner = String(uid || '').trim();
  if (!owner) return null;
  let raw = null;
  try {
    raw = store(overrideStore)?.getItem(LANDING_BINDER_KEY) ?? null;
  } catch (_) {
    return null;
  }
  if (!raw) return null;
  try {
    const page = JSON.parse(raw);
    if (page?.v !== VERSION || page.uid !== owner) return null;
    const cards = (Array.isArray(page.cards) ? page.cards : []).map(safeCard).filter(Boolean).slice(0, BINDER_SLOTS);
    if (!cards.length) return null;
    const total = Math.max(Math.floor(Number(page.total) || 0), cards.length);
    return { uid: owner, total, cards };
  } catch (_) {
    return null;
  }
}

/** Keep `page` as the only stored page (one account per browser slot). */
export function writeBinderCache(page, overrideStore) {
  if (!page?.uid || !page.cards?.length) {
    clearBinderCache(overrideStore);
    return;
  }
  try {
    store(overrideStore)?.setItem(LANDING_BINDER_KEY, JSON.stringify({
      v: VERSION,
      uid: page.uid,
      total: page.total,
      cards: page.cards,
      savedAt: Date.now(),
    }));
  } catch (_) {
    /* quota / private mode */
  }
}

export function clearBinderCache(overrideStore) {
  try {
    store(overrideStore)?.removeItem(LANDING_BINDER_KEY);
  } catch (_) {
    /* private mode */
  }
}

/** Same owner, total, and cards in the same order: nothing to repaint. */
export function samePage(a, b) {
  if (!a || !b || a.uid !== b.uid || a.total !== b.total || a.cards.length !== b.cards.length) return false;
  return a.cards.every((card, index) => {
    const other = b.cards[index];
    return card.id === other.id && card.src === other.src && card.href === other.href && card.name === other.name;
  });
}

/** The badge: cards on this page / entries in the collection. */
export function binderCount(page) {
  return `${page.cards.length} / ${page.total}`;
}

/** Progress bar width: the share of the collection this page shows. */
export function binderFill(page) {
  if (!page.total) return '0%';
  return `${Math.max(4, Math.min(100, Math.round((page.cards.length / page.total) * 100)))}%`;
}
