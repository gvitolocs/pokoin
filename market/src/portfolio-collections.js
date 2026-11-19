/**
 * The seller's custom collections — named lists of cards kept on the Dashboard.
 *
 * `GET /api/marketplace-portfolio-collections` answers the saved lists, the
 * limits they obey, and the same per-day segment split the table reads, so a
 * collection is one more row of segments: `group: 'collection'`, key
 * `collection:<id>`, `[valuePkn, cardsPriced, cardsHeld]` per day. A list may
 * hold cards the seller does not own, and the server prices it on every past
 * day with fixed quantities — the row is a backtest, not a holding.
 *
 * Everything here is pure and tolerates junk: an unfinished or malformed
 * answer becomes the empty state, never a throw and never a half-row.
 */

import { GAMES } from './game.js';
import { conditionShort } from './listing-meta.js';
import { normalizeSegmentDefs, normalizeSegments } from './portfolio-segments.js';

/** What the server answers in `limits` when it says nothing. */
export const DEFAULT_LIMITS = Object.freeze({ collections: 20, items: 300, quantity: 999, name: 40 });

/** The segment group a collection row belongs to, and the key it is filed under. */
export const COLLECTION_GROUP = 'collection';
export const COLLECTION_KEY_PREFIX = 'collection:';

/** The game, condition and language a row prices under when nothing says otherwise (market/src/card-desk.js). */
export const DEFAULT_ITEM_GAME = 'pokemon';
export const DEFAULT_ITEM_CONDITION = 'NM';
export const DEFAULT_ITEM_LANGUAGE = 'EN';

export function collectionKey(id) {
  const clean = String(id ?? '').trim();
  return clean ? `${COLLECTION_KEY_PREFIX}${clean}` : '';
}

/** The saved id a segment key stands for, or '' for any other group. */
export function collectionIdFromKey(key) {
  const text = String(key ?? '');
  return text.startsWith(COLLECTION_KEY_PREFIX) ? text.slice(COLLECTION_KEY_PREFIX.length) : '';
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A public card id, however the row came: digits only, nothing else. The
 * server stores it as a number, so `0012` and `12` are one card — the zeros
 * come off here too, or the same card would be two rows of one list.
 */
function cardIdText(value) {
  const clean = text(value);
  if (/^\d+$/.test(clean)) return clean.replace(/^0+/, '');
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? String(n) : '';
}

function languageText(value) {
  return (text(value) || DEFAULT_ITEM_LANGUAGE).toUpperCase();
}

/**
 * The condition in the vocabulary the listing forms store: NM, SP, MP, PL,
 * Poor (card-desk.js `MOOD_CONDS`). The server answered Poor as `PO`, and one
 * condition cannot be two rows of one list: `PO` reads as `Poor`, the same way
 * `moodCondition` in the desk does it. Anything else is what it was sent as.
 */
function conditionText(value) {
  const clean = text(value);
  if (!clean) return DEFAULT_ITEM_CONDITION;
  return conditionShort(clean) === 'PO' ? 'Poor' : clean;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function wholeNumber(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function flag(row, key) {
  const value = row?.[key] ?? row?.[snake(key)];
  return value === true || value === 'true' || value === 1;
}

function snake(key) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function positiveLimit(value, fallback) {
  const n = wholeNumber(value, 0);
  return n > 0 ? n : fallback;
}

export function normalizeLimits(limits) {
  return {
    collections: positiveLimit(limits?.collections, DEFAULT_LIMITS.collections),
    items: positiveLimit(limits?.items, DEFAULT_LIMITS.items),
    quantity: positiveLimit(limits?.quantity, DEFAULT_LIMITS.quantity),
    name: positiveLimit(limits?.name, DEFAULT_LIMITS.name),
  };
}

/** The slice a row prices at: id and facets, nothing else. */
export function itemIdOf(item = {}) {
  return [
    text(item.game) || DEFAULT_ITEM_GAME,
    cardIdText(item.cardId),
    conditionText(item.condition),
    languageText(item.language),
    flag(item, 'reverse') ? 'R' : '-',
    flag(item, 'firstEdition') ? '1' : '-',
    flag(item, 'graded') ? 'G' : '-',
  ].join('|');
}

/**
 * Which of its lines an item row shows for a price — the decision only;
 * the words and the formatting are the form's.
 *
 * - `unavailable` — the answer said the price service is out (`seriesError`), so
 *   nothing is priced, this row included. It comes before every other question:
 *   a null that is the whole desk's does not mean this slice sold nothing.
 * - `later` — nothing answers for this slice: the row came straight from the
 *   search, or a facet has moved it off the slice the server priced.
 * - `pending` — the server priced this slice, but the desk does not yet know
 *   the currency an amount in it would be written.
 * - `amount` — the server's sold price for exactly this slice.
 * - `sold` — the server answered this slice and said nothing had sold on it.
 */
export function itemPriceLine(item, { currencyPending = false, pricesUnavailable = false } = {}) {
  if (pricesUnavailable) return 'unavailable';
  const slice = text(item?.id);
  if (!slice || text(item?.pricedId) !== slice) return 'later';
  if (currencyPending) return 'pending';
  return Number(item?.pricePkn) > 0 ? 'amount' : 'sold';
}

/**
 * The game a row belongs to, in the words a seller uses for it. A collection
 * item carries the catalog id (`pokemon`), and a line that reads "Base Set 4/102
 * • pokemon" says nothing a person reads as a game.
 */
export function gameDisplayName(id) {
  const clean = text(id);
  return GAMES[clean]?.name || clean;
}

/**
 * Whether the rows have to name their game at all: a list of one game is that
 * game's list, and the label under every card would only repeat the picker
 * above it. Two games in one list is the case where a row must say.
 */
export function rowsShowGame(items) {
  const games = new Set((Array.isArray(items) ? items : [])
    .map((item) => text(item?.game) || DEFAULT_ITEM_GAME));
  return games.size > 1;
}

function pricePknOf(row) {
  const price = numberOrNull(row?.pricePkn ?? row?.price_pkn);
  return price == null || price < 0 ? null : price;
}

function normalizeItem(row, limits) {
  // The public card id is the only identity a collection row has; anything
  // else (a blueprint, a listing id) would price the wrong card.
  const cardId = cardIdText(row?.cardId ?? row?.card_id);
  if (!cardId) return null;
  const item = {
    game: text(row?.game) || DEFAULT_ITEM_GAME,
    cardId,
    // The listing forms' own vocabulary, `PO` and all: NM/SP/MP/PL/Poor.
    condition: conditionText(row?.condition),
    language: languageText(row?.language),
    reverse: flag(row, 'reverse'),
    firstEdition: flag(row, 'firstEdition'),
    graded: flag(row, 'graded'),
    quantity: Math.min(Math.max(1, wholeNumber(row?.quantity, 1)), limits.quantity),
    name: text(row?.name),
    setName: text(row?.setName ?? row?.set_name),
    pricePkn: pricePknOf(row),
  };
  const id = itemIdOf(item);
  // `id` is the slice this row prices at and changes with every facet; `rowId`
  // is the row itself, minted when it entered the draft and kept through every
  // edit, so the form can hold a row open — and the focus in it — while the
  // slice under it changes.
  // `pricedId` is the slice the server last answered a price for, and is what
  // `pricePkn` is worth: nothing else. A row straight from the search, or one
  // whose facets have moved since that answer, carries a price for no slice.
  return { id, rowId: text(row?.rowId) || id, pricedId: text(row?.pricedId), ...item };
}

/** A row id of its own: no two rows in one draft are the same row. */
function uniqueRowId(items, wanted) {
  const used = new Set(items.map((row) => text(row?.rowId)));
  if (!used.has(wanted)) return wanted;
  let n = 2;
  while (used.has(`${wanted}#${n}`)) n += 1;
  return `${wanted}#${n}`;
}

function normalizeCollection(row, limits) {
  const id = text(row?.id);
  if (!id) return null;
  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(row?.items) ? row.items : []) {
    const answered = normalizeItem(raw, limits);
    if (!answered || seen.has(answered.id)) continue;
    // The answer is the only thing that prices a row, and it prices the exact
    // slice it names. Every edit the seller makes moves away from that slice.
    const item = { ...answered, pricedId: answered.id };
    seen.add(item.id);
    items.push(item);
  }
  return {
    id,
    name: text(row?.name),
    createdAt: text(row?.createdAt ?? row?.created_at),
    updatedAt: text(row?.updatedAt ?? row?.updated_at),
    items,
  };
}

/**
 * The raw answer as `{ limits, collections, model }`. `model` is a `{defs, days}`
 * the segment helpers accept, and it always carries one def per saved
 * collection — a list with no card yet still gets its row.
 *
 * `pricesUnavailable` is the answer's `seriesError: "prices_unavailable"`: the
 * seller's lists came back, the prices did not, and `days` is empty with it.
 * Since no day can count a list any more, each collection def carries its card
 * count itself (`held`), so the level still states how big each list is.
 */
export function normalizeCollections(data) {
  const limits = normalizeLimits(data?.limits);
  const collections = [];
  const seen = new Set();
  for (const row of Array.isArray(data?.collections) ? data.collections : []) {
    const collection = normalizeCollection(row, limits);
    if (!collection || seen.has(collection.id)) continue;
    seen.add(collection.id);
    collections.push(collection);
  }
  const pricesUnavailable = pricesUnavailableOf(data);
  let defs = normalizeSegmentDefs(data?.segmentDefs).filter((def) => def.group === COLLECTION_GROUP);
  const keys = new Set(defs.map((def) => def.key));
  for (const collection of collections) {
    const key = collectionKey(collection.id);
    if (!key || keys.has(key)) continue;
    keys.add(key);
    defs.push({ key, group: COLLECTION_GROUP, game: '', label: collection.name, years: undefined });
  }
  if (pricesUnavailable) {
    const counts = new Map();
    for (const collection of collections) {
      counts.set(collectionKey(collection.id), collection.items.reduce((sum, card) => sum + card.quantity, 0));
    }
    defs = defs.map((def) => (counts.has(def.key) ? { ...def, held: counts.get(def.key) } : def));
  }
  const normalized = normalizeSegments({ segmentDefs: defs, days: data?.days });
  return { limits, collections, pricesUnavailable, model: { defs, days: normalized?.days || [] } };
}

/** The one `seriesError` this desk knows: the lists are there, the prices are not. */
function pricesUnavailableOf(data) {
  return text(data?.seriesError ?? data?.series_error) === 'prices_unavailable';
}

/** The empty state: nothing saved, nothing answered, the server's own limits. */
export function emptyCollections(limits = DEFAULT_LIMITS) {
  return {
    limits: normalizeLimits(limits),
    collections: [],
    pricesUnavailable: false,
    model: { defs: [], days: [] },
  };
}

/** A card straight from the search, as the draft wants it: 1 copy, NM, EN. */
export function newItem(card, limits = DEFAULT_LIMITS) {
  return normalizeItem({
    game: card?.game,
    cardId: card?.cardId ?? card?.id,
    condition: card?.condition || DEFAULT_ITEM_CONDITION,
    language: card?.language || DEFAULT_ITEM_LANGUAGE,
    reverse: flag(card, 'reverse'),
    firstEdition: flag(card, 'firstEdition'),
    graded: flag(card, 'graded'),
    quantity: card?.quantity,
    name: card?.name,
    setName: card?.setName ?? card?.set,
    // Deliberately no price: what a search row carries is what somebody is
    // asking for the card, and only the server's answer prices a collection.
  }, normalizeLimits(limits));
}

/** The draft a form starts from: a saved collection's items, or an empty list. */
export function newDraft(collection = null) {
  const items = (Array.isArray(collection?.items) ? collection.items : []).map((item) => ({ ...item }));
  return { id: text(collection?.id), name: text(collection?.name), items };
}

function draftOf(draft) {
  return {
    id: text(draft?.id),
    name: text(draft?.name),
    items: (Array.isArray(draft?.items) ? draft.items : []).map((item) => ({ ...item })),
  };
}

function mergeRow(existing, incoming, limits) {
  // Both rows price the same slice — that is why they merge — so the price
  // belongs to whichever of them the server actually answered for it.
  const priced = existing.pricedId === existing.id ? existing : incoming;
  return {
    ...incoming,
    // The row that was already there is the one that survives, and with it the
    // identity the form holds its open field on.
    rowId: text(existing.rowId) || incoming.rowId,
    quantity: Math.min(existing.quantity + incoming.quantity, limits.quantity),
    pricedId: text(priced.pricedId),
    pricePkn: priced.pricePkn,
    name: incoming.name || existing.name,
    setName: incoming.setName || existing.setName,
  };
}

/**
 * Put an item in the draft. The same slice is one row: its quantity grows
 * (capped at the server's) instead of a second Charizard appearing. A new slice
 * past the item limit is refused — the draft comes back untouched.
 */
export function addItem(draft, item, limits = DEFAULT_LIMITS) {
  const clean = normalizeLimits(limits);
  const next = draftOf(draft);
  const row = normalizeItem(item, clean);
  if (!row) return next;
  const here = next.items.findIndex((entry) => entry.id === row.id);
  if (here >= 0) {
    next.items[here] = mergeRow(next.items[here], row, clean);
    return next;
  }
  if (next.items.length >= clean.items) return next;
  next.items.push({ ...row, rowId: uniqueRowId(next.items, row.rowId) });
  return next;
}

export function removeItem(draft, id) {
  const next = draftOf(draft);
  next.items = next.items.filter((item) => item.id !== String(id ?? ''));
  return next;
}

/**
 * Change one row, in its place. A facet change re-derives the slice, so a row
 * that lands on a slice already in the list merges into it rather than
 * doubling, and a free slice just moves.
 */
export function setItem(draft, id, patch = {}, limits = DEFAULT_LIMITS) {
  const clean = normalizeLimits(limits);
  const next = draftOf(draft);
  const index = next.items.findIndex((item) => item.id === String(id ?? ''));
  if (index < 0) return next;
  const row = normalizeItem({ ...next.items[index], ...patch }, clean);
  if (!row) return next;
  const clash = next.items.findIndex((item) => item.id === row.id);
  if (clash < 0 || clash === index) next.items[index] = row;
  else {
    next.items[clash] = mergeRow(next.items[clash], row, clean);
    next.items.splice(index, 1);
  }
  return next;
}

/**
 * What the copies field commits to when the seller leaves it: what they typed,
 * inside the server's range. An empty or unreadable field is not a change of
 * quantity — the row keeps what it had, which is also what the field then shows.
 */
export function commitQuantity(typed, previous, limits = DEFAULT_LIMITS) {
  const clean = normalizeLimits(limits);
  const raw = String(typed ?? '').trim();
  const was = Math.min(Math.max(1, wholeNumber(previous, 1)), clean.quantity);
  const n = Math.trunc(Number(raw));
  if (!raw || !Number.isFinite(n)) return was;
  return Math.min(Math.max(1, n), clean.quantity);
}

/**
 * The server's own name rule (`clean_text`), so what the seller keeps is what
 * the desk validated: a character stays when it is whitespace or not a control
 * character — a tab is a space, a BEL is nothing — then runs of whitespace
 * collapse to one space and the ends go. Length is counted in code points,
 * never UTF-16 units: an emoji is one character.
 */
export function cleanCollectionName(value) {
  const kept = [...String(value ?? '')]
    .filter((character) => /\s/.test(character) || !/[\p{Cc}]/u.test(character))
    .join('');
  return kept.trim().replace(/\s+/g, ' ');
}

/** The name's own problem, or '' when it is usable. Taken names ignore case. */
export function nameProblem(name, others = [], limits = DEFAULT_LIMITS) {
  const clean = cleanCollectionName(name);
  if (!clean) return 'A collection needs a name.';
  if (Array.from(clean).length > limits.name) return `The name is at most ${limits.name} characters.`;
  const taken = (Array.isArray(others) ? others : [])
    .map((row) => cleanCollectionName(typeof row === 'string' ? row : row?.name).toLowerCase())
    .filter(Boolean);
  if (taken.includes(clean.toLowerCase())) return 'You already have a collection with that name.';
  return '';
}

/** Every reason this draft cannot be saved, in the order the form shows them. */
export function draftErrors(draft, others = [], limits = DEFAULT_LIMITS) {
  const clean = normalizeLimits(limits);
  const errors = [];
  const name = nameProblem(draft?.name, others, clean);
  if (name) errors.push(name);
  const items = Array.isArray(draft?.items) ? draft.items : [];
  if (!text(draft?.id) && others.length >= clean.collections) {
    errors.push(`You can keep up to ${clean.collections} collections.`);
  }
  if (items.length > clean.items) errors.push(`A collection holds up to ${clean.items} cards.`);
  const seen = new Set();
  for (const item of items) {
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > clean.quantity) {
      errors.push(`Each card needs a quantity between 1 and ${clean.quantity}.`);
      break;
    }
    if (!cardIdText(item?.cardId)) {
      errors.push('Every card in the collection needs its card id.');
      break;
    }
    if (seen.has(item?.id)) {
      errors.push('The collection lists the same card twice.');
      break;
    }
    seen.add(item?.id);
  }
  if (!items.length) errors.push('Add at least one card.');
  return errors;
}

/**
 * The POST body: only the fields the server reads back — no client slice, row
 * or priced-slice id and no price, because the server resolves every price
 * itself, so one sent here would only be a claim about the market it never
 * asked for.
 * Each item is normalized first, so a draft assembled by hand sends the same
 * shape the server answers with — the facets included, a card without a public
 * id left out (the checks above name it before a save is ever asked). The name
 * is the cleaned one: the field holds what the seller is typing, the body
 * holds what the server keeps.
 */
export function saveBody(draft) {
  const clean = draftOf(draft);
  const body = {
    name: cleanCollectionName(clean.name),
    items: clean.items.reduce((acc, item) => {
      const row = normalizeItem(item, DEFAULT_LIMITS);
      if (!row) return acc;
      const { id, rowId, pricedId, pricePkn, ...fields } = row;
      acc.push(fields);
      return acc;
    }, []),
  };
  if (clean.id) body.id = clean.id;
  return body;
}

/**
 * What a request to leave the editor means, decided in one place so Escape,
 * Cancel, the × and the scrim cannot each invent their own rule about a draft.
 *
 * - `search` — Escape with a query in the field: that is the seller done with
 *   the results, not done with the list, so the field empties and nothing else
 *   happens.
 * - `close` — an unchanged draft has nothing to throw away.
 * - `ask` — the draft holds something the server has never seen: one question,
 *   inline, and nothing closes until it is answered.
 * - `stay` — the question is already on screen, so a second request answers it
 *   rather than asking twice.
 */
export function closeIntent({ key = '', search = '', dirty = false, asking = false } = {}) {
  if (key === 'Escape' && text(search)) return 'search';
  if (!dirty) return 'close';
  return asking ? 'stay' : 'ask';
}

/**
 * Whether the draft differs from the saved list it was opened from. The body it
 * would send is the comparison, so a name typed and typed back, or a copy count
 * edited to where it already stood, is not something the seller would lose.
 */
export function draftChanged(draft, saved = null) {
  return JSON.stringify(saveBody(draft)) !== JSON.stringify(saveBody(newDraft(saved)));
}

const ERROR_MESSAGES = {
  collection_name_required: 'A collection needs a name.',
  collection_item_invalid: 'One of the cards in this collection is not a card we know.',
  collection_not_found: 'That collection is not there any more.',
  collection_name_taken: 'You already have a collection with that name.',
  unauthorized: 'Sign in again to save your collections.',
};

/**
 * The sentence for one API error code, in plain words.
 *
 * A limit quoted in a sentence is the one the answer carried (`limits`),
 * because the server may raise it and tell the seller 20 anyway; the defaults
 * stand only for an answer that said nothing.
 *
 * A code this table does not know — the 400 of a body the desk never expected,
 * an `unknown_action`, a 500 — is one plain sentence, never the server's own
 * text and never a half-read field of it. Only the desk's words are shown, so
 * the seller sees the same line whatever the shape of the answer, and the draft
 * they typed stays where it is: this says only why the write did not go.
 */
export function collectionErrorMessage(code, { fallback = 'Could not save the collection.', limits = DEFAULT_LIMITS } = {}) {
  const clean = normalizeLimits(limits);
  // A code is data from the network: `toString` and `constructor` must not be
  // answered with whatever the prototype happens to hold.
  const key = text(code).toLowerCase();
  if (key === '401') return ERROR_MESSAGES.unauthorized;
  if (key === 'collection_limit') return `You can keep up to ${clean.collections} collections. Delete one first.`;
  if (key === 'collection_items_limit') return `A collection holds up to ${clean.items} cards.`;
  return Object.hasOwn(ERROR_MESSAGES, key) ? ERROR_MESSAGES[key] : fallback;
}

/**
 * The code of a thrown request: the body's `code`, else its status as text,
 * else nothing. A body that carries a human `error` sentence and no code is
 * read by its status, because the sentence is the server's and only the code is
 * something this desk knows how to answer.
 */
export function errorCode(error) {
  const code = text(error?.body?.code ?? error?.code);
  if (code) return code;
  const status = wholeNumber(error?.status, 0);
  return status ? String(status) : '';
}
