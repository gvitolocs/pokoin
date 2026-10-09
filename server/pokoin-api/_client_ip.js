'use strict';

/**
 * The ONE place that decides a request's client IP. Proxy headers are trusted
 * only when the immediate TCP peer is a trusted proxy (loopback by default,
 * POKOIN_TRUSTED_PROXY_CIDRS otherwise). Every handler should call
 * clientIp(req) / applyTrustedClientIp(req) instead of reading
 * x-forwarded-for or cf-connecting-ip by hand.
 */

const net = require('node:net');

const DEFAULT_TRUSTED_PROXIES = '127.0.0.1/32,::1/128';

/** More than this many x-forwarded-for entries is a malformed chain. */
const MAX_FORWARDED_ENTRIES = 20;

const proxyCache = new Map();

function addEntry(list, entry) {
  const [address, prefixText] = entry.includes('/') ? entry.split('/') : [entry, undefined];
  const ip = normalizeIp(address);
  const kind = net.isIP(ip);
  if (!kind) throw new Error(`invalid trusted proxy entry: ${entry}`);
  const prefix = prefixText === undefined ? (kind === 6 ? 128 : 32) : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (kind === 6 ? 128 : 32)) {
    throw new Error(`invalid trusted proxy entry: ${entry}`);
  }
  const family = kind === 6 ? 'ipv6' : 'ipv4';
  if (prefix === (kind === 6 ? 128 : 32)) list.addAddress(ip, family);
  else list.addSubnet(ip, prefix, family);
}

function parseTrustedProxies(text) {
  const list = new net.BlockList();
  for (const raw of String(text == null ? '' : text).split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    try {
      addEntry(list, entry);
    } catch (error) {
      if (/invalid trusted proxy entry/.test(error.message)) throw error;
      throw new Error(`invalid trusted proxy entry: ${entry}`);
    }
  }
  return list;
}

function trustedProxiesFor(envText) {
  let list = proxyCache.get(envText);
  if (!list) {
    list = parseTrustedProxies(envText);
    proxyCache.set(envText, list);
  }
  return list;
}

function normalizeIp(value) {
  let ip = String(value == null ? '' : value).trim();
  if (ip.length >= 2 && ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1).trim();
  }
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  ip = ip.toLowerCase();
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) ip = mapped[1];
  return net.isIP(ip) ? ip : '';
}

function isTrusted(ip, blockList) {
  if (!ip) return false;
  const version = net.isIP(ip);
  if (!version) return false;
  return blockList.check(ip, version === 6 ? 'ipv6' : 'ipv4');
}

/** Case-insensitive header lookup for real request headers and plain objects. */
function headerValue(req, name) {
  const headers = req && req.headers;
  if (!headers) return undefined;
  if (Object.prototype.hasOwnProperty.call(headers, name)) return headers[name];
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : headers[key];
}

function resolveClientIp(req, { trustedProxies } = {}) {
  const blockList = trustedProxies || trustedProxiesFor(process.env.POKOIN_TRUSTED_PROXY_CIDRS ?? DEFAULT_TRUSTED_PROXIES);
  const peer = normalizeIp((req && (req.socket || {}).remoteAddress) || (req && (req.connection || {}).remoteAddress) || '');
  if (!isTrusted(peer, blockList)) {
    return { ip: peer || 'unknown', source: 'peer', peer, trustedPeer: false };
  }
  const cf = headerValue(req, 'cf-connecting-ip');
  if (typeof cf === 'string' && !cf.includes(',')) {
    const ip = normalizeIp(cf);
    if (ip) return { ip, source: 'cf-connecting-ip', peer, trustedPeer: true };
  }
  let xff = headerValue(req, 'x-forwarded-for');
  if (Array.isArray(xff)) xff = xff.join(',');
  if (typeof xff === 'string') {
    const entries = xff.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (entries.length <= MAX_FORWARDED_ENTRIES) {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const ip = normalizeIp(entries[i]);
        if (isTrusted(ip, blockList)) continue;
        if (ip) return { ip, source: 'x-forwarded-for', peer, trustedPeer: true };
        return { ip: peer || 'unknown', source: 'peer', peer, trustedPeer: true };
      }
    }
  }
  return { ip: peer || 'unknown', source: 'peer', peer, trustedPeer: true };
}

/**
 * Rewrite the request so legacy handlers that read proxy headers see only the
 * trusted answer. Removes the client-supplied variants (any case) and stamps
 * the resolved ip into the canonical headers plus req.pokoinClientIp.
 */
function applyTrustedClientIp(req, opts) {
  const result = resolveClientIp(req, opts);
  const headers = (req && req.headers) || {};
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'cf-connecting-ip' || lower === 'x-forwarded-for' || lower === 'x-real-ip' || lower === 'true-client-ip' || lower === 'x-client-ip') {
      delete headers[key];
    }
  }
  headers['cf-connecting-ip'] = result.ip;
  headers['x-forwarded-for'] = result.ip;
  headers['x-real-ip'] = result.ip;
  headers['x-pokoin-client-ip'] = result.ip;
  if (req) {
    req.pokoinClientIp = result.ip;
    req.pokoinClientIpSource = result.source;
  }
  return result;
}

function clientIp(req) {
  if (req && typeof req.pokoinClientIp === 'string' && req.pokoinClientIp) return req.pokoinClientIp;
  return resolveClientIp(req || {}).ip;
}

module.exports = {
  DEFAULT_TRUSTED_PROXIES,
  parseTrustedProxies,
  normalizeIp,
  isTrusted,
  resolveClientIp,
  applyTrustedClientIp,
  clientIp,
};
