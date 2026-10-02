'use strict';

/**
 * Shared rate limiting with two explicit classes. The call site chooses the
 * semantics; a future route must never reach for the fail-open limiter by
 * accident on a money or security path.
 *
 * - limitBestEffort: comfort throttling for expensive-but-harmless routes
 *   (chat, assistants, image logging, AI classification). Atomic Valkey
 *   counter shared by every API instance (Pi + k3s overflow pods). If Valkey
 *   is unavailable it degrades to a bounded in-process fixed window on the
 *   local instance — availability over precision. FAIL-OPEN by design.
 *
 * - limitSecurityCritical: durable fail-closed fixed window in Postgres
 *   (public.marketplace_rate_limits, same shape as scan_rate_limits) for
 *   brute-force, payment, and paid-external-API paths. There is deliberately
 *   NO local fallback: if the durable store cannot answer, the request is
 *   rejected, because a per-instance memory limit would silently multiply
 *   across overflow pods and an unavailable store must not look like consent.
 *
 * Keys: rl:{scope}:{sha256(identity)[0:32]} — identities (IP, uid) are hashed
 * so raw credentials/PII never appear in Valkey keys or Postgres buckets.
 * Values: fixed-window counters; the window restarts from the first hit.
 */

const crypto = require('node:crypto');

const valkey = require('./_valkey');

/** Bound on the local fallback table: ~10k identities × small objects. */
const LOCAL_MAX_IDENTITIES = 10_000;

const REJECTION_LOG_INTERVAL_MS = 30_000;
const lastRejectionLogAt = new Map();

function cleanScope(scope) {
  return String(scope || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) || 'scope';
}

function identityHash(identity) {
  return crypto.createHash('sha256').update(String(identity == null ? '' : identity)).digest('hex').slice(0, 32);
}

function rateLimitBucket(scope, identity) {
  return `rl:${cleanScope(scope)}:${identityHash(identity)}`;
}

/** Sampled rejection log: one line per scope/backend per interval, no identity. */
function noteRejection(scope, backend) {
  const stamp = `${cleanScope(scope)}:${backend}`;
  const now = Date.now();
  if (now - (lastRejectionLogAt.get(stamp) || 0) < REJECTION_LOG_INTERVAL_MS) return;
  lastRejectionLogAt.set(stamp, now);
  console.warn('rate limit rejected', { scope: cleanScope(scope), backend });
}

// --- Best-effort class -------------------------------------------------------

const localWindows = new Map(); // bucket -> { windowStart, count }

function localConsume(bucket, limit, windowSeconds) {
  const windowMs = Math.max(1, windowSeconds) * 1000;
  const windowStart = Math.floor(Date.now() / windowMs);
  const entry = localWindows.get(bucket);
  const current = entry && entry.windowStart === windowStart
    ? { windowStart, count: entry.count + 1 }
    : { windowStart, count: 1 };
  localWindows.set(bucket, current);

  // Keep the fallback table bounded: drop expired windows, then evict the
  // oldest-inserted identities if a single-window flood still overflows.
  if (localWindows.size >= LOCAL_MAX_IDENTITIES) {
    for (const [key, row] of localWindows) {
      if (row.windowStart < windowStart) localWindows.delete(key);
    }
    while (localWindows.size >= LOCAL_MAX_IDENTITIES) {
      const oldest = localWindows.keys().next().value;
      localWindows.delete(oldest);
    }
  }
  return current.count;
}

/**
 * Best-effort limit. Resolves { allowed, backend, count, retryAfterSec } and
 * never throws: a Valkey outage is invisible to callers except in `backend`.
 */
async function limitBestEffort({ scope, identity, limit, windowSeconds }) {
  const bucket = rateLimitBucket(scope, identity);
  const window = Math.max(1, Math.trunc(windowSeconds || 60));
  const max = Math.max(1, Math.trunc(limit));
  const count = await valkey.incrWindow(bucket, window);
  if (count != null) {
    const allowed = count <= max;
    if (!allowed) noteRejection(scope, 'valkey');
    return { allowed, backend: 'valkey', count, retryAfterSec: allowed ? 0 : window };
  }
  const localCount = localConsume(bucket, max, window);
  const allowed = localCount <= max;
  if (!allowed) noteRejection(scope, 'local');
  return { allowed, backend: 'local', count: localCount, retryAfterSec: allowed ? 0 : window };
}

// --- Security-critical class -------------------------------------------------

function defaultSecurityQuery(sql, values) {
  return require('./_marketplace_db').marketplaceWriteQuery(sql, values);
}

/**
 * Durable limit backed by public.marketplace_rate_limits (writer pool).
 * FAIL-CLOSED: if the store is unavailable or answers malformed data the
 * request is rejected (allowed: false, backend: 'error'). No local fallback.
 */
async function limitSecurityCritical({ scope, identity, limit, windowSeconds }, { query = defaultSecurityQuery } = {}) {
  const bucket = rateLimitBucket(scope, identity);
  const window = Math.max(1, Math.trunc(windowSeconds || 60));
  const max = Math.max(1, Math.trunc(limit));
  const windowStart = Math.floor(Date.now() / (window * 1000));
  try {
    const result = await query(
      `
        insert into public.marketplace_rate_limits (bucket, window_start, hits)
        values ($1, $2, 1)
        on conflict (bucket, window_start)
          do update set hits = public.marketplace_rate_limits.hits + 1
        returning hits
      `,
      [bucket, windowStart],
    );
    const hits = Number(result?.rows?.[0]?.hits);
    if (!Number.isFinite(hits) || hits < 1) {
      throw new Error('rate limit row returned no usable hit count');
    }
    const allowed = hits <= max;
    if (!allowed) noteRejection(scope, 'postgres');
    return { allowed, backend: 'postgres', count: hits, retryAfterSec: allowed ? 0 : window };
  } catch (error) {
    console.error('security rate limit store unavailable, failing closed', {
      scope: cleanScope(scope),
      message: error.message,
    });
    return { allowed: false, backend: 'error', count: null, retryAfterSec: window };
  }
}

/** Remove fully-expired windows once any security route is wired (cron/sweep). */
async function purgeExpiredSecurityRateLimits({ olderThanEpoch = Math.floor(Date.now() / 1000) - 3600, query = defaultSecurityQuery } = {}) {
  const result = await query(
    'delete from public.marketplace_rate_limits where window_start < $1',
    [olderThanEpoch],
  );
  return result?.rowCount || 0;
}

/** Test access to the bounded local fallback table. */
function localWindowSize() {
  return localWindows.size;
}

function resetLocalWindows() {
  localWindows.clear();
}

module.exports = {
  limitBestEffort,
  limitSecurityCritical,
  purgeExpiredSecurityRateLimits,
  rateLimitBucket,
  localWindowSize,
  resetLocalWindows,
};
