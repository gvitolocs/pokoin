/**
 * Preview collections for `/dashboard?dashPreview`.
 *
 * The live Collections level reads `GET /api/marketplace-portfolio-collections`.
 * The fixture layout has no account behind it, so the same answer is derived
 * here from the dashboard's own preview history series: deterministic
 * arithmetic, no clock and no randomness, so two renders of the preview paint
 * identical sparklines — like `portfolio-segments-preview.js` does for the
 * other levels.
 */

import { DEFAULT_LIMITS, itemIdOf } from './portfolio-collections.js';

/** Two lists: one priced through and one with a sealed box nobody has sold. */
export const PREVIEW_COLLECTIONS = [
  {
    id: 'preview-charizard',
    name: 'Charizard binder',
    createdAt: '2026-02-04T10:00:00Z',
    updatedAt: '2026-11-14T18:20:00Z',
    items: [
      { game: 'pokemon', cardId: '129552', name: 'Charizard', setName: 'Base Set 4/102', condition: 'NM', language: 'EN', reverse: false, firstEdition: true, graded: false, quantity: 1, pricePkn: 480 },
      { game: 'pokemon', cardId: '129552', name: 'Charizard', setName: 'Base Set 4/102', condition: 'MP', language: 'EN', reverse: false, firstEdition: true, graded: false, quantity: 1, pricePkn: 165 },
      { game: 'pokemon', cardId: '226087', name: 'Charizard ex', setName: 'Scarlet & Violet 151 199/165', condition: 'NM', language: 'EN', reverse: true, firstEdition: false, graded: false, quantity: 2, pricePkn: 74 },
      { game: 'pokemon', cardId: '195690', name: 'Charizard VMAX', setName: "Champion's Path 187/195", condition: 'NM', language: 'EN', reverse: false, firstEdition: false, graded: false, quantity: 1, pricePkn: 240 },
      { game: 'pokemon', cardId: '86432', name: 'Charizard', setName: 'Basic Set 12/16 (JP)', condition: 'NM', language: 'JP', reverse: false, firstEdition: false, graded: false, quantity: 1, pricePkn: 105 },
      { game: 'pokemon', cardId: '129552', name: 'Charizard', setName: 'Base Set 4/102', condition: 'NM', language: 'EN', reverse: false, firstEdition: true, graded: true, quantity: 1, pricePkn: 529 },
    ],
  },
  {
    id: 'preview-whatif',
    name: 'What if: 2023 sealed',
    createdAt: '2026-06-21T08:00:00Z',
    updatedAt: '2026-11-10T11:05:00Z',
    items: [
      { game: 'pokemon', cardId: '218455', name: 'Scarlet & Violet 151 Booster Bundle', setName: '151 sealed', condition: 'NM', language: 'EN', reverse: false, firstEdition: false, graded: false, quantity: 3, pricePkn: 210 },
      { game: 'pokemon', cardId: '203771', name: 'Crown Zenith Elite Trainer Box', setName: 'Sword & Shield', condition: 'NM', language: 'EN', reverse: false, firstEdition: false, graded: false, quantity: 1, pricePkn: 260 },
      // Nobody has ever sold this one: the list is held, and reads 0 for it.
      { game: 'pokemon', cardId: '176014', name: 'Evolving Skies Booster Bundle', setName: 'Sword & Shield', condition: 'NM', language: 'EN', reverse: false, firstEdition: false, graded: false, quantity: 2, pricePkn: null },
    ],
  },
];

/** The two lists move with the book, each at its own slow phase. */
const WOBBLE_AMPLITUDE = 0.012;
const WOBBLE_PERIOD_DAYS = 9;

/**
 * The fixture's own sold-price book, by slice — the preview's stand-in for the
 * market read the live answer prices out of. A write carries no price (the
 * server resolves every one), so the lists the desk holds are priced back from
 * here on every ask: a slice this book knows keeps its price whatever the list
 * else says about it, and one it does not — a card the seller just searched —
 * is one nobody has sold.
 */
const PRICE_BOOK = new Map(PREVIEW_COLLECTIONS.flatMap((collection) => (collection.items || [])
  .map((item) => [itemIdOf(item), Number(item.pricePkn) > 0 ? item.pricePkn : null])));

/** What one copy of this slice sold for in the fixture, or null when nobody has. */
export function previewPriceOf(item) {
  return PRICE_BOOK.get(itemIdOf(item)) ?? null;
}

function pricedRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((collection) => ({
    ...collection,
    items: (Array.isArray(collection?.items) ? collection.items : []).map((item) => ({
      ...item,
      pricePkn: previewPriceOf(item),
    })),
  }));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function amountOf(day, field) {
  const raw = day?.assets?.[field] ?? day?.[field];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function copies(items, onlyPriced) {
  return items.reduce((acc, item) => {
    if (onlyPriced && !(Number(item?.pricePkn) > 0)) return acc;
    return acc + Math.max(1, Math.trunc(Number(item?.quantity) || 1));
  }, 0);
}

function dayValue(items, factor) {
  return round2(items.reduce((acc, item) => {
    const price = Number(item?.pricePkn);
    if (!(price > 0)) return acc;
    return acc + price * Math.max(1, Math.trunc(Number(item?.quantity) || 1)) * factor;
  }, 0));
}

/**
 * The API's own answer shape for the preview lists over `series`. The items are
 * priced from the fixture's book, never from what the write carried, and a day
 * the book has no value for carries no segments at all — exactly like the live
 * split of a series that only started recording recently.
 */
export function previewCollectionsFrom(series, collections = PREVIEW_COLLECTIONS) {
  const rows = pricedRows(collections);
  const dayRows = (Array.isArray(series) ? series : []).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day?.date || '')));
  const values = dayRows.map((day) => amountOf(day, 'cardsValuePkn'));
  const baseIndex = values.findIndex((value) => value != null && value > 0);
  const base = baseIndex < 0 ? null : values[baseIndex];
  const days = [];
  let cardDay = 0;
  dayRows.forEach((day, index) => {
    const value = values[index];
    if (!(value > 0)) {
      days.push({ date: day.date, cardsValuePkn: value, segments: {} });
      return;
    }
    cardDay += 1;
    const segments = {};
    rows.forEach((collection, at) => {
      const items = Array.isArray(collection?.items) ? collection.items : [];
      const angle = ((cardDay + at * 3) / WOBBLE_PERIOD_DAYS) * Math.PI * 2;
      const factor = (value / base) * (1 + WOBBLE_AMPLITUDE * Math.sin(angle));
      const held = copies(items, false);
      if (!items.length) {
        segments[`collection:${collection.id}`] = [0, 0, 0];
        return;
      }
      segments[`collection:${collection.id}`] = [dayValue(items, factor), copies(items, true), held];
    });
    days.push({ date: day.date, cardsValuePkn: value, segments });
  });
  return {
    priceBasis: 'ct-last-sold',
    limits: DEFAULT_LIMITS,
    collections: rows,
    segmentDefs: rows.map((collection) => ({
      key: `collection:${collection.id}`,
      group: 'collection',
      label: collection.name,
    })),
    days,
  };
}
