import { createEffect, createSignal, getOwner, runWithOwner, untrack } from 'solid-js';
import { whenIdle } from './idle.js';
import { lazyModule } from './lazy-module.js';

/**
 * App-lifetime card selection (market/src/select-band.jsx): Windows Explorer
 * gestures over card tiles and desk listing rows — Ctrl/Cmd toggles, Shift
 * takes a range, a drag box on empty page background selects what it
 * touches, and dragging a selected tile carries the whole group.
 *
 * This module is the small eager half: the selection signals tiles read and
 * the page-wide card catalog grids register into. The gesture engine
 * (listeners, rubber band, drag piles) is select-band-gestures.js, loaded
 * when the page goes idle or on the first press — whichever comes first.
 */
const [cardSelected, setCardSelectedSignal] = createSignal(new Set());
const [listingSelected, setListingSelectedSignal] = createSignal(new Set());
const [band, setBand] = createSignal(null);

export { band as selectBand, cardSelected, listingSelected, setBand };

/** Synchronous mirrors: gestures read and write these inside one event. */
export const bandState = {
  cards: cardSelected(),
  listings: listingSelected(),
  cardAnchor: '',
  listingAnchor: '',
  catalog: new Map(),
  shop: { offers: [], deskCard: null },
};
const gridCards = new Map();

export function setCards(next) {
  bandState.cards = next;
  setCardSelectedSignal(() => next);
}

export function setListings(next) {
  bandState.listings = next;
  setListingSelectedSignal(() => next);
}

function rebuildCatalog() {
  const next = new Map();
  for (const list of gridCards.values()) {
    for (const card of list || []) {
      const id = String(card?.id || card?.cardId || '');
      if (id) next.set(id, card);
    }
  }
  const desk = bandState.shop.deskCard;
  if (desk?.id) next.set(String(desk.id), desk);
  bandState.catalog = next;
}

export function registerGridCards(key, list) {
  if (!key) return;
  gridCards.set(key, list || []);
  rebuildCatalog();
}

export function unregisterGridCards(key) {
  if (!key) return;
  gridCards.delete(key);
  rebuildCatalog();
}

/** Card desk: its listings and desk card join a mixed drag pile. */
export function registerShop({ offers = [], deskCard = null } = {}) {
  bandState.shop = { offers: offers || [], deskCard: deskCard || null };
  rebuildCatalog();
}

export function unregisterShop() {
  bandState.shop = { offers: [], deskCard: null };
  rebuildCatalog();
}

export const bandEngine = lazyModule(() => import('./select-band-gestures.js'));

/** Ctrl/Cmd/Shift click on a tile, ranged over its grid's ids. */
export function clickCard(id, event, ids = []) {
  const engine = bandEngine.mod();
  if (engine) {
    engine.clickCard(id, event, ids);
    return;
  }
  bandEngine.ensure().then((loaded) => loaded.clickCard(id, event, ids)).catch(() => {});
}

/**
 * The drag payload for a tile: the selected group (or desk mix) when the
 * held tile is part of one, else null — the tile then drags just itself.
 * Nothing can be selected before the engine has loaded.
 */
export function dragPayload(card) {
  return bandEngine.mod()?.dragPayload(card) || null;
}

/** Card desk drag (a held listing or tile): the mixed pile, or null. */
export function deskDragReference(held) {
  return bandEngine.mod()?.dragReference(held) || null;
}

let installed = false;

/**
 * Chrome calls this once from its body (an owner), with an accessor for the
 * route (pathname + search) whose change drops the selection.
 */
export function installSelectBand(route) {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const owner = getOwner();
  const start = () => bandEngine.ensure()
    .then((engine) => runWithOwner(owner, () => engine.startGestures()))
    .catch(() => {});
  const cancelIdle = whenIdle(start);
  const onFirstPress = () => {
    cancelIdle();
    start();
  };
  document.addEventListener('pointerdown', onFirstPress, { once: true, capture: true });
  // Grids and the desk unregister their own cards when they unmount.
  createEffect(route, () => {
    setCards(new Set());
    setListings(new Set());
    bandState.cardAnchor = '';
    bandState.listingAnchor = '';
    untrack(bandEngine.mod)?.endGesture();
  }, { defer: true });
}
