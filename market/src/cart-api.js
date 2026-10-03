// Cart page API calls: account cart sync and personal recommendations.
// Background calls — a failure here must never flip the SPA into the
// "working on it" outage page the way getJson does for /api network errors,
// so this keeps its own fetch and only throws to its caller.

import { publicApiUrl } from './extension-auth-bridge.js';
import { gameRequestHeaders, withGameQuery } from './game.js';

async function request(path, { method = 'GET', token = '', body, signal } = {}) {
  const headers = { Accept: 'application/json', ...gameRequestHeaders() };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(publicApiUrl(withGameQuery(path)), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
  } catch (cause) {
    const error = new Error('Cart service unreachable.');
    error.status = 0;
    error.cause = cause;
    throw error;
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.body = data || {};
    throw error;
  }
  return data;
}

/** { items, saved, gift, rev, updatedAt } for the signed-in buyer. */
export function fetchAccountCart(token) {
  return request('/api/marketplace-cart-sync', { token });
}

/** Save against `baseRev`; a lost race throws status 409 with body.cart = current. */
export function saveAccountCart(token, { items, saved, gift, baseRev }) {
  return request('/api/marketplace-cart-sync', {
    method: 'PUT',
    token,
    body: { items, saved, gift, baseRev },
  });
}

function idList(values, max) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))]
    .slice(0, max)
    .join(',');
}

/** Personal rails; the browser's own ids are merged with the account's server-side. */
export function fetchRecommendations({ token = '', cart = [], recent = [], watch = [], sellers = [], listings = [], limit = 18, signal } = {}) {
  const params = new URLSearchParams();
  const put = (name, value) => {
    if (value) params.set(name, value);
  };
  put('cart', idList(cart, 40));
  put('recent', idList(recent, 24));
  put('watch', idList(watch, 24));
  put('sellers', idList(sellers, 6));
  put('listings', idList(listings, 120));
  params.set('limit', String(limit));
  return request(`/api/marketplace-recommendations?${params}`, { token, signal });
}
