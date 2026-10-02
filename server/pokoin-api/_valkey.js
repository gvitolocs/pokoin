'use strict';

/**
 * Tiny fail-open Valkey client for disposable shared state: cache snapshots,
 * best-effort rate-limit counters, and non-authoritative job locks.
 *
 * Contract (do not break):
 *   - No helper ever rejects. Any transport error, timeout, non-integer reply,
 *     or parse failure resolves to the "nothing" value for that helper
 *     (null / false / 0). A down or slow Valkey must degrade reads to
 *     recompute and coordination to "lock not held", never fail a request.
 *   - Nothing stored here is authoritative. Quantities, orders, balances,
 *     checkout holds, webhook claims, and scanner security state live in
 *     Postgres or Firestore. If a key encodes correctness, it is in the
 *     wrong place.
 *   - One TCP connection per command with a short timeout: the client talks
 *     to localhost (Pi) or the in-cluster service (k3s overflow), so 150 ms
 *     is ~2 orders of magnitude above a healthy round trip and caps the
 *     worst case a sick Valkey can add to a request. Override with
 *     VALKEY_TIMEOUT_MS if a topology ever needs more.
 *
 * Key rules: every key carries a TTL except owner-controlled locks; keys
 * never contain raw tokens, secrets, or unbounded user-controlled text
 * (hash identities before keying them). `configure()` exists for tests only.
 */

const net = require('net');

let HOST = process.env.VALKEY_HOST || '127.0.0.1';
let PORT = Number(process.env.VALKEY_PORT || 6379);
let TIMEOUT_MS = Number(process.env.VALKEY_TIMEOUT_MS || 150);

function configure(options = {}) {
  if (options.host) HOST = String(options.host);
  if (options.port) PORT = Number(options.port);
  if (options.timeoutMs) TIMEOUT_MS = Number(options.timeoutMs);
}

// Coarse counters for tests and health introspection. Never per-request logged.
const stats = {
  getHit: 0,
  getMiss: 0,
  getError: 0,
  setOk: 0,
  setError: 0,
  delOk: 0,
  incrError: 0,
  incrDenied: 0,
  lockAcquired: 0,
  lockDenied: 0,
  lockReleased: 0,
  lockError: 0,
};

let lastErrorLogAt = 0;
const ERROR_LOG_INTERVAL_MS = 30_000;

/** Rate-limit error noise: one warn per interval, no payloads, no keys with secrets. */
function noteError(operation, error) {
  stats[operation] = (stats[operation] || 0) + 1;
  if (operation.endsWith('Error')) {
    const now = Date.now();
    if (now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
      lastErrorLogAt = now;
      console.warn('valkey unavailable', { operation, message: String(error?.message || error || 'unknown') });
    }
  }
}

function encode(parts) {
  let out = `*${parts.length}\r\n`;
  for (const part of parts) {
    const text = String(part);
    out += `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
  }
  return out;
}

function parseReply(buf) {
  const firstNl = buf.indexOf('\r\n');
  if (firstNl < 0) {
    return null;
  }
  const head = buf.slice(0, firstNl).toString('utf8');
  const kind = head[0];
  if (kind === '+' || kind === '-') {
    return { value: kind === '+' ? head.slice(1) : null, used: firstNl + 2 };
  }
  if (kind === ':') {
    return { value: Number(head.slice(1)), used: firstNl + 2 };
  }
  if (kind === '$') {
    const size = Number(head.slice(1));
    if (size < 0) {
      return { value: null, used: firstNl + 2 };
    }
    const start = firstNl + 2;
    const end = start + size + 2;
    if (buf.length < end) {
      return null;
    }
    return { value: buf.slice(start, start + size).toString('utf8'), used: end };
  }
  return { value: null, used: buf.length };
}

function command(parts) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port: PORT });
    const chunks = [];
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(null);
    }, TIMEOUT_MS);
    function finish(value) {
      clearTimeout(timer);
      sock.end();
      resolve(value);
    }
    sock.on('error', (error) => {
      noteError('getError', error);
      finish(null);
    });
    sock.on('data', (chunk) => {
      chunks.push(chunk);
      const parsed = parseReply(Buffer.concat(chunks));
      if (parsed) {
        finish(parsed.value);
      }
    });
    sock.on('connect', () => {
      sock.write(encode(parts));
    });
  });
}

async function getJson(key) {
  const raw = await command(['GET', key]);
  if (!raw) {
    stats.getMiss += 1;
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    stats.getHit += 1;
    return parsed;
  } catch (_) {
    stats.getMiss += 1;
    return null;
  }
}

async function setJson(key, value, ttlSeconds) {
  if (value == null || !ttlSeconds) {
    return false;
  }
  const reply = await command(['SETEX', key, String(ttlSeconds), JSON.stringify(value)]);
  if (reply === 'OK') {
    stats.setOk += 1;
    return true;
  }
  noteError('setError', reply);
  return false;
}

async function del(key) {
  const removed = await command(['DEL', key]);
  if (Number.isFinite(removed)) {
    stats.delOk += removed;
    return removed;
  }
  return 0;
}

/**
 * Atomic fixed-window counter: INCR the key and set its TTL on the first
 * increment inside one server-side script, so a crash between INCR and
 * EXPIRE can never leave an immortal key. Returns the new count, or null
 * when Valkey is unavailable (callers fall back to their local limiter).
 */
const INCR_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

async function incrWindow(key, windowSeconds) {
  const count = await command(['EVAL', INCR_WINDOW_SCRIPT, '1', key, String(Math.max(1, Math.trunc(windowSeconds)))]);
  if (Number.isFinite(count)) {
    return count;
  }
  noteError('incrError', count);
  return null;
}

/**
 * Non-authoritative distributed locks. SET key owner NX EX ttl semantics;
 * release/refresh compare the owner token server-side so an expired lock
 * that was taken by someone else is never released or extended by the
 * previous owner. These locks protect efficiency only.
 */
const ACQUIRE_LOCK_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
  return 1
end
return 0
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const REFRESH_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

async function acquireLock(key, ownerToken, ttlSeconds) {
  const acquired = await command([
    'EVAL', ACQUIRE_LOCK_SCRIPT, '1', key, String(ownerToken), String(Math.max(1, Math.trunc(ttlSeconds))),
  ]);
  if (acquired === 1) {
    stats.lockAcquired += 1;
    return true;
  }
  if (acquired === 0) {
    stats.lockDenied += 1;
    return false;
  }
  noteError('lockError', acquired);
  return false;
}

async function releaseLock(key, ownerToken) {
  const released = await command(['EVAL', RELEASE_LOCK_SCRIPT, '1', key, String(ownerToken)]);
  if (released === 1) {
    stats.lockReleased += 1;
    return true;
  }
  if (released === 0) {
    return false;
  }
  noteError('lockError', released);
  return false;
}

async function refreshLock(key, ownerToken, ttlSeconds) {
  const refreshed = await command([
    'EVAL', REFRESH_LOCK_SCRIPT, '1', key, String(ownerToken), String(Math.max(1, Math.trunc(ttlSeconds))),
  ]);
  if (refreshed === 1) {
    return true;
  }
  if (refreshed === 0) {
    return false;
  }
  noteError('lockError', refreshed);
  return false;
}

function valkeyStats() {
  return { ...stats };
}

function resetStats() {
  for (const key of Object.keys(stats)) stats[key] = 0;
}

module.exports = {
  getJson,
  setJson,
  del,
  command,
  incrWindow,
  acquireLock,
  releaseLock,
  refreshLock,
  configure,
  valkeyStats,
  resetStats,
};
