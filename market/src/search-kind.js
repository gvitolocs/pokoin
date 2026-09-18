import { suggestKind } from './identity.js';

export const SEARCH_TABS = [
  { id: 'singles', label: 'Singles' },
  { id: 'jumbo', label: 'Jumbo' },
  { id: 'product', label: 'Product' },
  { id: 'users', label: 'Users' },
];

export function normalizeSearchTab(value) {
  const id = String(value || '').trim().toLowerCase();
  return SEARCH_TABS.some((tab) => tab.id === id) ? id : 'singles';
}

export function searchHref(query, tab = 'singles', resolved = '') {
  const params = new URLSearchParams();
  const q = String(query || '').trim();
  if (q) {
    params.set('q', q);
  }
  const kind = normalizeSearchTab(tab);
  if (kind !== 'singles') {
    params.set('tab', kind);
  }
  const meaning = String(resolved || '').trim();
  if (meaning) {
    params.set('resolved', meaning);
  }
  const search = params.toString();
  return search ? `/marketplace/search?${search}` : '/marketplace/search';
}

export function isSearchSingle(card = {}) {
  return suggestKind(card) === 'Singles';
}

export function printingMatchesSearchTab(card, tab) {
  const kind = normalizeSearchTab(tab);
  if (kind === 'users') {
    return false;
  }
  const jumbo = suggestKind(card) === 'Jumbo';
  if (kind === 'jumbo') {
    return jumbo;
  }
  const single = isSearchSingle(card);
  return kind === 'singles' ? single && !jumbo : !single && !jumbo;
}

export function searchFetchOptions(tab) {
  const kind = normalizeSearchTab(tab);
  if (kind === 'product') {
    return { productSearchOnly: true };
  }
  if (kind === 'jumbo') {
    return { productType: 'jumbo' };
  }
  if (kind === 'singles') {
    return { productType: 'card' };
  }
  return {};
}

export function uniqueSellers(listings, fallbackUsername = '') {
  const byId = new Map();
  const fallback = String(fallbackUsername || '').trim();
  for (const row of listings || []) {
    const username = String(
      row.sellerUsername || row.sellerName || row.sellerDisplayName || fallback,
    ).trim();
    const id = String(row.sellerUid || username);
    if (!id || !username) {
      continue;
    }
    const current = byId.get(id);
    if (current) {
      current.count += 1;
      continue;
    }
    byId.set(id, {
      id,
      username,
      name: String(row.sellerDisplayName || row.sellerName || username).trim() || username,
      count: 1,
    });
  }
  return [...byId.values()];
}
