/** localStorage cache for Dashboard Portfolio metric tiles.
 *
 * Paint cached totals on first paint, then refresh from the collection summary
 * and live listings APIs. Each successful fetch merges into the cache so the
 * next visit skips the skeleton.
 */

export const PORTFOLIO_TILES_CACHE_PREFIX = 'pokoin.portfolioTiles.v1';

function localStore() {
  try {
    const local = globalThis.localStorage;
    if (local && typeof local.getItem === 'function') {
      return local;
    }
  } catch {
    /* private mode */
  }
  return null;
}

export function portfolioTilesCacheKey(uid) {
  const id = String(uid || '').trim();
  return id ? `${PORTFOLIO_TILES_CACHE_PREFIX}:${id}` : '';
}

function asNonNegInt(value) {
  const n = Math.max(0, Number(value) || 0);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

export function normalizeListedSummary(listed) {
  if (!listed || typeof listed !== 'object') return null;
  if (listed.failed) {
    return { listings: 0, cards: 0, listedPkn: 0, failed: true };
  }
  return {
    listings: asNonNegInt(listed.listings),
    cards: asNonNegInt(listed.cards),
    listedPkn: asNonNegInt(listed.listedPkn),
  };
}

/** Compact tile payload from collection-summary + inventory summarize. */
export function normalizePortfolioTiles(partial = {}) {
  const tiles = {
    ownedCards: asNonNegInt(partial.ownedCards ?? partial.cardsOwned),
    physicalOwned: asNonNegInt(partial.physicalOwned ?? partial.physicalItems),
    nftOwned: asNonNegInt(partial.nftOwned ?? partial.nftItems),
    uniqueItems: asNonNegInt(partial.uniqueItems ?? partial.items),
  };
  if (Object.prototype.hasOwnProperty.call(partial, 'listed')) {
    tiles.listed = normalizeListedSummary(partial.listed);
  } else {
    tiles.listed = null;
  }
  return tiles;
}

/** Collection-summary fields only — omit `listed` so merges keep the inventory tile. */
export function portfolioTilesFromSummary(data) {
  return {
    ownedCards: asNonNegInt(data?.cardsOwned),
    physicalOwned: asNonNegInt(data?.physicalOwned ?? data?.physicalItems),
    nftOwned: asNonNegInt(data?.nftOwned ?? data?.nftItems),
    uniqueItems: asNonNegInt(data?.items),
  };
}

/** Stable signature so an unchanged refresh does not thrash setState. */
export function portfolioTilesFingerprint(tiles) {
  const ownedCards = asNonNegInt(tiles?.ownedCards);
  const physicalOwned = asNonNegInt(tiles?.physicalOwned);
  const nftOwned = asNonNegInt(tiles?.nftOwned);
  const uniqueItems = asNonNegInt(tiles?.uniqueItems);
  const listed = normalizeListedSummary(tiles?.listed) || {
    listings: 0,
    cards: 0,
    listedPkn: 0,
    failed: false,
  };
  return [
    ownedCards,
    physicalOwned,
    nftOwned,
    uniqueItems,
    listed.failed ? 'fail' : 'ok',
    listed.listings,
    listed.cards,
    listed.listedPkn,
  ].join('\t');
}

export function readPortfolioTilesCache(uid) {
  const key = portfolioTilesCacheKey(uid);
  if (!key) return null;
  const store = localStore();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const tiles = normalizePortfolioTiles({
      ...parsed,
      listed: Object.prototype.hasOwnProperty.call(parsed, 'listed') ? parsed.listed : null,
    });
    return {
      ...tiles,
      fetchedAt: Number(parsed.fetchedAt) || 0,
      fingerprint: String(parsed.fingerprint || portfolioTilesFingerprint(tiles)),
    };
  } catch {
    return null;
  }
}

/** Merge a patch onto the cached tiles and persist. Returns the merged entry. */
export function writePortfolioTilesCache(uid, patch = {}) {
  const key = portfolioTilesCacheKey(uid);
  if (!key) return null;
  const store = localStore();
  if (!store) return null;
  const prev = readPortfolioTilesCache(uid) || {
    ownedCards: 0,
    physicalOwned: 0,
    nftOwned: 0,
    uniqueItems: 0,
    listed: null,
  };
  const next = {
    ownedCards: Object.prototype.hasOwnProperty.call(patch, 'ownedCards')
      || Object.prototype.hasOwnProperty.call(patch, 'cardsOwned')
      ? asNonNegInt(patch.ownedCards ?? patch.cardsOwned)
      : prev.ownedCards,
    physicalOwned: Object.prototype.hasOwnProperty.call(patch, 'physicalOwned')
      || Object.prototype.hasOwnProperty.call(patch, 'physicalItems')
      ? asNonNegInt(patch.physicalOwned ?? patch.physicalItems)
      : prev.physicalOwned,
    nftOwned: Object.prototype.hasOwnProperty.call(patch, 'nftOwned')
      || Object.prototype.hasOwnProperty.call(patch, 'nftItems')
      ? asNonNegInt(patch.nftOwned ?? patch.nftItems)
      : prev.nftOwned,
    uniqueItems: Object.prototype.hasOwnProperty.call(patch, 'uniqueItems')
      || Object.prototype.hasOwnProperty.call(patch, 'items')
      ? asNonNegInt(patch.uniqueItems ?? patch.items)
      : prev.uniqueItems,
    listed: Object.prototype.hasOwnProperty.call(patch, 'listed')
      ? normalizeListedSummary(patch.listed)
      : prev.listed,
  };
  const entry = {
    ...next,
    fetchedAt: Date.now(),
    fingerprint: portfolioTilesFingerprint(next),
  };
  const payload = JSON.stringify(entry);
  try {
    store.setItem(key, payload);
    return entry;
  } catch {
    try {
      store.removeItem(key);
      store.setItem(key, payload);
      return entry;
    } catch {
      return null;
    }
  }
}
