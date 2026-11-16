/** Account-scoped session cache. Stale values can paint while callers revalidate. */
export function createTabCache(maxAge = 30_000, now = Date.now) {
  const entries = new Map();
  return {
    get(uid) { return uid ? entries.get(uid)?.value : undefined; },
    fresh(uid) { const entry = uid && entries.get(uid); return Boolean(entry && now() - entry.savedAt < maxAge); },
    set(uid, value) { if (uid) entries.set(uid, { value, savedAt: now() }); },
    delete(uid) { entries.delete(uid); },
  };
}
