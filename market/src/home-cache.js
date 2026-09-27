/** Public home vector in sessionStorage. Recents stay out of this blob. */

const MAX_AGE_MS = 10 * 60 * 1000;

export function homeVectorCacheKey(gameId = 'pokemon') {
  // v3: also stamp payload.game so a wrong-game vector cannot seed a satellite home.
  return `pokoin.homeVector.${String(gameId || 'pokemon')}.v3`;
}

function store(override) {
  if (override) {
    return override;
  }
  try {
    return globalThis.sessionStorage;
  } catch (_) {
    return null;
  }
}

export function stripHomePersonalization(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const sections = { ...(payload.sections || {}) };
  delete sections.recentlySeenIds;
  const { missingRecentIds: _drop, ...rest } = payload;
  return { ...rest, sections };
}

/** Drop a cached Pokemon rails vector that was stored under a satellite game id. */
export function homePayloadMatchesGame(payload, gameId = 'pokemon') {
  if (!payload || typeof payload !== 'object') return false;
  const want = String(gameId || 'pokemon').toLowerCase().replace(/-/g, '_');
  const got = String(payload.game || '').toLowerCase().replace(/-/g, '_');
  if (!got) {
    // Pokemon Worker rails often omit game; only accept that on the Pokemon storefront.
    return want === 'pokemon';
  }
  if (want === 'pokemon') {
    return got === 'pokemon' || got === 'poke' || got === 'default';
  }
  return got === want;
}

export function readHomeVectorCache(gameId = 'pokemon', overrideStore) {
  const storage = store(overrideStore);
  if (!storage?.getItem) {
    return null;
  }
  try {
    const parsed = JSON.parse(storage.getItem(homeVectorCacheKey(gameId)) || 'null');
    if (!parsed?.payload?.cards?.length) {
      return null;
    }
    if (!homePayloadMatchesGame(parsed.payload, gameId)) {
      return null;
    }
    const savedAt = Number(parsed.savedAt || 0);
    if (savedAt && Date.now() - savedAt > MAX_AGE_MS) {
      return null;
    }
    return stripHomePersonalization(parsed.payload);
  } catch (_) {
    return null;
  }
}

export function writeHomeVectorCache(gameId, payload, overrideStore) {
  const storage = store(overrideStore);
  if (!storage?.setItem || !payload?.cards?.length) {
    return;
  }
  if (!homePayloadMatchesGame(payload, gameId)) {
    return;
  }
  try {
    storage.setItem(
      homeVectorCacheKey(gameId),
      JSON.stringify({
        savedAt: Date.now(),
        payload: stripHomePersonalization(payload),
      }),
    );
  } catch (_) {
    /* quota / private mode */
  }
}
