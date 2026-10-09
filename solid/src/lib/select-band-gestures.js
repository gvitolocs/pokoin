import { createEffect } from 'solid-js';
import { applyCardSelect, bandHits, cardsForDragFromCatalog, selectionFromBand } from '@market/card-select.js';
import { cardReference, cardsReference } from '@market/chat-listing.js';
import {
  clearShopSelectionOnPointer,
  marqueeRectForScroll,
  marqueeStartAllowed,
  mixedDeskDragReference,
  rectsIntersect,
  selectBandAllowed,
} from '@market/shop-marquee.js';
import { bandState, cardSelected, listingSelected, selectBand as band, setBand, setCards, setListings } from './select-band.js';

/**
 * The selection gesture engine (market/src/select-band.jsx's listeners), a
 * lazy chunk of lib/select-band.js. Only the gesture starts stay on
 * (pointer/mouse down, the listing click); move/up/scroll exist only while a
 * box is being drawn, Escape and the outside press only while something is
 * selected.
 */
const DRAG_THRESHOLD = 5;
let origin = null;
let armed = false;
let pointer = { x: 0, y: 0 };

function cardRects() {
  const scope = document.querySelector('main');
  if (!scope) return [];
  return [...scope.querySelectorAll('[data-card-id]')].flatMap((node) => {
    const id = node.getAttribute('data-card-id');
    if (!id) return [];
    const rect = node.getBoundingClientRect();
    return [{ id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }];
  });
}

function listingRows() {
  return [...document.querySelectorAll('main .shop-row[data-listing-id]')];
}

function listingRects() {
  return listingRows().map((row) => {
    const box = row.getBoundingClientRect();
    return { id: row.dataset.listingId, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  }).filter((row) => row.id);
}

function restoreListingDrag() {
  for (const row of listingRows()) {
    if (row.dataset.wasDraggable) {
      row.draggable = true;
      delete row.dataset.wasDraggable;
    }
  }
}

function clearAll() {
  setCards(new Set());
  setListings(new Set());
  bandState.cardAnchor = '';
  bandState.listingAnchor = '';
}

function paint(rect) {
  const hits = bandHits(cardRects(), { x0: rect.left, y0: rect.top, x1: rect.right, y1: rect.bottom });
  setCards(selectionFromBand(origin?.additive ? origin.cardBase : new Set(), hits, { ctrl: Boolean(origin?.additive) }));
  const next = new Set(origin?.additive ? origin.listingBase : []);
  for (const row of listingRects()) {
    if (rectsIntersect(rect, row)) next.add(row.id);
    else if (!origin?.additive) next.delete(row.id);
  }
  setListings(next);
}

function bandFromPointer(clientX, clientY) {
  if (!origin) return null;
  return marqueeRectForScroll(origin, clientX, clientY, window.scrollX || 0, window.scrollY || 0);
}

function onMove(event) {
  if (!origin) return;
  pointer = { x: event.clientX, y: event.clientY };
  const rect = bandFromPointer(event.clientX, event.clientY);
  if (!rect) return;
  if (!armed && Math.hypot(rect.width, rect.height) < DRAG_THRESHOLD) return;
  if (!armed) {
    armed = true;
    for (const row of listingRows()) {
      if (row.draggable) {
        row.dataset.wasDraggable = '1';
        row.draggable = false;
      }
    }
  }
  document.documentElement.classList.add('is-card-banding', 'is-shop-marquee');
  setBand(rect);
  paint(rect);
}

/** Page scroll while the button is held — the box tracks content, not the viewport. */
function onScroll() {
  if (!origin || !armed) return;
  const rect = bandFromPointer(pointer.x, pointer.y);
  if (!rect) return;
  setBand(rect);
  paint(rect);
}

function onUp() {
  if (armed) {
    const stopClick = (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      window.removeEventListener('click', stopClick, true);
    };
    window.addEventListener('click', stopClick, true);
  } else if (origin && !origin.additive) {
    clearAll();
  }
  endGesture();
}

/** Drop any box being drawn (route change, Escape, pointer up). */
export function endGesture() {
  origin = null;
  armed = false;
  setBand(null);
  restoreListingDrag();
  document.documentElement.classList.remove('is-card-banding', 'is-shop-marquee');
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onUp);
  window.removeEventListener('scroll', onScroll, true);
}

function onDown(event) {
  if (event.button !== 0) return;
  if (!selectBandAllowed(event)) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!marqueeStartAllowed(target)) return;
  const listingId = target.closest?.('.shop-row[data-listing-id]')?.dataset?.listingId || '';
  if (listingId && bandState.listings.has(listingId)) return;
  const additive = event.ctrlKey || event.metaKey;
  origin = {
    x: event.clientX,
    y: event.clientY,
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    additive,
    cardBase: additive ? new Set(bandState.cards) : new Set(),
    listingBase: additive ? new Set(bandState.listings) : new Set(),
  };
  pointer = { x: event.clientX, y: event.clientY };
  armed = false;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('scroll', onScroll, true);
}

function onMouseDown(event) {
  if (event.button !== 0) return;
  if (!selectBandAllowed(event)) return;
  if (!marqueeStartAllowed(event.target)) return;
  // Keep empty-background bands from turning into text selection.
  event.preventDefault();
}

function onListingClick(event) {
  if (!selectBandAllowed(event)) return;
  if (!(event.shiftKey || event.ctrlKey || event.metaKey)) return;
  const row = event.target?.closest?.('.shop-row[data-listing-id]');
  if (!row) return;
  if (event.target?.closest?.('a, button, input, select, textarea, .ct-qty, .art-frame')) return;
  const list = row.closest('.shop-list');
  if (!list?.contains(row)) return;
  event.preventDefault();
  const id = row.dataset.listingId;
  const ids = [...list.querySelectorAll('.shop-row[data-listing-id]')]
    .map((item) => item.dataset.listingId)
    .filter(Boolean);
  const listings = bandState.listings;
  let next = null;
  if (event.shiftKey && bandState.listingAnchor) {
    const from = ids.indexOf(bandState.listingAnchor);
    const to = ids.indexOf(id);
    if (from >= 0 && to >= 0) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      next = new Set(event.ctrlKey || event.metaKey ? listings : []);
      for (let i = lo; i <= hi; i += 1) next.add(ids[i]);
    }
  }
  if (!next) {
    next = new Set(listings);
    if ((event.ctrlKey || event.metaKey) && next.has(id)) next.delete(id);
    else next.add(id);
  }
  setListings(next);
  bandState.listingAnchor = id;
}

function onOutsideDown(event) {
  if (event.button !== 0) return;
  if (!selectBandAllowed(event)) return;
  if (!clearShopSelectionOnPointer(event.target, document.querySelector('main .shop-list'), bandState.listings, event)) return;
  if (bandState.listings.size) {
    setListings(new Set());
    bandState.listingAnchor = '';
  }
}

function onKey(event) {
  if (event.key !== 'Escape') return;
  clearAll();
  endGesture();
}

let started = false;

/** Attach the gesture listeners; called once, under the app shell's owner. */
export function startGestures() {
  if (started) return;
  started = true;
  document.addEventListener('pointerdown', onDown);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('click', onListingClick);
  createEffect(
    () => cardSelected().size > 0 || listingSelected().size > 0 || Boolean(band()),
    (active) => {
      if (!active) return undefined;
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    },
  );
  createEffect(
    () => listingSelected().size > 0,
    (active) => {
      if (!active) return undefined;
      document.addEventListener('pointerdown', onOutsideDown, true);
      return () => document.removeEventListener('pointerdown', onOutsideDown, true);
    },
  );
}

/** Ctrl/Cmd/Shift click on a tile, ranged over its grid's ids. */
export function clickCard(id, event, ids = []) {
  if (!selectBandAllowed(event)) return;
  const next = applyCardSelect(
    { selected: bandState.cards, anchor: bandState.cardAnchor },
    ids,
    id,
    { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey },
  );
  setCards(next.selected);
  if (next.anchor) bandState.cardAnchor = next.anchor;
}

function cardsForDrag(card) {
  // DOM order first so a pile spanning several rails stays left-to-right /
  // top-to-bottom, then any selected id still in the catalog.
  const { cards, catalog } = bandState;
  const ordered = new Map();
  for (const node of document.querySelectorAll('main [data-card-id]')) {
    const cid = node.getAttribute('data-card-id');
    if (!cid || !cards.has(cid) || ordered.has(cid)) continue;
    const row = catalog.get(cid);
    if (row) ordered.set(cid, row);
  }
  for (const cid of cards) {
    if (ordered.has(cid)) continue;
    const row = catalog.get(cid);
    if (row) ordered.set(cid, row);
  }
  return cardsForDragFromCatalog(card, cards, ordered.size ? ordered : catalog);
}

/** Desk drag: listings + tiles together when both are multi-selected. */
export function dragReference({ heldCard = null, heldOffer = null } = {}) {
  const { cards, listings } = bandState;
  if (cards.size + listings.size < 2) return null;
  return mixedDeskDragReference({
    heldOffer,
    heldCard,
    offers: bandState.shop.offers,
    catalog: bandState.catalog,
    cardSelected: cards,
    listingSelected: listings,
    deskCard: bandState.shop.deskCard,
  });
}

/** What dragging this tile carries (market CardTile onDragStart). */
export function dragPayload(card) {
  const mixed = dragReference({ heldCard: card });
  if (mixed) return mixed;
  const group = cardsForDrag(card);
  return group.length > 1 ? cardsReference(group) : cardReference(card);
}
