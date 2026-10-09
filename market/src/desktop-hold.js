/** Cards parked on the Desktop hold tray (not the cart). Framework-free:
 * React reads it through desktop-hold-hooks.js, Solid through its store. */

import { pruneStoredCardPages } from './card-page-cache.js';
import { gameBasename } from './game.js';
import { printingIdentity } from './identity.js';
import { homepageDerivativeUrl, ownCatalogImage, preferFullImage } from './image-urls.js';
import { tilePricePkn } from './pkn.js';
import { tcgEra } from './set-logos.js';

const KEY = 'pokoin.desktopHold';
/** Room for the largest artist (5ban Graphics ~5.1k printings; Ken Sugimori ~3k). */
export const DESKTOP_MAX = 6000;
const MAX = DESKTOP_MAX;
/** True after localStorage refused a write: the tray then lives in memory for
 * this tab instead of silently snapping back to the last stored copy. */
let memoryOnly = false;
const EMPTY = [];
const listeners = new Set();

/** Stable snapshot for subscribers — a fresh [] each call black-screens React. */
let cachedItems = EMPTY;
let cachedRaw = null;

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (_) {
      /* ignore */
    }
  }
}

function holdImageUrl(card = {}) {
  const id = String(card.id || card.cardId || card.card_id || '').trim();
  const withId = {
    id,
    name: card.name || card.cardName || '',
    canonicalPath: card.path || card.canonicalPath || card.canonical_path || '',
  };
  const raw = String(
    card.imageUrl
    || card.gridImageUrl
    || card.heroImageUrl
    || card.image
    || card.image_url
    || '',
  ).trim();
  // Expansion logos / wordmarks / symbols are not leftover scans — keep them.
  if (/\/expansions\/(?:logos|wordmarks|symbols)\//i.test(raw)) {
    return raw;
  }
  const owned = ownCatalogImage(withId, preferFullImage(raw) || raw);
  if (owned) {
    return homepageDerivativeUrl(owned) || owned;
  }
  return '';
}

export function readDesktopHold() {
  try {
    if (typeof localStorage === 'undefined' || memoryOnly) return cachedItems;
    const raw = localStorage.getItem(KEY) || '[]';
    if (raw === cachedRaw) return cachedItems;
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed.filter((row) => row && row.id) : EMPTY;
    // Rewrite stale CardTrader preview_ URLs parked before ownCatalogImage (Eevee coin).
    let dirty = false;
    cachedItems = rows.map((row) => {
      const imageUrl = holdImageUrl(row);
      if (imageUrl && imageUrl !== row.imageUrl) {
        dirty = true;
        return { ...row, imageUrl };
      }
      if (!imageUrl && row.imageUrl) {
        dirty = true;
        return { ...row, imageUrl: '' };
      }
      return row;
    });
    cachedRaw = raw;
    if (dirty && cachedItems !== EMPTY) {
      cachedRaw = JSON.stringify(cachedItems);
      try {
        localStorage.setItem(KEY, cachedRaw);
      } catch (_) {
        /* private mode */
      }
    }
    return cachedItems;
  } catch (_) {
    return cachedItems;
  }
}

function writeDesktopHold(items) {
  const next = (items || []).slice(0, MAX);
  cachedItems = next.length ? next : EMPTY;
  cachedRaw = JSON.stringify(cachedItems);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(KEY, cachedRaw);
      memoryOnly = false;
    } catch (_) {
      pruneStoredCardPages(0);
      try {
        localStorage.setItem(KEY, cachedRaw);
        memoryOnly = false;
      } catch (__) {
        memoryOnly = true;
      }
    }
  }
  notify();
}

/** The browser refused to store the tray; it is kept until the tab closes. */
export function desktopHoldMemoryOnly() {
  return memoryOnly;
}

function defaultCardPath(id) {
  const base = gameBasename();
  return `${base}/marketplace/en/cards/${id}`.replace(/\/{2,}/g, '/');
}

function eraForHold(card = {}, expansion = '') {
  const eraRaw = String(
    card.era
    || tcgEra({ ...card, set: expansion || card.set || card.set_name || card.setName || card.expansion })
    || '',
  ).trim();
  return eraRaw && eraRaw !== 'Other' ? eraRaw : '';
}

export function desktopHoldCard(card = {}) {
  const id = String(card.id || card.cardId || card.card_id || '').trim();
  if (!id) return null;
  const identity = printingIdentity(card);
  const expansion = String(
    identity.set
    || card.expansion
    || card.setName
    || card.set
    || card.set_name
    || '',
  );
  const era = eraForHold(card, expansion);
  const price = tilePricePkn(card);
  const priced = price != null
    ? price
    : (Number.isFinite(Number(card.pricePkn)) ? Number(card.pricePkn) : null);
  return {
    id,
    name: String(card.name || card.cardName || 'Card'),
    collectorNumber: String(
      identity.number
      || card.collectorNumber
      || card.number
      || card.card_number
      || '',
    ),
    expansion,
    era,
    artist: String(identity.artist || card.artist || card.illustrator || ''),
    rarity: String(identity.rarity || card.rarity || ''),
    pricePkn: priced != null && Number.isFinite(priced) ? priced : '',
    qty: Math.max(1, Math.min(99, Math.trunc(Number(card.qty)) || 1)),
    stock: Math.max(1, Math.min(99, Math.trunc(Number(card.stock ?? card.quantityAvailable)) || 99)),
    imageUrl: holdImageUrl({
      ...card,
      id,
      name: card.name || card.cardName,
      path: card.path || card.canonicalPath || card.canonical_path,
    }),
    path: String(
      card.path
      || card.canonicalPath
      || card.canonical_path
      || defaultCardPath(id),
    ),
  };
}

export function addDesktopCards(cards) {
  const incoming = (cards || []).map(desktopHoldCard).filter(Boolean);
  if (!incoming.length) return 0;
  const current = readDesktopHold();
  const byId = new Map(current.map((row) => [row.id, { ...row, qty: Math.max(1, Number(row.qty) || 1) }]));
  let added = 0;
  for (const card of incoming) {
    const prior = byId.get(card.id);
    if (prior) {
      const cap = Math.min(99, Number(prior.stock) || Number(card.stock) || 99);
      const nextQty = Math.min(cap, (Number(prior.qty) || 1) + (Number(card.qty) || 1));
      if (nextQty !== prior.qty) {
        byId.set(card.id, { ...prior, ...card, qty: nextQty, stock: cap });
        added += 1;
      }
      continue;
    }
    if (byId.size >= MAX) break;
    byId.set(card.id, card);
    added += 1;
  }
  if (added) writeDesktopHold([...byId.values()]);
  return added;
}

export function setDesktopQty(id, qty) {
  const want = String(id || '');
  if (!want) return;
  const next = Math.max(0, Math.min(99, Math.trunc(Number(qty)) || 0));
  writeDesktopHold(
    readDesktopHold().flatMap((row) => {
      if (row.id !== want) return [row];
      if (next < 1) return [];
      const cap = Math.min(99, Number(row.stock) || 99);
      return [{ ...row, qty: Math.min(cap, next) }];
    }),
  );
}

export function removeDesktopCard(id) {
  const want = String(id || '');
  if (!want) return;
  writeDesktopHold(readDesktopHold().filter((row) => row.id !== want));
}

export function clearDesktopHold() {
  writeDesktopHold([]);
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** @deprecated CSV export replaced by single-page A4 PDF (`desktop-hold-pdf.js`). */
export function desktopHoldCsv(items = readDesktopHold()) {
  const rows = [['name', 'collector_number', 'expansion', 'era', 'artist', 'rarity', 'price_pkn']];
  for (const row of items || []) {
    if (!row?.id && !row?.name) continue;
    const era = row.era || eraForHold(row, row.expansion || '');
    rows.push([
      row.name || '',
      row.collectorNumber || '',
      row.expansion || '',
      era,
      row.artist || '',
      row.rarity || '',
      row.pricePkn === '' || row.pricePkn == null ? '' : String(row.pricePkn),
    ]);
  }
  return `${rows.map((line) => line.map(csvEscape).join(',')).join('\n')}\n`;
}

export function subscribeDesktopHold(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Server-render / first-snapshot value for subscribers. */
export function emptyDesktopHold() {
  return EMPTY;
}
