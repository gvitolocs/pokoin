// Scan Connect HTTP client for the desktop. Endpoints live in CardVault
// (docs/SCAN_CONNECT.md). Same-origin `/api` in dev (Vite proxy); production
// calls api.pokoin.com directly (CORS) — one hop less per edit, and
// streaming through the Vercel rewrite is not verified.

import { PUBLIC_API_ORIGIN } from './extension-auth-bridge.js';

const ACTIVE_SESSION_KEY = 'pokoin.scan.session';

export function scanApiOrigin(hostname = typeof window !== 'undefined' ? window.location.hostname : '') {
  return /(^|\.)pokoin\.com$/.test(hostname) ? PUBLIC_API_ORIGIN : '';
}

export function streamUrl(batchId, cursor, origin = scanApiOrigin()) {
  const params = new URLSearchParams({ batchId, after: String(cursor || 0) });
  return `${origin}/api/scan-stream?${params}`;
}

/**
 * QR / link that opens the phone scanner already paired: `c` is the 4-digit
 * code (shown pre-filled on the phone), `k` the pairing secret. The server
 * only accepts the pair when both match the same live pairing. Fragment, so
 * neither reaches a server log. docs/SCAN_CONNECT.md#qr-link
 */
export function phoneConnectUrl(qrSecret, pin = '') {
  const params = new URLSearchParams();
  if (/^[0-9]{4}$/.test(String(pin))) params.set('c', String(pin));
  params.set('k', String(qrSecret || ''));
  return `https://scan.pokoin.com/connect#${params}`;
}

/** dashboard.pokoin.com serves the seller desk; `/scan` there is Scan Connect. */
export function isDashboardHost(hostname = typeof window !== 'undefined' ? window.location.hostname : '') {
  return String(hostname).toLowerCase() === 'dashboard.pokoin.com';
}

async function request(path, { method = 'GET', body, token }) {
  const res = await fetch(`${scanApiOrigin()}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = data.code || '';
    error.problems = data.problems || [];
    throw error;
  }
  return data;
}

const post = (path, body, token) => request(path, { method: 'POST', body: body || {}, token });
const get = (path, token) => request(path, { token });

export const scanApi = {
  start: (token, batchId) => post('/api/scan-session?action=start', batchId ? { batchId } : {}, token),
  regenerate: (token, sessionId) => post('/api/scan-session?action=pairing', { sessionId }, token),
  disconnect: (token, sessionId) => post('/api/scan-session?action=disconnect', { sessionId }, token),
  pause: (token, sessionId, paused) => post('/api/scan-session?action=pause', { sessionId, paused }, token),
  end: (token, sessionId, reason) => post('/api/scan-session?action=end', { sessionId, reason }, token),
  session: (token, sessionId) => get(`/api/scan-session?sessionId=${encodeURIComponent(sessionId)}`, token),
  batch: (token, batchId) => get(`/api/scan-batch?batchId=${encodeURIComponent(batchId)}`, token),
  openBatches: (token) => get('/api/scan-batch?list=open', token),
  defaults: (token, batchId, defaults) => post('/api/scan-batch?action=defaults', { batchId, defaults }, token),
  patch: (token, itemId, patch) => post('/api/scan-batch?action=item', { itemId, patch }, token),
  add: (token, batchId, body) => post('/api/scan-batch?action=add', { batchId, ...body }, token),
  remove: (token, itemId) => post('/api/scan-batch?action=remove', { itemId }, token),
  restore: (token, itemId) => post('/api/scan-batch?action=restore', { itemId }, token),
  duplicate: (token, itemId) => post('/api/scan-batch?action=duplicate', { itemId }, token),
  unmerge: (token, itemId) => post('/api/scan-batch?action=unmerge', { itemId }, token),
  submit: (token, batchId, submitKey, intent = 'list') => post('/api/scan-batch?action=submit', {
    batchId,
    submitKey,
    intent: intent === 'collection' ? 'collection' : 'list',
  }, token),
  discard: (token, batchId) => post('/api/scan-batch?action=discard', { batchId }, token),
};

export async function fetchScanImage(token, itemId) {
  const res = await fetch(`${scanApiOrigin()}/api/scan-batch?action=image&itemId=${encodeURIComponent(itemId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('image');
  return URL.createObjectURL(await res.blob());
}

/** Remember the live session so a sign-out from any tab can end it. */
export function rememberActiveSession(sessionId) {
  try {
    if (sessionId) localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
    else localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch (_) {
    // private mode: server inactivity expiry still ends it
  }
}

export async function endActiveScanSessionForSignOut(getToken) {
  let sessionId = '';
  try {
    sessionId = localStorage.getItem(ACTIVE_SESSION_KEY) || '';
  } catch (_) {
    return;
  }
  if (!sessionId) return;
  try {
    const token = await getToken();
    if (token) {
      await Promise.race([
        scanApi.end(token, sessionId, 'logout'),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
  } catch (_) {
    // best effort; the server ends idle sessions after 30 minutes
  } finally {
    rememberActiveSession('');
  }
}
