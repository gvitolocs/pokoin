'use strict';

/**
 * POST /api/platform-webhook/:provider/:uid  (rawBody route)
 *
 * Order webhooks from a connected platform (Shopify / BinderPOS today). The
 * signature is checked against the exact raw bytes with the seller's stored
 * secret before anything is parsed. A verified delivery always answers 200
 * with counts so the platform does not retry forever; each order item is
 * applied exactly once by _platform_fanout (claimed per order + item).
 */

function cleanText(value, maxLength = 240) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function defaultDeps() {
  const firebase = require('../server/_firebase');
  const fanout = require('./_platform_fanout');
  return {
    getFirebaseAdmin: firebase.getFirebaseAdmin,
    providers: require('./_platform_providers'),
    integrations: require('./_platform_integration'),
    getAdapter: (id) => require('./_platform_adapters').getAdapter(id),
    rawBodyBuffer: (req) => require('./_cardtrader_webhook_core').rawBodyBuffer(req),
    applyExternalSale: fanout.applyExternalSale,
    applyExternalCancel: fanout.applyExternalCancel,
  };
}

function routeParams(req) {
  let provider = cleanText(req.params?.provider, 40).toLowerCase();
  let uid = cleanText(req.params?.uid, 160);
  if (!provider || !uid) {
    const match = /\/api\/platform-webhook\/([^/?#]+)\/([^/?#]+)/.exec(String(req.url || req.path || ''));
    if (match) {
      provider = provider || decodeURIComponent(match[1]).toLowerCase();
      uid = uid || decodeURIComponent(match[2]);
    }
  }
  return { provider, uid };
}

function createHandler(overrides = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    const deps = { ...defaultDeps(), ...overrides };
    const { provider, uid } = routeParams(req);
    const def = deps.providers.getProvider(provider);
    if (!def || !uid) return res.status(404).json({ error: 'Unknown platform webhook.' });

    try {
      const admin = deps.getFirebaseAdmin();
      const firestore = admin.firestore();
      const adapter = deps.getAdapter(provider);
      if (typeof adapter.verifyWebhook !== 'function' || typeof adapter.parseWebhook !== 'function') {
        return res.status(404).json({ error: 'This platform has no webhook.' });
      }
      const doc = await deps.integrations.readIntegration(firestore, uid, provider);
      if (!doc?.exists || doc.data()?.enabled !== true) {
        return res.status(404).json({ error: 'Platform is not connected.' });
      }
      const credentials = await deps.integrations.decryptSecrets(firestore, uid, provider);
      const raw = await deps.rawBodyBuffer(req);
      if (!adapter.verifyWebhook(raw, req.headers || {}, credentials)) {
        console.warn('platform-webhook rejected', {
          uid,
          provider,
          reason: 'invalid_signature',
          bodyBytes: raw.length,
        });
        return res.status(401).json({ error: 'Invalid webhook signature.' });
      }

      let body = req.body;
      if (!body || typeof body !== 'object' || Buffer.isBuffer(body)) {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      }
      const parsed = adapter.parseWebhook(body, req.headers || {}) || { kind: 'ignore', items: [] };
      const counts = { applied: 0, skipped: 0, failed: 0 };
      if (parsed.kind === 'sale' || parsed.kind === 'cancel') {
        const apply = parsed.kind === 'sale' ? deps.applyExternalSale : deps.applyExternalCancel;
        for (const item of parsed.items || []) {
          try {
            const result = await apply({ ...item, provider, sellerUid: uid, firestore, admin });
            if (result?.applied) counts.applied += 1;
            else if (result?.ok === false) counts.failed += 1;
            else counts.skipped += 1;
          } catch (error) {
            counts.failed += 1;
            console.error('platform-webhook item failed', {
              uid,
              provider,
              orderId: cleanText(item.orderId, 80),
              message: error.message,
            });
          }
        }
      }
      console.log('platform-webhook processed', { uid, provider, kind: parsed.kind, ...counts });
      return res.status(200).json({ ok: true, kind: parsed.kind, ...counts });
    } catch (error) {
      console.error('platform-webhook failed', {
        uid,
        provider,
        statusCode: error.statusCode || 500,
        message: error.message,
      });
      return res.status(error.statusCode || 500).json({ error: 'Platform webhook failed.' });
    }
  };
}

module.exports = createHandler();
module.exports._test = { createHandler, routeParams };
