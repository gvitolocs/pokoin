/** Cards parked on the Desktop hold tray (not the cart). */

import { useSyncExternalStore } from 'react';
import { gameBasename } from './game.js';
import { printingIdentity } from './identity.js';
import { homepageDerivativeUrl, ownCatalogImage, preferFullImage } from './image-urls.js';
import { tilePricePkn } from './pkn.js';
import { tcgEra } from './set-logos.js';

const KEY = 'pokoin.desktopHold';
const MAX = 200;
const EMPTY = [];
const listeners = new Set();

/** Stable getSnapshot for useSyncExternalStore — a fresh [] each call black-screens React. */
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
  const owned = ownCatalogImage(withId, preferFullImage(raw) || raw);
  if (owned) {
    return homepageDerivativeUrl(owned) || owned;
  }
  return '';
}

export function readDesktopHold() {
  try {
    if (typeof localStorage === 'undefined') return cachedItems;
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
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, cachedRaw);
    }
  } catch (_) {
    /* private mode */
  }
  notify();
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
  const seen = new Set(current.map((row) => row.id));
  const next = [...current];
  let added = 0;
  for (const card of incoming) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    next.push(card);
    added += 1;
    if (next.length >= MAX) break;
  }
  if (added) writeDesktopHold(next);
  return added;
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

export function useDesktopHold() {
  return useSyncExternalStore(subscribeDesktopHold, readDesktopHold, () => EMPTY);
}
