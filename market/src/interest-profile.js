/**
 * PIPELINE BLOCK: personal search predictions (SPA)
 * -------------------------------------------------
 * What this visitor looks at, kept on their own device, shapes what the
 * search bar offers them:
 *
 *   - one or two typed letters open the popup on the name (or expansion) they
 *     have been viewing: ten Lugia desks yesterday, and `l` offers Lugia;
 *   - among names that all start with what was typed, the ones they view
 *     come first, never above an exact match;
 *   - within a name, printings from the era they collect come first: Base
 *     Set for a vintage collector, Scarlet & Violet for a player;
 *   - the print chip filters all of it: with Western print on, views of
 *     Japanese printings and expansions predict nothing.
 *
 * The profile is a short list of card views in localStorage (name,
 * expansion, print, day). It is never sent anywhere. Names fade in days,
 * eras and expansions in weeks.
 *
 * Revert: stop calling predictInterest / personalizeGroups in SearchBox.jsx
 * and noteCardView in Card.jsx; the ranking underneath is untouched.
 */

export const INTEREST_MAX = 300;
/** A name viewed three days ago counts half. */
export const NAME_HALF_LIFE_DAYS = 3;
/** Taste in eras and expansions moves slowly. */
export const TASTE_HALF_LIFE_DAYS = 30;
/** About two views today before a single letter predicts a name. */
export const PREDICT_MIN_SCORE = 1.5;
/** Views needed before an era reorders printings, and the share it must hold. */
export const ERA_MIN_VIEWS = 5;
export const ERA_MIN_SHARE = 0.4;

const DAY_MS = 86400000;
const KEY = 'pokoin.interest.v1';

/** Trailing mechanic words that are not the creature: Lugia V, Lugia ex, Lugia VSTAR are all Lugia. */
const TRAILING = new Set([
  'ex', 'gx', 'v', 'vmax', 'vstar', 'vunion', 'break', 'legend', 'prime', 'star', 'lv.x', 'δ',
]);
const LEADING = new Set(['m', 'mega', 'radiant', 'shining', 'dark', 'light']);

export function compactKey(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The name a visitor means by any of its printings. Trainers and items come back unchanged. */
export function nameStem(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && TRAILING.has(words[words.length - 1].toLowerCase())) words.pop();
  while (words.length > 1 && LEADING.has(words[0].toLowerCase())) words.shift();
  return words.join(' ');
}

/** Korean printings sit with Japanese ones under the Japanese chip (locale.js). */
export function printFamily(print) {
  const value = String(print || '').trim().toLowerCase();
  if (value === 'korean') return 'japanese';
  if (value === 'all' || value === 'any') return '';
  return value;
}

export function interestKey(gameId = 'pokemon') {
  return `${KEY}:${String(gameId || 'pokemon')}`;
}

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** `[{ d, id, n, s, p }]`, oldest first: day number, card id, name, expansion, print. */
export function readInterestEvents(gameId = 'pokemon', store = storage()) {
  try {
    const parsed = JSON.parse(store?.getItem(interestKey(gameId)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => row && Number.isFinite(row.d) && typeof row.n === 'string' && row.n);
  } catch {
    return [];
  }
}

/**
 * Note one card desk view. The same card on the same day counts once, so a
 * refresh is not ten views. Returns the stored list.
 */
export function noteCardView(card, { gameId = 'pokemon', now = Date.now(), store = storage(), print = '' } = {}) {
  const name = String(card?.name || '').trim();
  const id = String(card?.id || card?.card_id || card?.cardId || '').trim();
  if (!name || !id || !store) return readInterestEvents(gameId, store);
  const day = Math.floor(now / DAY_MS);
  const events = readInterestEvents(gameId, store);
  if (events.some((row) => row.d === day && row.id === id)) return events;
  events.push({
    d: day,
    id,
    n: name.slice(0, 80),
    s: String(card?.set || card?.set_name || card?.expansion || '').trim().slice(0, 80),
    p: printFamily(print || card?.nationality),
  });
  const kept = events.slice(-INTEREST_MAX);
  try {
    store.setItem(interestKey(gameId), JSON.stringify(kept));
  } catch {
    /* storage full or blocked: the profile is a convenience */
  }
  return kept;
}

const decay = (ageDays, halfLife) => 0.5 ** (Math.max(0, ageDays) / halfLife);

function add(map, key, display, amount) {
  if (!key) return;
  const row = map.get(key);
  if (row) row.score += amount;
  else map.set(key, { display, score: amount });
}

/**
 * Scores from the views that fit the print chip. `eraOf(setTitle)` names an
 * expansion's era (tcg-eras.js matchTcgEra); without it there is no era taste.
 */
export function buildInterestProfile(events, { now = Date.now(), print = 'all', eraOf = null } = {}) {
  const today = Math.floor(now / DAY_MS);
  const family = printFamily(print);
  const names = new Map();
  const sets = new Map();
  const eras = new Map();
  let views = 0;
  let eraViews = 0;
  for (const row of Array.isArray(events) ? events : []) {
    // An unknown print counts under every chip; a known one only under its own.
    if (family && row.p && row.p !== family) continue;
    const age = today - row.d;
    views += 1;
    const stem = nameStem(row.n);
    add(names, compactKey(stem), stem, decay(age, NAME_HALF_LIFE_DAYS));
    if (row.s) {
      const taste = decay(age, TASTE_HALF_LIFE_DAYS);
      add(sets, compactKey(row.s), row.s, taste);
      const era = eraOf ? String(eraOf(row.s) || '') : '';
      if (era) {
        add(eras, era, era, taste);
        eraViews += 1;
      }
    }
  }
  return { names, sets, eras, views, eraViews };
}

/**
 * What one or two typed letters most likely mean for this visitor: the name
 * or expansion they have been viewing that starts with them. `null` when
 * nothing they viewed does, or not often enough.
 */
export function predictInterest(typed, profile) {
  const prefix = compactKey(typed);
  if (!prefix || !profile) return null;
  let best = null;
  const consider = (map, kind, minimum) => {
    for (const [key, row] of map) {
      if (!key.startsWith(prefix) || key === prefix || row.score < minimum) continue;
      if (!best || row.score > best.score) best = { text: row.display, kind, score: row.score };
    }
  };
  consider(profile.names, 'name', PREDICT_MIN_SCORE);
  // An expansion must be clearly a habit before a letter means it.
  consider(profile.sets, 'set', PREDICT_MIN_SCORE * 2);
  return best;
}

/** The eras this visitor mostly views, when there is enough to say so. */
export function preferredEras(profile) {
  if (!profile || profile.eraViews < ERA_MIN_VIEWS) return new Set();
  let total = 0;
  for (const row of profile.eras.values()) total += row.score;
  const out = new Set();
  if (total <= 0) return out;
  for (const [era, row] of profile.eras) {
    if (row.score / total >= ERA_MIN_SHARE) out.add(era);
  }
  return out;
}

const setOf = (printing) => String(
  printing?.set || printing?.set_name || printing?.card?.set || printing?.card?.set_name || '',
);

/**
 * The popup's groups in this visitor's order. Only two moves, both stable:
 *
 *   - groups at the top whose names all start with what was typed are sorted
 *     by how much the visitor views that name; an exact match never moves;
 *   - inside those groups, printings from the visitor's eras come first.
 *
 * A query that names a number, an expansion or a rarity matches none of
 * those groups by prefix and is returned as it came.
 */
export function personalizeGroups(groups, typed, profile, { eraOf = null, limit = 0 } = {}) {
  const list = trimGroups(orderGroups(groups, typed, profile, eraOf), limit);
  return list;
}

/** At most `limit` printings in all, in order; a group left empty is dropped. */
function trimGroups(groups, limit) {
  if (!limit) return groups;
  let room = limit;
  let cut = false;
  const out = [];
  for (const group of groups) {
    const printings = Array.isArray(group.printings) ? group.printings : [];
    if (room <= 0) {
      cut = true;
      continue;
    }
    if (printings.length <= room) {
      out.push(group);
      room -= printings.length;
    } else {
      out.push({ ...group, printings: printings.slice(0, room) });
      room = 0;
      cut = true;
    }
  }
  return cut ? out : groups;
}

function orderGroups(groups, typed, profile, eraOf) {
  const list = Array.isArray(groups) ? groups : [];
  const prefix = compactKey(typed);
  if (!list.length || !prefix || !profile || !profile.views) return list;
  let run = 0;
  while (run < list.length && compactKey(list[run]?.name).startsWith(prefix)) run += 1;
  if (!run) return list;
  const eras = eraOf ? preferredEras(profile) : new Set();
  const affinity = (group) => {
    const name = compactKey(group.name);
    if (name === prefix) return Infinity;
    const stem = compactKey(nameStem(group.name));
    return profile.names.get(stem)?.score || 0;
  };
  let changed = false;
  const head = list.slice(0, run).map((group, index) => {
    let next = group;
    if (eras.size && Array.isArray(group.printings) && group.printings.length > 1) {
      const mine = [];
      const rest = [];
      for (const printing of group.printings) {
        (eras.has(String(eraOf(setOf(printing)) || '')) ? mine : rest).push(printing);
      }
      if (mine.length && rest.length && group.printings[0] !== mine[0]) {
        next = { ...group, printings: [...mine, ...rest] };
        changed = true;
      } else if (mine.length && rest.length) {
        const merged = [...mine, ...rest];
        if (merged.some((printing, at) => printing !== group.printings[at])) {
          next = { ...group, printings: merged };
          changed = true;
        }
      }
    }
    return { group: next, index, score: affinity(group) };
  });
  const sorted = head.slice().sort((a, b) => (b.score - a.score) || (a.index - b.index));
  if (sorted.some((row, at) => row.index !== at)) changed = true;
  if (!changed) return list;
  return [...sorted.map((row) => row.group), ...list.slice(run)];
}

/** How many printings to rank before the visitor's eras choose twenty of them. */
export const ERA_POOL = 60;

/**
 * The popup for this visitor. `paint(limit)` is the ranking as it is
 * (suggest-live.js paintCatalogGroups). The popup shows twenty printings, so
 * an era the visitor collects could only reorder those twenty: for a plain
 * name query it ranks a wider pool, puts the visitor's eras first and keeps
 * twenty. Any other query, and any visitor without an era, gets the ranking's
 * own twenty with only the viewed-name order applied.
 */
export function personalPopup(paint, typed, profile, { eraOf = null, limit = 20, pool = ERA_POOL } = {}) {
  const groups = paint(limit);
  if (!profile || !profile.views || !Array.isArray(groups) || !groups.length) return groups;
  const prefix = compactKey(typed);
  const plainName = prefix && compactKey(groups[0]?.name).startsWith(prefix);
  if (plainName && eraOf && preferredEras(profile).size) {
    const wide = paint(pool);
    if (Array.isArray(wide) && wide.length) return personalizeGroups(wide, typed, profile, { eraOf, limit });
  }
  return personalizeGroups(groups, typed, profile, { eraOf });
}
