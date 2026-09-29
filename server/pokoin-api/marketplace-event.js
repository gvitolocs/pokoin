'use strict';

/**
 * POST /api/marketplace-event — card view / search / click beacons that feed
 * marketplace_card_events (rising rails) and the query-chunk stats.
 *
 * Pokoin-owned copy (was the CardVault handler on the Pi). Writes go to the
 * writer: the Pi's read pool is a hot-standby replica, so every insert failed
 * with "read-only transaction" (808 in 6 h on 2026-09-29). The beacon answers
 * 204 before writing so page views never hold an API slot on the database.
 */
const marketplaceDb = require('./_marketplace_db');
const { recordMarketplaceImage } = require('./_marketplace_image_log');
const { verifyBearerToken } = require('./_firebase');

const WEIGHTS = {
  view: 1,
  search: 2,
  click: 4,
  reserve: 10,
  cart_add: 8,
  sale: 20,
};

const ALLOWED_METADATA_KEYS = new Set([
  'source',
  'query',
  'resultRank',
  'resultCount',
  'language',
  'name',
  'set',
  'number',
  'rarity',
  'type',
  'itemKind',
  'productType',
  'trainerName',
  'tags',
  'imageUrl',
  'homepageImageUrl',
  'ctId',
]);

async function optionalUserUid(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return null;
  }
  try {
    const decoded = await verifyBearerToken(req);
    return typeof decoded.uid === 'string' && decoded.uid.trim()
      ? decoded.uid.trim().slice(0, 128)
      : null;
  } catch (error) {
    console.warn('marketplace-event auth ignored', {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
    return null;
  }
}

function cleanMetadata(value) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [key, rawValue] of Object.entries(source)) {
    if (!ALLOWED_METADATA_KEYS.has(key) || rawValue == null) continue;
    if (typeof rawValue === 'string') {
      const text = rawValue.trim().slice(0, 160);
      if (text) result[key] = text;
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      result[key] = Math.trunc(rawValue);
    } else if (typeof rawValue === 'boolean') {
      result[key] = rawValue;
    } else if (Array.isArray(rawValue)) {
      const values = rawValue
        .map((entry) => String(entry || '').trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 8);
      if (values.length > 0) result[key] = values;
    }
  }
  return result;
}

async function recordEvent(req, cardId, eventType, metadata) {
  const userUid = await optionalUserUid(req);
  recordMarketplaceImage({
    source: 'marketplace-event',
    status: 'navigate',
    cardId,
    ctId: metadata.ctId,
    name: metadata.name,
    route: metadata.source,
    url: metadata.imageUrl || metadata.homepageImageUrl || '',
  });
  const values = [
    cardId,
    eventType,
    WEIGHTS[eventType],
    JSON.stringify(metadata),
  ];
  try {
    await marketplaceDb.marketplaceWriteQuery(
      `
        insert into public.marketplace_card_events (card_id, event_type, weight, metadata, user_uid)
        select resolved.card_id, $2, $3, $4::jsonb, $5
        from (
          select coalesce(
            (
              select c.card_id
              from public.marketplace_cards c
              where c.card_id = $1::bigint or c.ct_id = $1::bigint
              limit 1
            ),
            $1::bigint
          ) as card_id
        ) resolved
      `,
      [...values, userUid],
    );
  } catch (error) {
    if (error.code !== '42703') {
      throw error;
    }
    await marketplaceDb.marketplaceWriteQuery(
      `
        insert into public.marketplace_card_events (card_id, event_type, weight, metadata)
        select resolved.card_id, $2, $3, $4::jsonb
        from (
          select coalesce(
            (
              select c.card_id
              from public.marketplace_cards c
              where c.card_id = $1::bigint or c.ct_id = $1::bigint
              limit 1
            ),
            $1::bigint
          ) as card_id
        ) resolved
      `,
      values,
    );
  }

  const query = typeof metadata.query === 'string' ? metadata.query.trim() : '';
  if (eventType === 'search' && query.length >= 2) {
    await marketplaceDb.marketplaceWriteQuery(
      `
        select public.record_marketplace_query_chunks($1, $2, $3, $4)
      `,
      [
        query,
        typeof metadata.language === 'string' ? metadata.language : 'en',
        eventType,
        WEIGHTS[eventType],
      ],
    ).catch((error) => {
      if (error.code !== '42P01' && error.code !== '42883') {
        throw error;
      }
    });
  }
}

// One warning per minute at most: a writer outage must not flood the Pi log.
let lastFailureLog = 0;
let failuresSinceLog = 0;

function logFailure(error) {
  failuresSinceLog += 1;
  const now = Date.now();
  if (now - lastFailureLog < 60_000) return;
  console.warn('marketplace-event failed', {
    message: error?.message,
    code: error?.code,
    failures: failuresSinceLog,
  });
  lastFailureLog = now;
  failuresSinceLog = 0;
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const cardId = Number(req.body?.cardId);
  const eventType = String(req.body?.eventType || '').trim();
  if (!Number.isSafeInteger(cardId) || cardId <= 0 || !WEIGHTS[eventType]) {
    return res.status(400).json({ error: 'Invalid marketplace event.' });
  }
  const metadata = cleanMetadata({
    ...(req.body?.metadata || {}),
    source: String(req.body?.source || 'web').slice(0, 40),
  });

  res.status(204).end();
  try {
    await recordEvent(req, cardId, eventType, metadata);
  } catch (error) {
    logFailure(error);
  }
  return undefined;
}

module.exports = handler;
module.exports._test = { cleanMetadata, recordEvent, WEIGHTS };
