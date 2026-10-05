/**
 * Seller inventory only surfaces listings that can still appear on a card desk.
 * Cancelled (inactive) and sold-out rows stay in Postgres for history but must
 * not look like live inventory links.
 */

import { indexToStackPos, stackPosToIndex } from './scan-model.js';

export function isLiveInventoryListing(row) {
  if (!row || typeof row !== 'object') return false;
  const status = String(row.status || 'active').toLowerCase();
  if (status !== 'active' && status !== 'paused') return false;
  return Number(row.quantityAvailable ?? row.quantity_available ?? 0) > 0;
}

export function liveInventoryListings(rows) {
  return (Array.isArray(rows) ? rows : []).filter(isLiveInventoryListing);
}

/** Card count and summed asking PKN for live inventory rows only. */
export function summarizeLiveInventory(rows) {
  const live = liveInventoryListings(rows);
  let cards = 0;
  let listedPkn = 0;
  for (const row of live) {
    const qty = Math.max(0, Number(row.quantityAvailable ?? row.quantity_available ?? 0) || 0);
    const price = Math.max(0, Number(row.pricePkn ?? row.price_pkn ?? 0) || 0);
    cards += qty;
    listedPkn += price * qty;
  }
  return {
    listings: live.length,
    cards,
    listedPkn,
  };
}

export function inventoryListingHref(row) {
  const path = String(row?.canonicalPath || row?.canonical_path || '').trim();
  if (path.startsWith('/marketplace/')) return path;
  const id = String(row?.cardId || row?.card_id || '').trim();
  if (/^\d+$/.test(id)) return `/marketplace/en/cards/${id}`;
  return '/marketplace';
}

export function inventoryListingMeta(row, formatPkn) {
  const price = typeof formatPkn === 'function'
    ? formatPkn(row?.pricePkn ?? row?.price_pkn)
    : `${row?.pricePkn ?? row?.price_pkn ?? 0} PKN`;
  const parts = [
    price,
    row?.condition || 'NM',
    `qty ${row?.quantityAvailable ?? row?.quantity_available ?? 1}`,
  ];
  const status = String(row?.status || '').toLowerCase();
  if (status === 'paused') parts.push('paused');
  const language = String(row?.language || '').trim().toUpperCase();
  if (language && language !== 'EN') parts.push(language);
  const loc = String(row?.location || '').trim();
  if (loc) parts.push(loc);
  return parts.join(' · ');
}

/** Short listed date for the inventory table (e.g. 30/09). */
export function inventoryRowDate(row) {
  const raw = String(row?.createdAt || row?.created_at || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';
  return `${match[3]}/${match[2]}`;
}

/** Row name searched case-insensitively across name, set, collector and location. */
function inventoryRowHaystack(row) {
  return [
    row?.cardName || row?.name,
    row?.setName || row?.set_name,
    row?.collectorNumber || row?.collector_number,
    row?.location,
  ]
    .map((part) => String(part || '').toLowerCase())
    .join(' ');
}

/** PowerTools-style client filters: text query, status, condition, language. */
export function filterInventoryRows(rows, { query = '', status = '', condition = '', language = '' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const needle = String(query || '').trim().toLowerCase();
  const wantStatus = String(status || '').toLowerCase();
  const wantCondition = String(condition || '').toUpperCase();
  const wantLanguage = String(language || '').toUpperCase();
  return list.filter((row) => {
    if (needle && !inventoryRowHaystack(row).includes(needle)) return false;
    if (wantStatus) {
      const rowStatus = String(row?.status || 'active').toLowerCase();
      if (rowStatus !== wantStatus) return false;
    }
    if (wantCondition) {
      const rowCondition = String(row?.condition || 'NM').toUpperCase();
      if (rowCondition !== wantCondition) return false;
    }
    if (wantLanguage) {
      const rowLanguage = String(row?.language || '').toUpperCase();
      if (rowLanguage !== wantLanguage) return false;
    }
    return true;
  });
}

export const INVENTORY_SORTS = ['newest', 'oldest', 'price-up', 'price-down', 'qty-down', 'name'];

/** Sort rows for the inventory table. */
export function sortInventoryRows(rows, sort = 'newest') {
  const list = [...(Array.isArray(rows) ? rows : [])];
  const price = (row) => Number(row?.pricePkn ?? row?.price_pkn ?? 0) || 0;
  const qty = (row) => Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0;
  const created = (row) => String(row?.createdAt || row?.created_at || '');
  const name = (row) => String(row?.cardName || row?.name || '').toLowerCase();
  switch (sort) {
    case 'oldest':
      return list.sort((a, b) => created(a).localeCompare(created(b)));
    case 'price-up':
      return list.sort((a, b) => price(a) - price(b));
    case 'price-down':
      return list.sort((a, b) => price(b) - price(a));
    case 'qty-down':
      return list.sort((a, b) => qty(b) - qty(a));
    case 'name':
      return list.sort((a, b) => name(a).localeCompare(name(b)));
    case 'newest':
    default:
      return list.sort((a, b) => created(b).localeCompare(created(a)));
  }
}

/**
 * Titles view: one block per card name, in the order the rows were sorted.
 * Price high → low therefore puts the name of the dearest listing first.
 */
export function groupInventoryTitles(rows) {
  const groups = new Map();
  const order = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const title = String(row?.cardName || row?.name || 'Listing');
    let group = groups.get(title);
    if (!group) {
      group = {
        title,
        printings: new Set(),
        postingCount: 0,
        copies: 0,
        askingPkn: 0,
        postings: [],
      };
      groups.set(title, group);
      order.push(group);
    }
    const id = String(row?.cardId || row?.card_id || '');
    if (id) group.printings.add(id);
    const qty = Math.max(0, Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0);
    const price = Number(row?.pricePkn ?? row?.price_pkn ?? 0) || 0;
    group.postingCount += 1;
    group.copies += qty;
    group.askingPkn += qty * price;
    group.postings.push(row);
  }
  return order.map((group) => ({ ...group, printings: group.printings.size }));
}

/** Distinct condition/language keys present in the rows, for the filter selects. */
export function inventoryFacets(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const conditions = new Set();
  const languages = new Set();
  for (const row of list) {
    const condition = String(row?.condition || 'NM').trim().toUpperCase();
    if (condition) conditions.add(condition);
    const language = String(row?.language || '').trim().toUpperCase();
    if (language) languages.add(language);
  }
  return {
    conditions: [...conditions].sort(),
    languages: [...languages].sort(),
  };
}

/** Stack key: identical printing in the same grade + foil facets. */
export function inventoryStackKey(row) {
  const facets = [
    row?.cardId || row?.card_id,
    String(row?.condition || 'NM').toUpperCase(),
    String(row?.language || '').toUpperCase(),
    row?.reverse === true ? 'rev' : '',
    (row?.firstEdition ?? row?.first_edition) === true ? '1st' : '',
    row?.graded === true ? 'graded' : '',
  ];
  return facets.map((part) => String(part ?? '')).join('|');
}

/**
 * Group location rows into stacks — same printing, grade and foil facets —
 * with the posting count and summed copies per stack. Ordered by posting
 * count desc (the busiest stack first), then copies, then name.
 */
export function groupInventoryStacks(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const stacks = new Map();
  for (const row of list) {
    const key = inventoryStackKey(row);
    const stack = stacks.get(key) || {
      key,
      cardId: row?.cardId || row?.card_id,
      cardName: row?.cardName || row?.name || 'Listing',
      setName: row?.setName || row?.set_name || '',
      collectorNumber: row?.collectorNumber || row?.collector_number || '',
      cardImageUrl: row?.cardImageUrl || row?.card_image_url || '',
      condition: row?.condition || 'NM',
      language: row?.language || '',
      location: row?.location || '',
      postings: [],
    };
    stack.postings.push(row);
    stacks.set(key, stack);
  }
  const grouped = [...stacks.values()];
  for (const stack of grouped) {
    stack.postingCount = stack.postings.length;
    stack.copies = stack.postings.reduce(
      (sum, row) => sum + Math.max(0, Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0),
      0,
    );
  }
  return grouped.sort((a, b) =>
    b.postingCount - a.postingCount
    || b.copies - a.copies
    || a.cardName.localeCompare(b.cardName));
}

/** Scope check for a pricing strategy against a listing row (SPA twin of the handler's rule). */
export function strategyMatchesListing(strategy, row) {
  if (!strategy || strategy.enabled === false) return false;
  if (strategy.condition && String(row?.condition || 'NM').toUpperCase() !== strategy.condition) return false;
  if (strategy.language && String(row?.language || '').toUpperCase() !== strategy.language) return false;
  return true;
}

/**
 * Parse a listing location into { box, stack, position, structured }.
 * Grammar (scan slotText + PowerTools CSV):
 *   `box`                → bare box, no slot
 *   `box·7`              → stack 7
 *   `box·7-9`            → stacks 7..9 (qty spanning dividers)
 *   `box·3·5`            → stack 3, position 5
 *   `box·3·5-9`          → stack 3, positions 5..9
 *   `box·3·5–9·2`        → spanning stacks 3..9 (en dash), ended at position 2
 * `·`/`•` are separators; the box is everything before the first one.
 */
export function parseListingLocation(raw) {
  const text = String(raw || '').trim();
  if (!text) return { box: '', stack: null, position: null, structured: false };
  const sepIndex = text.search(/[·•]/);
  if (sepIndex === -1) {
    return { box: text, stack: null, position: null, structured: false };
  }
  const box = text.slice(0, sepIndex).trim();
  const tail = text.slice(sepIndex + 1);
  // Dashes delimit a range inside one slot, not a new stack/position field.
  const numbers = tail.split(/[·•]/).map((part) => parseInt(part, 10)).filter((n) => Number.isFinite(n) && n > 0);
  const stack = numbers.length ? numbers[0] : null;
  const position = numbers.length > 1 ? numbers[1] : null;
  return { box, stack, position, structured: stack != null };
}

/** The box a listing belongs to (everything before the first slot separator). */
export function listingBox(raw) {
  return parseListingLocation(raw).box;
}

/**
 * Case-insensitive box match: does a stored location (which may carry a
 * ·stack-position suffix) belong to the box a URL names? A hand-typed slug
 * matches across casing.
 */
export function sameListingBox(raw, box) {
  const left = listingBox(raw).trim().toLowerCase();
  const right = listingBox(box).trim().toLowerCase();
  return Boolean(left) && left === right;
}

/** Match a location page to its whole box, including numbered slots. */
export function inventoryRowsForLocation(rows, location) {
  if (!listingBox(location)) return [];
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => sameListingBox(row?.location, location));
}

/**
 * Explicit divider stacks for one box, ordered by stack number asc,
 * followed by flat box positions. A two-part location is a flat position;
 * only a location carrying an intra-stack position proves a divider exists.
 * each stack's postings ordered by position asc, then date, then id.
 */
export function groupBoxStacks(rows, box) {
  const wanted = String(box || '').trim();
  const list = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ row, parsed: parseListingLocation(row?.location) }))
    .filter((entry) => entry.parsed.box
      && entry.parsed.box.toLowerCase() === wanted.toLowerCase());
  const stacks = new Map();
  for (const { row, parsed } of list) {
    const stackNo = parsed.position == null ? 0 : (parsed.stack ?? 0);
    const stack = stacks.get(stackNo) || { stack: stackNo, postings: [] };
    const fields = String(row?.location || '').trim().split(/[·•]/);
    const positionText = fields[parsed.position == null ? 1 : 2] || '';
    stack.postings.push({ ...row, slotPosition: parsed.position ?? parsed.stack,
      slotPositionText: /^\d+(?:[-–—]\d+)?$/.test(positionText) ? positionText : '' });
    stacks.set(stackNo, stack);
  }
  const order = (a, b) => {
    if ((a.slotPosition ?? 9999) !== (b.slotPosition ?? 9999)) {
      return (a.slotPosition ?? 9999) - (b.slotPosition ?? 9999);
    }
    return String(a.createdAt || a.created_at || '').localeCompare(String(b.createdAt || b.created_at || ''))
      || String(a.id || '').localeCompare(String(b.id || ''));
  };
  return [...stacks.values()]
    .map((stack) => {
      stack.postings.sort(order);
      stack.postingCount = stack.postings.length;
      stack.copies = stack.postings.reduce(
        (sum, row) => sum + Math.max(0, Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0),
        0,
      );
      return stack;
    })
    .sort((a, b) => (a.stack === 0 ? 1 : b.stack === 0 ? -1 : a.stack - b.stack));
}

/**
 * Where a listing's slot ends: { box, stack, position } (position null when
 * the location names a whole stack). `box·3·5-9` ends at 3·9, `box·3·5–9·2`
 * at 9·2, `box·7-9` at stack 9.
 */
export function listingSlotEnd(raw) {
  const parsed = parseListingLocation(raw);
  if (!parsed.structured) return { box: parsed.box, stack: null, position: null };
  const text = String(raw || '').trim();
  const tail = text.slice(text.search(/[·•]/) + 1).replace(/\s+/g, '');
  let m = tail.match(/^(\d+)[·•](\d+)[–—](\d+)[·•](\d+)$/);
  if (m) return { box: parsed.box, stack: Number(m[3]), position: Number(m[4]) };
  m = tail.match(/^(\d+)[·•](\d+)-(\d+)$/);
  if (m) return { box: parsed.box, stack: Number(m[1]), position: Number(m[3]) };
  m = tail.match(/^(\d+)[-–—](\d+)$/);
  if (m) return { box: parsed.box, stack: Number(m[2]), position: null };
  return { box: parsed.box, stack: parsed.stack, position: parsed.position };
}

/**
 * Last slot a box already holds, as an absolute card index for `stackSize`
 * (0 = empty box). A whole-stack location (`box·4`) fills stack 4 when stacks
 * hold more than one card.
 */
export function lastOccupiedIndex(rows, box, stackSize = 1) {
  const wanted = String(box || '').trim();
  const size = Math.max(1, Math.trunc(Number(stackSize)) || 1);
  let max = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const end = listingSlotEnd(row?.location);
    if (!end.box || end.box !== wanted || end.stack == null) continue;
    const abs = size === 1
      ? end.stack
      : end.position == null
        ? end.stack * size
        : stackPosToIndex(end.stack, Math.min(size, end.position), size);
    if (abs > max) max = abs;
  }
  return max;
}

/** First free { stack, startPosition } after the stock already in a box, or null. */
export function nextFreeSlot(rows, box, stackSize = 1) {
  const size = Math.max(1, Math.trunc(Number(stackSize)) || 1);
  const last = lastOccupiedIndex(rows, box, size);
  if (!last) return null;
  const next = indexToStackPos(Math.min(9999 * size, last + 1), size);
  return { stack: next.stack, startPosition: next.position, abs: last + 1 };
}

/**
 * Boxes in the order the rows are given (newest listing first). The first
 * name is the box the seller used last. Casing is kept from that first row.
 */
export function recentBoxes(rows) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const box = listingBox(row?.location);
    if (!box) continue;
    const key = box.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(box);
  }
  return out;
}

function addedStamp(row) {
  const ms = Date.parse(String(row?.createdAt || row?.created_at || '').trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Where the next scan goes in a box the seller already uses.
 * The cursor is the slot after the last card added to that box (same
 * timestamp: the higher position). Stack size stays the seller's divider.
 * A size-1 batch cannot write `·stack·position`, so it adopts the fullest
 * earlier stack (the 80 already used) instead of growing the size to
 * "last position + 1", which made that one card look like a full stack
 * and opened the next divider. A position past the divider still opens
 * the next stack. Flat `box·7` locations keep the size-1 walk.
 */
export function continueBoxCursor(rows, box, stackSize = 1) {
  const configured = Math.max(1, Math.trunc(Number(stackSize)) || 1);
  const wanted = String(box || '').trim();
  const positioned = [];
  const posByStack = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const end = listingSlotEnd(row?.location);
    if (!end.box || end.box !== wanted || end.stack == null || end.position == null) continue;
    positioned.push({ row, stack: end.stack, position: end.position, stamp: addedStamp(row) });
    posByStack.set(end.stack, Math.max(posByStack.get(end.stack) || 0, end.position));
  }
  if (!positioned.length) {
    const next = nextFreeSlot(rows, box, configured);
    if (!next) return null;
    return { stack: next.stack, startPosition: next.startPosition, stackSize: configured };
  }
  const stacks = [...posByStack.keys()].sort((a, b) => a - b);
  const openStack = stacks[stacks.length - 1];
  let earlierMax = 0;
  for (const stackNo of stacks) {
    if (stackNo === openStack) continue;
    earlierMax = Math.max(earlierMax, posByStack.get(stackNo));
  }
  const size = configured === 1 && earlierMax > 1 ? earlierMax : configured;
  positioned.sort((a, b) => {
    const as = a.stamp == null ? -1 : a.stamp;
    const bs = b.stamp == null ? -1 : b.stamp;
    if (as !== bs) return as - bs;
    if (a.stack !== b.stack) return a.stack - b.stack;
    if (a.position !== b.position) return a.position - b.position;
    return String(a.row?.id || '').localeCompare(String(b.row?.id || ''));
  });
  const last = positioned[positioned.length - 1];
  let stack = last.stack;
  let startPosition = last.position + 1;
  if (size > 1 && startPosition > size) {
    stack += 1;
    startPosition = 1;
  }
  return { stack, startPosition, stackSize: size };
}

/**
 * Seed map for scan `boxSlots`: bare box location → last absolute index
 * already taken in live inventory. Uses each scan row's stackSize snapshot.
 */
export function occupiedAbsForScanBoxes(scanRows, stockRows) {
  const map = new Map();
  const seen = new Set();
  for (const row of Array.isArray(scanRows) ? scanRows : []) {
    const loc = String(row?.location ?? '').trim();
    if (!loc || seen.has(loc)) continue;
    seen.add(loc);
    const snap = row.defaultsSnapshot || row.defaults_snapshot || {};
    const size = Math.max(1, Math.trunc(Number(snap.stackSize)) || 1);
    const last = lastOccupiedIndex(stockRows, loc, size);
    if (last > 0) map.set(loc, last);
  }
  return map;
}

/**
 * Next free position inside one stack (the seller typed that stack), or null
 * when nothing is stored there yet. Returns size + 1 when the stack is full.
 */
export function nextPositionInStack(rows, box, stack, stackSize = 1) {
  const wanted = String(box || '').trim();
  const size = Math.max(1, Math.trunc(Number(stackSize)) || 1);
  const s = Math.trunc(Number(stack)) || 0;
  if (size === 1 || s < 1) return null;
  let max = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const start = parseListingLocation(row?.location);
    const end = listingSlotEnd(row?.location);
    if (!end.box || end.box !== wanted || end.stack == null) continue;
    if (s < (start.stack ?? end.stack) || s > end.stack) continue;
    // Spanning into a later stack fills this one; a whole-stack location fills it too.
    const pos = end.stack > s || end.position == null ? size : Math.min(size, end.position);
    if (pos > max) max = pos;
  }
  return max ? max + 1 : null;
}

/** Highest stack number a seller already occupies in a box (inventory hint). */
export function maxOccupiedStack(rows, box) {
  const wanted = String(box || '').trim();
  let max = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const parsed = parseListingLocation(row?.location);
    if (wanted && parsed.box !== wanted) continue;
    if (parsed.stack != null && parsed.stack > max) max = parsed.stack;
  }
  return max;
}
