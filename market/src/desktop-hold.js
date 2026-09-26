/** Cards parked on the Desktop hold tray (not the cart). */

import { useSyncExternalStore } from 'react';

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

export function readDesktopHold() {
  try {
    if (typeof localStorage === 'undefined') return cachedItems;
    const raw = localStorage.getItem(KEY) || '[]';
    if (raw === cachedRaw) return cachedItems;
    const parsed = JSON.parse(raw);
    cachedItems = Array.isArray(parsed) ? parsed.filter((row) => row && row.id) : EMPTY;
    cachedRaw = raw;
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
export function desktopHoldCard(card = {}) {
  const id = String(card.id || card.cardId || card.card_id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(card.name || card.cardName || 'Card'),
    imageUrl: String(
      card.imageUrl
      || card.gridImageUrl
      || card.heroImageUrl
      || card.image
      || card.image_url
      || '',
    ),
    path: String(
      card.path
      || card.canonicalPath
      || card.canonical_path
      || `/marketplace/en/cards/${id}`,
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

/** Spreadsheet of parked Desktop cards. */
export function desktopHoldCsv(items = readDesktopHold()) {
  const rows = [['card_id', 'name', 'path', 'image_url']];
  for (const row of items || []) {
    if (!row?.id) continue;
    rows.push([
      row.id,
      row.name || '',
      row.path || '',
      row.imageUrl || '',
    ]);
  }
  return `${rows.map((line) => line.map(csvEscape).join(',')).join('\n')}\n`;
}

export function downloadDesktopHoldCsv(items = readDesktopHold()) {
  if (typeof document === 'undefined') return false;
  const list = items || [];
  if (!list.length) return false;
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([desktopHoldCsv(list)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pokoin-desktop-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

export function subscribeDesktopHold(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDesktopHold() {
  return useSyncExternalStore(subscribeDesktopHold, readDesktopHold, () => EMPTY);
}
