'use strict';

/**
 * Sync with other platforms (docs/PLATFORM_SYNC.md).
 *
 *   GET    /api/platform-integrations             providers + this seller's status
 *   POST   /api/platform-integrations/:provider   connect (fields / partner) or start OAuth
 *   DELETE /api/platform-integrations/:provider   revoke
 *
 * CardTrader keeps its own cardtrader-* routes and is not listed here.
 * Responses carry safe status only: never a token, secret or OAuth state.
 */

const crypto = require('node:crypto');

const OAUTH_PENDING_COLLECTION = 'platform_oauth_pending';
const REQUESTS_COLLECTION = 'platform_sync_requests';
const OAUTH_TTL_MS = 10 * 60 * 1000;

function cleanText(value, maxLength = 240) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function apiBase(env = process.env) {
  return cleanText(env.POKOIN_PUBLIC_API_BASE, 200).replace(/\/+$/, '') || 'https://api.pokoin.com';
}

function webhookUrl(provider, uid, env = process.env) {
  return `${apiBase(env)}/api/platform-webhook/${provider}/${encodeURIComponent(uid)}`;
}

function defaultDeps() {
  const firebase = require('../server/_firebase');
  return {
    verifyBearerToken: firebase.verifyBearerToken,
    getFirebaseAdmin: firebase.getFirebaseAdmin,
    providers: require('./_platform_providers'),
    integrations: require('./_platform_integration'),
    deleteLinksForProvider: (args) => require('./_platform_links').deleteLinksForProvider(args),
    getAdapter: (id) => require('./_platform_adapters').getAdapter(id),
    enqueueLinkAndImport: (args) => require('./_platform_import').enqueueLinkAndImport(args),
    env: process.env,
    fetchFn: undefined,
    now: () => Date.now(),
  };
}

/** Only the provider's declared fields leave the request body. */
function pickFields(provider, body = {}) {
  const out = {};
  for (const field of provider.fields || []) {
    out[field.name] = cleanText(body[field.name], 4096);
  }
  return out;
}

function adapterCtx(deps, extra = {}) {
  const ctx = { env: deps.env, ...extra };
  if (deps.fetchFn) ctx.fetchFn = deps.fetchFn;
  return ctx;
}

function sellerName(decoded) {
  return cleanText(decoded?.name || decoded?.email || 'Pokoin seller', 120) || 'Pokoin seller';
}

async function listProviders({ deps, firestore, decoded }) {
  const rows = [];
  for (const provider of deps.providers.PROVIDERS) {
    const doc = await deps.integrations.readIntegration(firestore, decoded.uid, provider.id);
    rows.push({
      ...deps.providers.publicProvider(provider, deps.env),
      status: deps.integrations.safeStatus(provider.id, doc),
    });
  }
  return { ok: true, email: decoded.email || '', providers: rows };
}

async function connectFields({ deps, admin, firestore, decoded, provider, body }) {
  const adapter = deps.getAdapter(provider.id);
  const validated = await adapter.validate(adapterCtx(deps), pickFields(provider, body));
  await deps.integrations.storeIntegration({
    admin,
    firestore,
    uid: decoded.uid,
    provider: provider.id,
    email: decoded.email || '',
    secrets: validated.credentials || {},
    metadata: validated.metadata || {},
    state: validated.state || 'connected',
  });

  if (typeof adapter.registerWebhooks === 'function') {
    const url = webhookUrl(provider.id, decoded.uid, deps.env);
    let registration;
    try {
      const result = await adapter.registerWebhooks(
        adapterCtx(deps, { credentials: validated.credentials, metadata: validated.metadata }),
        url,
      );
      registration = { ok: true, ids: result?.ids || [], url, error: '' };
    } catch (error) {
      // A failed registration keeps the connection; the poller still sees orders.
      registration = { ok: false, ids: [], url, error: cleanText(error.message, 300) };
      console.error('platform webhook registration failed', {
        uid: decoded.uid,
        provider: provider.id,
        message: error.message,
      });
    }
    await deps.integrations.patchIntegration(firestore, decoded.uid, provider.id, {
      webhookRegistration: { ...registration, lastAttemptAt: new Date(deps.now()).toISOString() },
    });
  }

  if (typeof adapter.listInventory === 'function') {
    await deps.enqueueLinkAndImport({
      firestore,
      admin,
      uid: decoded.uid,
      sellerName: sellerName(decoded),
      provider: provider.id,
    });
  }
}

async function connectPartner({ deps, admin, firestore, decoded, provider, body }) {
  const adapter = deps.getAdapter(provider.id);
  const validated = await adapter.validate(adapterCtx(deps), pickFields(provider, body));
  await deps.integrations.storeIntegration({
    admin,
    firestore,
    uid: decoded.uid,
    provider: provider.id,
    email: decoded.email || '',
    secrets: validated.credentials || {},
    metadata: validated.metadata || {},
    state: 'pending_activation',
  });
  const now = admin?.firestore?.FieldValue?.serverTimestamp?.() || new Date(deps.now()).toISOString();
  await firestore.collection(REQUESTS_COLLECTION).doc(`${decoded.uid}__${provider.id}`).set({
    uid: decoded.uid,
    provider: provider.id,
    email: decoded.email || '',
    storeId: cleanText(validated.metadata?.storeId, 160),
    requestedAt: now,
    status: 'pending',
  }, { merge: true });
}

async function startOAuth({ deps, firestore, decoded, provider }) {
  const state = crypto.randomBytes(24).toString('base64url');
  await firestore.collection(OAUTH_PENDING_COLLECTION).doc(state).set({
    uid: decoded.uid,
    email: decoded.email || '',
    sellerName: sellerName(decoded),
    provider: provider.id,
    expiresAt: deps.now() + OAUTH_TTL_MS,
  });
  return `${apiBase(deps.env)}/api/platform-oauth/${provider.id}/start?state=${encodeURIComponent(state)}`;
}

async function connect({ deps, admin, firestore, decoded, providerId, body }) {
  const provider = deps.providers.getProvider(providerId);
  if (!provider) throw httpError(404, 'Unknown platform.', 'platform_unknown');
  if (provider.authType !== 'partner' && !deps.providers.isAvailable(provider, deps.env)) {
    throw httpError(503, `${provider.label} sync is not available yet.`, 'platform_unavailable');
  }
  if (provider.authType === 'oauth_redirect') {
    return { redirectUrl: await startOAuth({ deps, firestore, decoded, provider }) };
  }
  if (provider.authType === 'partner') {
    await connectPartner({ deps, admin, firestore, decoded, provider, body });
  } else {
    await connectFields({ deps, admin, firestore, decoded, provider, body });
  }
  const doc = await deps.integrations.readIntegration(firestore, decoded.uid, provider.id);
  return { status: deps.integrations.safeStatus(provider.id, doc) };
}

async function revoke({ deps, admin, firestore, decoded, providerId }) {
  const provider = deps.providers.getProvider(providerId);
  if (!provider) throw httpError(404, 'Unknown platform.', 'platform_unknown');
  const doc = await deps.integrations.readIntegration(firestore, decoded.uid, provider.id);
  const data = doc?.exists ? doc.data() || {} : {};
  const ids = data.webhookRegistration?.ids || [];
  if (data.enabled === true && ids.length) {
    try {
      const adapter = deps.getAdapter(provider.id);
      if (typeof adapter.removeWebhooks === 'function') {
        const credentials = await deps.integrations.decryptSecrets(firestore, decoded.uid, provider.id);
        await adapter.removeWebhooks(adapterCtx(deps, { credentials, metadata: data.metadata || {} }), ids);
      }
    } catch (error) {
      console.error('platform webhook removal skipped', {
        uid: decoded.uid,
        provider: provider.id,
        message: error.message,
      });
    }
  }
  await deps.integrations.disconnectIntegration({ admin, firestore, uid: decoded.uid, provider: provider.id });
  await deps.deleteLinksForProvider({ sellerUid: decoded.uid, provider: provider.id });
  const after = await deps.integrations.readIntegration(firestore, decoded.uid, provider.id);
  return { status: deps.integrations.safeStatus(provider.id, after) };
}

function providerFromRequest(req) {
  const fromParams = cleanText(req.params?.provider, 40);
  if (fromParams) return fromParams.toLowerCase();
  const match = /\/api\/platform-integrations\/([^/?#]+)/.exec(String(req.url || req.path || ''));
  return match ? decodeURIComponent(match[1]).toLowerCase() : '';
}

function createHandler(overrides = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const deps = { ...defaultDeps(), ...overrides };
      const decoded = await deps.verifyBearerToken(req);
      const admin = deps.getFirebaseAdmin();
      const firestore = admin.firestore();
      const providerId = providerFromRequest(req);

      if (req.method === 'GET' && !providerId) {
        return res.status(200).json(await listProviders({ deps, firestore, decoded }));
      }
      if (req.method === 'POST' && providerId) {
        const result = await connect({ deps, admin, firestore, decoded, providerId, body: req.body || {} });
        return res.status(200).json({ ok: true, ...result });
      }
      if (req.method === 'DELETE' && providerId) {
        const result = await revoke({ deps, admin, firestore, decoded, providerId });
        return res.status(200).json({ ok: true, ...result });
      }
      res.setHeader('Allow', providerId ? 'POST, DELETE' : 'GET');
      return res.status(405).json({ error: 'Method not allowed.' });
    } catch (error) {
      console.error('platform-integrations failed', {
        code: error.code || '',
        statusCode: error.statusCode || 500,
        message: error.message,
      });
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Platform request failed.',
        code: error.code,
      });
    }
  };
}

module.exports = createHandler();
module.exports._test = {
  OAUTH_PENDING_COLLECTION,
  REQUESTS_COLLECTION,
  createHandler,
  pickFields,
  providerFromRequest,
  webhookUrl,
};
