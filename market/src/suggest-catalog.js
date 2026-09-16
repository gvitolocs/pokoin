/**
 * Local typeahead catalog: 10k names plus 400 artists and 800 sets.
 * Same typo emission as NAME_POOL. Meili still hydrates name printings;
 * artist/set hits hydrate from those APIs. Do not Meili-slice the first
 * character down to 20 rows.
 */

import RAW_ARTISTS from './data/suggest-artists.js';
import RAW_SETS from './data/suggest-sets.js';
import { compactQuery, isSetAwareQuery, isSetOnlyQuery, nameRow, parseTypedQuery, rankNames } from './suggest-rank.js';

function catalogRow(row, kind, compact) {
  return {
    ...nameRow(row.display, row.prior),
    ...(compact ? { compact: compactQuery(compact) } : {}),
    slug: row.slug,
    kind,
    nationality: String(row.nationality || '').trim().toLowerCase(),
  };
}

function artistPool() {
  const rows = [];
  const seen = new Set();
  function add(row, compact) {
    const next = catalogRow(row, 'artist', compact);
    if (!next.compact || seen.has(`${next.slug}:${next.compact}`)) {
      return;
    }
    seen.add(`${next.slug}:${next.compact}`);
    rows.push(next);
  }
  for (const row of RAW_ARTISTS) {
    add(row);
    const parts = String(row.display || '').split(/\s+/).filter(Boolean);
    const last = parts[parts.length - 1] || '';
    if (parts.length > 1 && compactQuery(last).length >= 5) {
      add(row, last);
    }
  }
  return rows;
}

export const ARTIST_POOL = artistPool();
export const SET_POOL = RAW_SETS.map((row) => catalogRow(row, 'set'));
const SET_BY_COMPACT = new Map(SET_POOL.map((row) => [row.compact, row]));

export function expansionNationality(setName) {
  const compact = compactQuery(setName);
  if (!compact) {
    return '';
  }
  return String(SET_BY_COMPACT.get(compact)?.nationality || '').trim();
}

function prefixHit(row, compact) {
  return Boolean(row?.compact && compact && (
    row.compact.startsWith(compact) || compact.startsWith(row.compact)
  ));
}

function setRowFromParsed(parsed) {
  const token = parsed?.setTokens?.[0] || {};
  const names = token.setNames || [];
  const compact = token.compact || '';
  if (compact) {
    const exact = SET_POOL.find((row) => row.compact === compact);
    if (exact) {
      return exact;
    }
    const prefix = SET_POOL.find((row) => row.compact.startsWith(compact));
    if (prefix) {
      return prefix;
    }
  }
  if (token.slug) {
    const bySlug = SET_POOL.find((row) => row.slug === token.slug);
    if (bySlug) {
      return bySlug;
    }
  }
  for (const name of names) {
    const nameCompact = compactQuery(name);
    const byName = SET_POOL.find((row) => row.compact === nameCompact);
    if (byName) {
      return byName;
    }
  }
  return null;
}

/**
 * Names win when the query is still a card prefix. An exact artist/set
 * compact (komiya, ultraprism) takes over. A bare expansion-title token
 * (`expedition`) is the set, not a longer card name (Expedition Uniform).
 * Typos stay on rankNames. Card+set queries (`flareon call of legendsd`)
 * rank the peeled name only.
 */
const INTENT_MEMO_MAX = 24;
const intentMemo = new Map();

export function catalogIntent(query) {
  const raw = String(query || '');
  const memoKey = compactQuery(raw);
  if (memoKey && intentMemo.has(memoKey)) {
    return intentMemo.get(memoKey);
  }
  const parsed = parseTypedQuery(raw);
  const setOnly = isSetOnlyQuery(parsed);
  const setAware = isSetAwareQuery(parsed);
  const rankQuery = setAware ? parsed.nameQuery : raw;
  const names = setOnly ? [] : rankNames(rankQuery);
  const compact = compactQuery(setAware ? rankQuery : raw);
  let result;
  if (setOnly) {
    const set = setRowFromParsed(parsed);
    result = {
      kind: 'set',
      ranked: set ? [set] : [],
      display: set?.display || parsed.setTokens[0]?.setNames?.[0] || raw,
      slug: set?.slug || parsed.setTokens[0]?.slug || '',
      compact: set?.compact || compact,
      prior: set?.prior || 0,
    };
  } else if (setAware) {
    result = { kind: 'name', ranked: names, ...(names[0] || {}) };
  } else {
    const artists = compact ? rankNames(raw, ARTIST_POOL, { fill: 12 }) : [];
    const sets = compact ? rankNames(raw, SET_POOL, { fill: 12 }) : [];
    const name = names[0] || null;
    const artist = artists[0] || null;
    const set = sets[0] || null;
    if (artist && artist.compact === compact) {
      result = { kind: 'artist', ranked: artists, ...artist };
    } else if (set && set.compact === compact) {
      result = { kind: 'set', ranked: sets, ...set };
    } else if (artist && prefixHit(artist, compact) && !prefixHit(name, compact)) {
      result = { kind: 'artist', ranked: artists, ...artist };
    } else if (set && compact.length >= 5 && prefixHit(set, compact) && !prefixHit(name, compact)) {
      result = { kind: 'set', ranked: sets, ...set };
    } else {
      result = { kind: 'name', ranked: names, ...name };
    }
  }
  if (memoKey) {
    intentMemo.set(memoKey, result);
    if (intentMemo.size > INTENT_MEMO_MAX) {
      intentMemo.delete(intentMemo.keys().next().value);
    }
  }
  return result;
}

export function groupsFromCards(cards) {
  const groups = [];
  const byName = new Map();
  for (const card of cards || []) {
    const name = String(card?.name || '').trim();
    const id = String(card?.id || card?.card_id || '').trim();
    if (!name || !id) {
      continue;
    }
    let group = byName.get(name);
    if (!group) {
      group = { name, printings: [] };
      byName.set(name, group);
      groups.push(group);
    }
    if (group.printings.some((row) => String(row.id || row.card_id) === id)) {
      continue;
    }
    group.printings.push(card);
  }
  return groups;
}

export function catalogCacheKey(intent) {
  if (intent?.kind === 'artist' && intent.slug) {
    return `artist:${intent.slug}`;
  }
  if (intent?.kind === 'set' && intent.slug) {
    return `set:${intent.slug}`;
  }
  return '';
}
