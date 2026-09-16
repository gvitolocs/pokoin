import { isSetDeskCard } from './search-filters.js';

/** Home Marketplace grid: random English (western) printings, 14 at a time. */

export const HOME_BROWSE_BLOCK = 14;
export const HOME_BROWSE_PAGE = 48;

export function isEnglishExpansion(row = {}) {
  return String(row.nationality || '').trim().toLowerCase() === 'western';
}

export function westernCatalogExpansions(expansions = []) {
  return (expansions || []).filter((row) => String(row?.slug || '').trim() && isEnglishExpansion(row));
}

export function shuffledCopy(items, random = Math.random) {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function cardId(card) {
  return String(card?.id || card?.card_id || '');
}

export function createEnglishBrowseState(expansions, random = Math.random) {
  return {
    queue: shuffledCopy(westernCatalogExpansions(expansions), random).map((row) => ({
      slug: row.slug,
      name: row.name || '',
      offset: 0,
      done: false,
    })),
    index: 0,
    buffer: [],
    seen: new Set(),
  };
}

export function browseHasMore(state) {
  if (!state) {
    return false;
  }
  if (state.buffer.length) {
    return true;
  }
  return state.queue.some((exp, index) => index >= state.index && !exp.done);
}

export async function fillEnglishBrowse(state, {
  fetchExpansionPage,
  size = HOME_BROWSE_BLOCK,
  random = Math.random,
} = {}) {
  const cards = [];
  let guard = 0;
  while (cards.length < size && guard < 32) {
    guard += 1;
    if (state.buffer.length) {
      cards.push(...state.buffer.splice(0, size - cards.length));
      continue;
    }
    const exp = state.queue[state.index];
    if (!exp) {
      break;
    }
    if (exp.done) {
      state.index += 1;
      continue;
    }
    const page = await fetchExpansionPage({
      slug: exp.slug,
      expansionName: exp.name,
      limit: HOME_BROWSE_PAGE,
      offset: exp.offset,
    });
    const incoming = page?.cards || [];
    const rows = shuffledCopy(incoming.filter((card) => {
      const id = cardId(card);
      if (!id || state.seen.has(id)) {
        return false;
      }
      const nationality = String(card.nationality || '').trim().toLowerCase();
      if (nationality === 'japanese' || nationality === 'chinese') {
        return false;
      }
      if (!isSetDeskCard(card)) {
        return false;
      }
      state.seen.add(id);
      return true;
    }), random);
    exp.offset += incoming.length;
    if (!page?.hasMore || !incoming.length) {
      exp.done = true;
      state.index += 1;
    }
    state.buffer.push(...rows);
  }
  return {
    cards,
    hasMore: browseHasMore(state),
  };
}
