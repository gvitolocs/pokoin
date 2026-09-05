/** Public home vector in sessionStorage. Recents stay out of this blob. */

const MAX_AGE_MS = 10 * 60 * 1000;

export function homeVectorCacheKey(gameId = 'pokemon') {
  return `pokoin.homeVector.${String(gameId || 'pokemon')}`;
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
