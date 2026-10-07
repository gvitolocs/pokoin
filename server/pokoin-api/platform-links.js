'use strict';

/**
 * Seller-managed links between a Pokoin listing and a product on another
 * connected platform (docs/PLATFORM_SYNC.md).
 *
 *   GET    /api/platform-links?listingId=…                 links of one listing
 *   POST   /api/platform-links { listingId, provider, externalId }   manual link
 *   POST   /api/platform-links { action: 'resync', provider }       re-run link/import
 *   DELETE /api/platform-links { listingId, provider }               unlink
 */

function cleanText(value, maxLength = 240) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function defaultDeps() {
  const firebase = require('../server/_firebase');
  return {
    verifyBearerToken: firebase.verifyBearerToken,
    getFirebaseAdmin: firebase.getFirebaseAdmin,
    providers: require('./_platform_providers'),
    integrations: require('./_platform_integration'),
    links: require('./_platform_links'),
    enqueueLinkAndImport: (args) => require('./_platform_import').enqueueLinkAndImport(args),
    writeQuery: (sql, params) => require('./_marketplace_db').marketplaceWriteQuery(sql, params),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownedListing(deps, uid, listingId) {
  const id = cleanText(listingId, 80);
  if (!UUID_RE.test(id)) throw httpError(400, 'Pick a listing.', 'listing_invalid');
  const result = await deps.writeQuery(
    'select id from public.marketplace_user_listings where id = $1 and seller_uid = $2',
    [id, uid],
  );
  if (!result.rows?.[0]) throw httpError(404, 'Listing not found.', 'listing_not_found');
  return id;
}

async function connectedProvider(deps, firestore, uid, providerId) {
  const provider = deps.providers.getProvider(cleanText(providerId, 40).toLowerCase());
  if (!provider) throw httpError(404, 'Unknown platform.', 'platform_unknown');
  const doc = await deps.integrations.readIntegration(firestore, uid, provider.id);
  const status = deps.integrations.safeStatus(provider.id, doc);
  if (!status.connected) throw httpError(409, `${provider.label} is not connected.`, 'platform_not_connected');
  return provider;
}

function bodyOf(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  return {};
}

function queryOf(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  const raw = String(req.url || '');
  const index = raw.indexOf('?');
  return index === -1 ? {} : Object.fromEntries(new URLSearchParams(raw.slice(index + 1)));
}

function createHandler(overrides = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const deps = { ...defaultDeps(), ...overrides };
      const decoded = await deps.verifyBearerToken(req);
      const admin = deps.getFirebaseAdmin();
      const firestore = admin.firestore();
      const uid = decoded.uid;

      if (req.method === 'GET') {
        const listingId = await ownedListing(deps, uid, queryOf(req).listingId);
        const rows = await deps.links.linksForListing(listingId);
        return res.status(200).json({
          ok: true,
          links: (rows || []).map((row) => ({
            provider: row.provider,
            externalId: row.external_id,
            matchMethod: row.match_method,
            lastPushedAt: row.last_pushed_at || null,
            lastError: row.last_error || '',
          })),
        });
      }

      const body = bodyOf(req);
      if (req.method === 'POST' && body.action === 'resync') {
        const provider = await connectedProvider(deps, firestore, uid, body.provider);
        const job = await deps.enqueueLinkAndImport({
          firestore,
          admin,
          uid,
          sellerName: cleanText(decoded.name || decoded.email || 'Pokoin seller', 120),
          provider: provider.id,
        });
        return res.status(200).json({ ok: true, ...job });
      }
      if (req.method === 'POST') {
        const listingId = await ownedListing(deps, uid, body.listingId);
        const provider = await connectedProvider(deps, firestore, uid, body.provider);
        const externalId = cleanText(body.externalId, 160);
        if (!externalId) throw httpError(400, 'Enter the product id on the other platform.', 'external_id_missing');
        await deps.links.upsertLink({
          listingId,
          sellerUid: uid,
          provider: provider.id,
          externalId,
          externalMeta: {},
          matchMethod: 'manual',
        });
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const listingId = await ownedListing(deps, uid, body.listingId || queryOf(req).listingId);
        const providerId = cleanText(body.provider || queryOf(req).provider, 40).toLowerCase();
        if (!deps.providers.getProvider(providerId)) throw httpError(404, 'Unknown platform.', 'platform_unknown');
        await deps.links.deleteLink({ listingId, provider: providerId, sellerUid: uid });
        return res.status(200).json({ ok: true });
      }
      res.setHeader('Allow', 'GET, POST, DELETE');
      return res.status(405).json({ error: 'Method not allowed.' });
    } catch (error) {
      console.error('platform-links failed', {
        code: error.code || '',
        statusCode: error.statusCode || 500,
        message: error.message,
      });
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Platform link request failed.',
        code: error.code,
      });
    }
  };
}

module.exports = createHandler();
module.exports._test = { createHandler };
