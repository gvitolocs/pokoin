'use strict';

/**
 * One persistent Valkey connection for disposable cache state.
 * Every helper resolves to a miss/empty value on timeout, protocol error,
 * or a down server. Callers must not store stock, balances, or orders here.
 *
 * Commands written while a reply is outstanding are pipelined on the same
 * socket. A timeout destroys the socket so the reply queue cannot desync.
 */

const net = require('node:net');

let HOST = process.env.VALKEY_HOST || '127.0.0.1';
let PORT = Number(process.env.VALKEY_PORT || 6379);
let TIMEOUT_MS = Number(process.env.VALKEY_TIMEOUT_MS || 150);
const MAX_CONNECT_ATTEMPTS = 2;

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
  connects: 0,
  timeouts: 0,
};

let lastErrorLogAt = 0;
const ERROR_LOG_INTERVAL_MS = 30_000;

function noteError(operation, error) {
  stats[operation] = (stats[operation] || 0) + 1;
  if (!String(operation).endsWith('Error') && operation !== 'timeouts') return;
  const now = Date.now();
  if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
  lastErrorLogAt = now;
  console.warn(JSON.stringify({
    msg: 'valkey_unavailable',
    operation,
    message: String(error?.message || error || 'unknown'),
  }));
}

function configure(options = {}) {
  if (options.host) HOST = String(options.host);
  if (options.port) PORT = Number(options.port);
  if (options.timeoutMs) TIMEOUT_MS = Number(options.timeoutMs);
  resetConnection();
}

function encode(parts) {
  let out = `*${parts.length}\r\n`;
  for (const part of parts) {
    const text = Buffer.from(String(part));
    out += `$${text.length}\r\n${text.toString('utf8')}\r\n`;
  }
  return out;
}

function parseOne(buf) {
  if (!buf.length) return null;
  const firstNl = buf.indexOf('\r\n');
  if (firstNl < 0) return null;
  const head = buf.slice(0, firstNl).toString('utf8');
  const kind = head[0];
  if (kind === '+' || kind === '-') {
    return { value: kind === '+' ? head.slice(1) : null, used: firstNl + 2, error: kind === '-' };
  }
  if (kind === ':') {
    return { value: Number(head.slice(1)), used: firstNl + 2 };
  }
  if (kind === '$') {
    const size = Number(head.slice(1));
    if (size < 0) return { value: null, used: firstNl + 2 };
    const start = firstNl + 2;
    const end = start + size + 2;
    if (buf.length < end) return null;
    return { value: buf.slice(start, start + size).toString('utf8'), used: end };
  }
  if (kind === '*') {
    const count = Number(head.slice(1));
    if (count < 0) return { value: null, used: firstNl + 2 };
    let offset = firstNl + 2;
    const values = [];
    for (let i = 0; i < count; i += 1) {
      const parsed = parseOne(buf.slice(offset));
      if (!parsed) return null;
      values.push(parsed.value);
      offset += parsed.used;
    }
    return { value: values, used: offset };
  }
  return { value: null, used: buf.length, error: true };
}

let socket = null;
let buffer = Buffer.alloc(0);
let queue = [];
let connecting = null;
let connectAttempts = 0;

function failAll(error) {
  const pending = queue;
  queue = [];
  buffer = Buffer.alloc(0);
  for (const item of pending) {
    clearTimeout(item.timer);
    item.resolve(null);
  }
  if (error) noteError('getError', error);
}

function resetConnection() {
  connectAttempts = 0;
  if (socket) {
    const dying = socket;
    socket = null;
    dying.destroy();
  }
  failAll(null);
}

function onData(chunk) {
  buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
  while (queue.length) {
    const parsed = parseOne(buffer);
    if (!parsed) return;
    buffer = buffer.slice(parsed.used);
    const item = queue.shift();
    clearTimeout(item.timer);
    if (parsed.error) noteError('getError', parsed.value);
    item.resolve(parsed.error ? null : parsed.value);
  }
}

function ensureConnected() {
  if (socket && !socket.destroyed) return Promise.resolve(socket);
  if (connecting) return connecting;
  connecting = new Promise((resolve) => {
    connectAttempts += 1;
    const next = net.connect({ host: HOST, port: PORT });
    const fail = (error) => {
      if (socket === next) socket = null;
      next.destroy();
      connecting = null;
      noteError('getError', error);
      if (connectAttempts < MAX_CONNECT_ATTEMPTS) {
        resolve(ensureConnected());
        return;
      }
      connectAttempts = 0;
      failAll(error);
      resolve(null);
    };
    next.setTimeout(TIMEOUT_MS, () => fail(new Error('valkey connect timeout')));
    next.once('error', fail);
    next.once('connect', () => {
      stats.connects += 1;
      connectAttempts = 0;
      socket = next;
      connecting = null;
      next.setTimeout(0);
      next.on('data', onData);
      next.on('error', (error) => {
        if (socket === next) socket = null;
        failAll(error);
      });
      next.on('close', () => {
        if (socket === next) socket = null;
        failAll(null);
      });
      resolve(next);
    });
  });
  return connecting;
}

function command(parts) {
  return new Promise((resolve) => {
    const item = {
      resolve,
      timer: setTimeout(() => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        stats.timeouts += 1;
        noteError('timeouts', new Error('valkey command timeout'));
        item.resolve(null);
        if (socket) socket.destroy();
        else failAll(new Error('valkey command timeout'));
      }, TIMEOUT_MS),
    };
    queue.push(item);
    ensureConnected().then((sock) => {
      if (!sock || item.resolve == null) return;
      if (!queue.includes(item)) return;
      try {
        sock.write(encode(parts));
      } catch (error) {
        noteError('getError', error);
        if (socket) socket.destroy();
      }
    });
  });
}

async function getJson(key) {
  const raw = await command(['GET', key]);
  if (raw == null || raw === '') {
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
  if (value == null || !ttlSeconds) return false;
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

const INCR_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

async function incrWindow(key, windowSeconds) {
  const count = await command([
    'EVAL', INCR_WINDOW_SCRIPT, '1', key, String(Math.max(1, Math.trunc(windowSeconds))),
  ]);
  if (Number.isFinite(count)) return count;
  noteError('incrError', count);
  return null;
}

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
  if (released === 0) return false;
  noteError('lockError', released);
  return false;
}

async function refreshLock(key, ownerToken, ttlSeconds) {
  const refreshed = await command([
    'EVAL', REFRESH_LOCK_SCRIPT, '1', key, String(ownerToken), String(Math.max(1, Math.trunc(ttlSeconds))),
  ]);
  if (refreshed === 1) return true;
  if (refreshed === 0) return false;
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
  _test: { encode, parseOne, resetConnection },
};
