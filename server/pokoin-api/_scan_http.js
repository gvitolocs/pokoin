'use strict';

// HTTP helpers shared by the scan-* handlers: CORS allowlist, JSON replies,
// client IP, bearer / phone credentials.

const ALLOWED_ORIGINS = new Set([
  'https://pokoin.com',
  'https://www.pokoin.com',
  'https://dashboard.pokoin.com',
  'https://scan.pokoin.com',
  'https://cardscan.pokoin.com',
]);

function header(req, name) {
  const value = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function allowedOrigin(origin, env = process.env) {
  if (!origin) return '';
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return origin;
  }
  const extra = String(env.SCAN_CONNECT_EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin) ? origin : '';
}

// Returns true when the request was a preflight and has been answered.
function applyCors(req, res, methods = 'GET, POST, OPTIONS') {
  const origin = allowedOrigin(header(req, 'origin'));
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = origin ? 204 : 403;
    res.end();
    return true;
  }
  return false;
}

function sendJson(res, statusCode, payload) {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendError(res, error, label) {
  const statusCode = Number(error?.statusCode) || 500;
  if (statusCode >= 500) {
    console.error(`${label} failed`, { message: error?.message, code: error?.code });
  }
  const payload = { error: statusCode >= 500 ? 'Scan service error.' : (error?.message || 'Request failed.') };
  if (error?.code && statusCode < 500) payload.code = error.code;
  if (error?.problems) payload.problems = error.problems;
  if (error?.retryAfterSec) res.setHeader('Retry-After', String(error.retryAfterSec));
  sendJson(res, statusCode, payload);
}

// Cloudflare tunnel sets CF-Connecting-IP. The global pair limit backstops a
// spoofed header if the origin is ever reachable without Cloudflare.
function clientIp(req) {
  const cf = header(req, 'cf-connecting-ip').trim();
  if (cf) return cf.slice(0, 64);
  const forwarded = header(req, 'x-forwarded-for').split(',')[0].trim();
  if (forwarded) return forwarded.slice(0, 64);
  return String(req?.socket?.remoteAddress || 'unknown').slice(0, 64);
}

function phoneToken(req) {
  const value = header(req, 'authorization');
  return value.startsWith('Scan ') ? value.slice(5).trim() : '';
}

let desktopVerifier = null;

// Firebase bearer for desktop calls. Tests inject a verifier.
async function verifyDesktop(req) {
  if (desktopVerifier) return desktopVerifier(req);
  const { verifyBearerToken } = require('./_firebase');
  try {
    const decoded = await verifyBearerToken(req);
    if (!decoded?.uid) throw new Error('no uid');
    return decoded;
  } catch (error) {
    throw Object.assign(new Error('Sign in again to use Scan.'), { statusCode: 401, code: 'auth' });
  }
}

function setDesktopVerifierForTests(fn) {
  desktopVerifier = fn;
}

function queryParam(req, name) {
  try {
    const url = new URL(req.url, 'http://local');
    return url.searchParams.get(name) || '';
  } catch (_) {
    return '';
  }
}

module.exports = {
  ALLOWED_ORIGINS,
  allowedOrigin,
  applyCors,
  sendJson,
  sendError,
  clientIp,
  phoneToken,
  queryParam,
  header,
  verifyDesktop,
  setDesktopVerifierForTests,
};
