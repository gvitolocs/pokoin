'use strict';

/**
 * Cardmarket widget-app login (docs/PLATFORM_SYNC.md "Cardmarket").
 *
 *   GET /api/platform-oauth/:provider/start?state=…   sets the state cookie, 302 → Cardmarket
 *   GET /api/platform-oauth/:provider/callback?request_token=…
 *
 * Cardmarket does not round-trip a state parameter, so the one-time state
 * created by POST /api/platform-integrations/cardmarket travels in an
 * HttpOnly cookie scoped to this path. The seller logs in on Cardmarket
 * itself; Pokoin only ever receives the request token and swaps it for an
 * access token, which is stored encrypted.
 */

const COOKIE_NAME = 'pokoin_platform_oauth';
const COOKIE_PATH = '/api/platform-oauth';
const PENDING_COLLECTION = 'platform_oauth_pending';

function cleanText(value, maxLength = 240) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function defaultDeps() {
  const firebase = require('../server/_firebase');
  return {
    getFirebaseAdmin: firebase.getFirebaseAdmin,
    providers: require('./_platform_providers'),
    integrations: require('./_platform_integration'),
    getAdapter: (id) => require('./_platform_adapters').getAdapter(id),
    enqueueLinkAndImport: (args) => require('./_platform_import').enqueueLinkAndImport(args),
    env: process.env,
    fetchFn: undefined,
    now: () => Date.now(),
  };
}

function webBase(env = process.env) {
  return cleanText(env.POKOIN_WEB_BASE, 200).replace(/\/+$/, '') || 'https://pokoin.com';
}

function profileUrl(env, provider, outcome) {
  const params = new URLSearchParams({ platform: provider });
  if (outcome.error) params.set('error', outcome.error);
  else params.set('connected', '1');
  return `${webBase(env)}/profile?${params.toString()}`;
}

function readCookie(req, name) {
  const header = String(req.headers?.cookie || req.headers?.Cookie || '');
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch (_) {
        return '';
      }
    }
  }
  return '';
}

function stateCookie(value, maxAge) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function routeParts(req) {
  const provider = cleanText(req.params?.provider, 40).toLowerCase();
  const url = String(req.path || req.url || '');
  const match = /\/api\/platform-oauth\/([^/?#]+)\/(start|callback)/.exec(url);
  return {
    provider: provider || (match ? decodeURIComponent(match[1]).toLowerCase() : ''),
    step: match ? match[2] : '',
  };
}

function queryValue(req, name) {
  if (req.query && req.query[name] != null) return cleanText(req.query[name], 2048);
  const raw = String(req.url || '');
  const index = raw.indexOf('?');
  if (index === -1) return '';
  return cleanText(new URLSearchParams(raw.slice(index + 1)).get(name), 2048);
}

function redirect(res, location, cookie) {
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.setHeader('Location', location);
  return res.status(302).end();
}

/** A pending state is valid once: it must exist, match, and not be expired. */
async function loadPending({ firestore, state, provider, now, consume }) {
  if (!state || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) return null;
  const ref = firestore.collection(PENDING_COLLECTION).doc(state);
  const doc = await ref.get();
  if (!doc.exists) return null;
  const data = doc.data() || {};
  if (data.provider !== provider || !data.uid) return null;
  if (!(Number(data.expiresAt) > now)) {
    await ref.delete().catch(() => {});
    return null;
  }
  if (consume) await ref.delete();
  return data;
}

async function handleStart({ deps, req, res, firestore, provider }) {
  const state = queryValue(req, 'state');
  const pending = await loadPending({ firestore, state, provider, now: deps.now(), consume: false });
  if (!pending) return redirect(res, profileUrl(deps.env, provider, { error: 'state' }));
  const adapter = deps.getAdapter(provider);
  const ctx = { env: deps.env };
  return redirect(res, adapter.authorizeUrl(ctx), stateCookie(state, 600));
}

async function handleCallback({ deps, req, res, admin, firestore, provider }) {
  const clear = stateCookie('', 0);
  const state = readCookie(req, COOKIE_NAME);
  const pending = await loadPending({ firestore, state, provider, now: deps.now(), consume: true });
  if (!pending) return redirect(res, profileUrl(deps.env, provider, { error: 'state' }), clear);
  const requestToken = queryValue(req, 'request_token');
  if (!requestToken) return redirect(res, profileUrl(deps.env, provider, { error: 'denied' }), clear);

  try {
    const adapter = deps.getAdapter(provider);
    const ctx = { env: deps.env };
    if (deps.fetchFn) ctx.fetchFn = deps.fetchFn;
    const exchanged = await adapter.exchangeRequestToken(ctx, requestToken);
    await deps.integrations.storeIntegration({
      admin,
      firestore,
      uid: pending.uid,
      provider,
      email: pending.email || '',
      secrets: exchanged.credentials || {},
      metadata: exchanged.metadata || {},
      state: 'connected',
    });
    await deps.enqueueLinkAndImport({
      firestore,
      admin,
      uid: pending.uid,
      sellerName: pending.sellerName || pending.email || 'Pokoin seller',
      provider,
    });
    return redirect(res, profileUrl(deps.env, provider, {}), clear);
  } catch (error) {
    // Never echo the upstream message into a URL.
    console.error('platform oauth callback failed', {
      uid: pending.uid,
      provider,
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return redirect(res, profileUrl(deps.env, provider, { error: 'exchange' }), clear);
  }
}

function createHandler(overrides = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    const deps = { ...defaultDeps(), ...overrides };
    const { provider, step } = routeParts(req);
    const def = deps.providers.getProvider(provider);
    if (!def || def.authType !== 'oauth_redirect') {
      return res.status(404).json({ error: 'Unknown platform.', code: 'platform_unknown' });
    }
    try {
      const admin = deps.getFirebaseAdmin();
      const firestore = admin.firestore();
      if (step === 'start') return await handleStart({ deps, req, res, firestore, provider });
      if (step === 'callback') return await handleCallback({ deps, req, res, admin, firestore, provider });
      return res.status(404).json({ error: 'Not found.' });
    } catch (error) {
      console.error('platform oauth failed', { provider, step, message: error.message });
      return redirect(res, profileUrl(deps.env, provider, { error: 'server' }), stateCookie('', 0));
    }
  };
}

module.exports = createHandler();
module.exports._test = {
  COOKIE_NAME,
  PENDING_COLLECTION,
  createHandler,
  readCookie,
  routeParts,
};
