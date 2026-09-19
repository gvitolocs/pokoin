/** localStorage cache for the /wallet Activity feed.
 *
 * Paint cached rows on first paint, then refresh in the background. A short
 * TTL skips the network when the user revisits within the same minute; a
 * fingerprint skips setState when nothing changed.
 */

export const ACTIVITY_CACHE_PREFIX = 'pokoin.walletActivity.v1';
/** Fresh enough to skip a network round-trip on remount. */
export const ACTIVITY_CACHE_TTL_MS = 45_000;
/** Keep a little headroom past the desk query limit. */
export const ACTIVITY_CACHE_MAX = 80;

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

export function activityCacheStorageKey(uid, address = '') {
  const id = String(uid || '').trim();
  const addr = String(address || '').trim().toLowerCase();
  return `${ACTIVITY_CACHE_PREFIX}:${id}:${addr || 'site'}`;
}

export function serializeActivityRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).slice(0, ACTIVITY_CACHE_MAX).map((row) => ({
    key: String(row.key || ''),
    title: String(row.title || ''),
    detail: String(row.detail || ''),
    kind: row.kind === 'inbound' ? 'inbound' : 'outbound',
    amountPkn: row.amountPkn == null ? null : Number(row.amountPkn),
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at || ''),
    blockLabel: row.blockLabel ? String(row.blockLabel) : undefined,
  }));
}

export function reviveActivityRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const at = new Date(row.at);
    return {
      key: String(row.key || ''),
      title: String(row.title || ''),
      detail: String(row.detail || ''),
      kind: row.kind === 'inbound' ? 'inbound' : 'outbound',
      amountPkn: row.amountPkn == null || Number.isNaN(Number(row.amountPkn))
        ? null
        : Number(row.amountPkn),
      at: Number.isNaN(at.getTime()) ? new Date(0) : at,
      ...(row.blockLabel ? { blockLabel: String(row.blockLabel) } : {}),
    };
  });
}

/** Stable signature so an unchanged feed does not re-render the list. */
export function activityFingerprint(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const at = row.at instanceof Date ? row.at.toISOString() : String(row.at || '');
      return `${row.key}\t${at}\t${row.amountPkn ?? ''}\t${row.title || ''}`;
    })
    .join('\n');
}

export function readActivityCache(uid, address = '') {
  const id = String(uid || '').trim();
  if (!id) return null;
  const store = localStore();
  if (!store) return null;
  try {
    const raw = store.getItem(activityCacheStorageKey(id, address));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.rows)) return null;
    const fetchedAt = Number(parsed.fetchedAt) || 0;
    return {
      rows: reviveActivityRows(parsed.rows),
      fetchedAt,
      fingerprint: String(parsed.fingerprint || activityFingerprint(parsed.rows)),
    };
  } catch {
    return null;
  }
}

export function writeActivityCache(uid, address, rows) {
  const id = String(uid || '').trim();
  if (!id) return false;
  const store = localStore();
  if (!store) return false;
  const serialized = serializeActivityRows(rows);
  const payload = JSON.stringify({
    fetchedAt: Date.now(),
    fingerprint: activityFingerprint(serialized),
    rows: serialized,
  });
  try {
    store.setItem(activityCacheStorageKey(id, address), payload);
    return true;
  } catch {
    try {
      store.removeItem(activityCacheStorageKey(id, address));
      store.setItem(activityCacheStorageKey(id, address), payload);
      return true;
    } catch {
      return false;
    }
  }
}

export function activityCacheIsFresh(entry, { now = Date.now(), ttlMs = ACTIVITY_CACHE_TTL_MS } = {}) {
  if (!entry || !Array.isArray(entry.rows) || !entry.rows.length) return false;
  return now - Number(entry.fetchedAt || 0) < ttlMs;
}

/** Newest timestamp in the feed (ms), or 0 when empty. */
export function activityNewestMs(rows = []) {
  let newest = 0;
  for (const row of rows || []) {
    const t = row?.at instanceof Date ? row.at.getTime() : new Date(row?.at || 0).getTime();
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return newest;
}

/** Keep rows newer than `sinceMs`, for merging a delta onto a cached feed. */
export function activityRowsSince(rows = [], sinceMs = 0) {
  if (!(sinceMs > 0)) return Array.isArray(rows) ? [...rows] : [];
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const t = row?.at instanceof Date ? row.at.getTime() : new Date(row?.at || 0).getTime();
    return Number.isFinite(t) && t > sinceMs;
  });
}
