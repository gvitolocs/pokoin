import { tilePricePkn } from './pkn.js';
import {
  collectorSortValue,
  compareSetDeskNumber,
  expansionBlob,
  isSetDeskCard,
  searchPrintLang,
  searchRarity,
} from './search-filters.js';
import { assignOfficialIndexes, officialListFor } from './set-official-lists.js';

/**
 * Set desk filter and sort (both UIs). Its own module so the printed set
 * checklists (set-official-lists.js) load with the set desk, not with every
 * page that ranks search results.
 */

function cardId(card) {
  return String(card?.id || card?.card_id || '');
}

export function cardIsReverse(card) {
  return /\breverse\b/.test(expansionBlob(card));
}

export function cardIsFirstEdition(card) {
  return /\b(?:1st|first)\s*ed/.test(expansionBlob(card));
}

export function filterExpansionCards(cards, {
  query = '',
  sort = 'number',
  rarity = '',
  language = '',
  fallbackLang = '',
  reverse = 'any',
  firstEdition = 'any',
  listed = 'any',
  expansionSlug = '',
  expansionName = '',
} = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = (cards || []).filter(isSetDeskCard);
  if (needle) {
    rows = rows.filter((card) => expansionBlob(card).includes(needle));
  }
  if (rarity) {
    rows = rows.filter((card) => searchRarity(card) === rarity);
  }
  if (language) {
    rows = rows.filter((card) => (searchPrintLang(card) || fallbackLang) === language);
  }
  if (reverse === 'yes') {
    rows = rows.filter((card) => cardIsReverse(card));
  } else if (reverse === 'no') {
    rows = rows.filter((card) => !cardIsReverse(card));
  }
  if (firstEdition === 'yes') {
    rows = rows.filter((card) => cardIsFirstEdition(card));
  } else if (firstEdition === 'no') {
    rows = rows.filter((card) => !cardIsFirstEdition(card));
  }
  if (listed === 'yes') {
    rows = rows.filter((card) => (tilePricePkn(card) || 0) > 0 || card.isMarketAvailable || card.inStock);
  } else if (listed === 'no') {
    rows = rows.filter((card) => !((tilePricePkn(card) || 0) > 0 || card.isMarketAvailable || card.inStock));
  }
  if (sort === 'price-asc') {
    rows.sort((a, b) => (tilePricePkn(a) || Infinity) - (tilePricePkn(b) || Infinity));
  } else if (sort === 'price-desc') {
    rows.sort((a, b) => (tilePricePkn(b) || 0) - (tilePricePkn(a) || 0));
  } else if (sort === 'name') {
    rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))
      || collectorSortValue(a) - collectorSortValue(b));
  } else if (sort === 'official') {
    const list = officialListFor(expansionSlug, expansionName);
    const indexes = assignOfficialIndexes(rows, list);
    rows = rows.filter((card) => indexes.has(cardId(card)));
    rows.sort((a, b) => {
      const ia = indexes.get(cardId(a));
      const ib = indexes.get(cardId(b));
      return ia - ib
        || collectorSortValue(a) - collectorSortValue(b)
        || String(a.name || '').localeCompare(String(b.name || ''));
    });
  } else {
    rows.sort(compareSetDeskNumber);
  }
  return rows;
}
