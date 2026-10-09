/** Public home vector in sessionStorage. Recents stay out of this blob. */

const MAX_AGE_MS = 10 * 60 * 1000;

export function homeVectorCacheKey(gameId = 'pokemon') {
  // v4 retires vectors cached before the native catalog identity guard.
  return `pokoin.homeVector.${String(gameId || 'pokemon')}.v4`;
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

/**
 * Coalesce the JSON.stringify of the whole home vector: keep only the latest
 * payload per game and serialize once when the main thread is idle. Listeners
 * flush on pagehide / hidden so a pending write is never lost on navigation.
 */
const PENDING_HOME_WRITES = new Map();
let flushHandle = null;
let flushIdle = false;
let flushListeners = false;

/** Idle-callback and timer ids are separate counters: cancel with the matching API. */
function cancelScheduledFlush() {
  if (flushHandle == null) return;
  if (flushIdle) window.cancelIdleCallback?.(flushHandle);
  else window.clearTimeout?.(flushHandle);
  flushHandle = null;
}

export function flushHomeVectorCacheWrites() {
  cancelScheduledFlush();
  for (const [gameId, entry] of PENDING_HOME_WRITES) {
    writeHomeVectorCache(gameId, entry.payload, entry.overrideStore);
  }
  PENDING_HOME_WRITES.clear();
}

export function scheduleHomeVectorCacheWrite(gameId, payload, overrideStore) {
  if (typeof window === 'undefined') {
    writeHomeVectorCache(gameId, payload, overrideStore);
    return;
  }
  PENDING_HOME_WRITES.set(gameId, { payload, overrideStore });
  if (!flushListeners) {
    flushListeners = true;
    window.addEventListener('pagehide', flushHomeVectorCacheWrites);
    window.addEventListener('visibilitychange', () => {
      if (document?.visibilityState === 'hidden') {
        flushHomeVectorCacheWrites();
      }
    });
  }
  if (flushHandle != null) {
    return;
  }
  flushIdle = typeof window.requestIdleCallback === 'function';
  flushHandle = flushIdle
    ? window.requestIdleCallback(flushHomeVectorCacheWrites, { timeout: 2000 })
    : window.setTimeout(flushHomeVectorCacheWrites, 500);
}
