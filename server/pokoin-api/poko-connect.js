'use strict';

/**
 * Poko Telegram ↔ Pokoin profile linking.
 *
 * A signed-in user generates a short-lived code on the website
 * (action: create_code, Firebase bearer) and redeems it from Telegram with
 * `/connect <code>` (action: redeem, service bearer — called by Hermes).
 * One Pokoin account maps to one Telegram user, in both directions.
 *
 * Raw codes are never stored: the DB keeps SHA-256 hashes with a 15-minute
 * expiry, single redemption. status/unlink are service-authenticated lookups
 * used by Hermes to greet linked users and let them disconnect.
 *
 * Canonical source for the Pi overlay. Deploy with
 * `scripts/deploy-poko-market-api.sh` (ships both poko handlers).
 * Sibling requires come from the live Pi release base.
 */

const crypto = require('node:crypto');

const { marketplaceQuery, marketplaceWriteQuery } = require('./_marketplace_db');
const { authErrorResponse, verifyBearerToken } = require('./_firebase');

// Unambiguous alphabet: no 0/O, 1/I/L.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MINUTES = 15;
const MAX_CODES_PER_UID = 5;

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function hashCode(code) {
  return crypto.createHash('sha256').update(`poko-connect:${code}`).digest('hex');
}

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function serviceToken() {
  // Same shared Poko service secret as the market API (docs/poko-handoff.md).
  return String(process.env.POKO_MARKET_SERVICE_TOKEN || process.env.POKONTACT_SERVICE_TOKEN || '').trim();
}

function timingSafeEqualText(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isServiceAuthorized(req) {
  const expected = serviceToken();
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization || ''));
  if (!match) return false;
  return timingSafeEqualText(match[1].trim(), expected);
}

function cleanText(value, max = 80) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function createCode(uid) {
  const code = generateCode();
  const codeHash = hashCode(code);
  await marketplaceWriteQuery(
    `delete from poko_telegram_link_codes
      where firebase_uid = $1 or expires_at < now()`,
    [uid],
  );
  const inserted = await marketplaceWriteQuery(
    `insert into poko_telegram_link_codes (code_hash, firebase_uid, expires_at)
     values ($1, $2, now() + ($3::int || ' minutes')::interval)
     returning expires_at`,
    [codeHash, uid, CODE_TTL_MINUTES],
  );
  const expiresAt = inserted.rows?.[0]?.expires_at || null;
  return { action: 'create_code', code, expiresAtMinutes: CODE_TTL_MINUTES, expiresAt };
}

async function redeem(params = {}) {
  const code = normalizeCode(params.code);
  const telegramUserId = cleanText(params.telegramUserId, 40).replace(/[^0-9]/g, '');
  if (!code || code.length < 6 || !telegramUserId) {
    return { action: 'redeem', linked: false, error: 'code and telegramUserId required' };
  }
  const redeemed = await marketplaceWriteQuery(
    `update poko_telegram_link_codes
        set redeemed_at = now()
      where code_hash = $1
        and redeemed_at is null
        and expires_at > now()
      returning firebase_uid`,
    [hashCode(code)],
  );
  const uid = redeemed.rows?.[0]?.firebase_uid;
  if (!uid) {
    return { action: 'redeem', linked: false, error: 'code invalid, expired, or already used' };
  }
  const telegramUsername = cleanText(params.telegramUsername, 60).replace(/^@/, '');
  const telegramDisplayName = cleanText(params.telegramDisplayName, 80);
  await marketplaceWriteQuery(
    `delete from poko_telegram_links
      where firebase_uid = $1 and telegram_user_id <> $2`,
    [uid, telegramUserId],
  );
  await marketplaceWriteQuery(
    `insert into poko_telegram_links (firebase_uid, telegram_user_id, telegram_username, telegram_display_name)
     values ($1, $2, $3, $4)
     on conflict (telegram_user_id) do update
        set firebase_uid = excluded.firebase_uid,
            telegram_username = excluded.telegram_username,
            telegram_display_name = excluded.telegram_display_name,
            linked_at = now(),
            unlinked_at = null`,
    [uid, telegramUserId, telegramUsername, telegramDisplayName],
  );
  return { action: 'redeem', linked: true, firebaseUid: uid };
}

async function status(params = {}) {
  const telegramUserId = cleanText(params.telegramUserId, 40).replace(/[^0-9]/g, '');
  if (!telegramUserId) {
    return { action: 'status', linked: false, error: 'telegramUserId required' };
  }
  const rows = await marketplaceQuery(
    `select firebase_uid, telegram_username, telegram_display_name, linked_at
       from poko_telegram_links
      where telegram_user_id = $1 and unlinked_at is null
      limit 1`,
    [telegramUserId],
  );
  const row = rows.rows?.[0];
  if (!row) return { action: 'status', linked: false };
  return {
    action: 'status',
    linked: true,
    firebaseUid: row.firebase_uid,
    telegramUsername: row.telegram_username || '',
    displayName: row.telegram_display_name || '',
    linkedAt: row.linked_at,
  };
}

async function unlink(params = {}) {
  const telegramUserId = cleanText(params.telegramUserId, 40).replace(/[^0-9]/g, '');
  if (!telegramUserId) {
    return { action: 'unlink', linked: false, error: 'telegramUserId required' };
  }
  await marketplaceWriteQuery(
    `update poko_telegram_links
        set unlinked_at = now()
      where telegram_user_id = $1 and unlinked_at is null`,
    [telegramUserId],
  );
  return { action: 'unlink', linked: false };
}

const ACTIONS = { create_code: createCode, redeem, status, unlink };

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, body) {
  res.status(statusCode).json(body);
}

module.exports = async function handler(req, res) {
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    sendJson(res, 405, { error: 'POST only' });
    return;
  }
  const action = cleanText(req.body?.action, 20);

  if (action === 'create_code') {
    let uid = '';
    try {
      uid = await verifyBearerToken(req);
    } catch (error) {
      const authError = authErrorResponse({ statusCode: 401, message: 'unauthorized' });
      sendJson(res, authError.statusCode, authError.body);
      return;
    }
    if (!uid) {
      const authError = authErrorResponse({ statusCode: 401, message: 'unauthorized' });
      sendJson(res, authError.statusCode, authError.body);
      return;
    }
    try {
      sendJson(res, 200, { ok: true, ...(await createCode(uid)) });
    } catch (error) {
      console.error('poko-connect create_code failed', { error: String(error?.message || error).slice(0, 300) });
      sendJson(res, 500, { ok: false, error: 'could not create link code' });
    }
    return;
  }

  // Service-authenticated actions (Telegram-side).
  if (!serviceToken()) {
    sendJson(res, 503, { error: 'poko-connect not configured: service token missing' });
    return;
  }
  if (!isServiceAuthorized(req)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  const run = ACTIONS[action];
  if (!run || action === 'create_code') {
    sendJson(res, 400, { error: `unknown action; expected one of ${Object.keys(ACTIONS).join(', ')}` });
    return;
  }
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const result = await run(params);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    console.error('poko-connect action failed', { action, error: String(error?.message || error).slice(0, 300) });
    sendJson(res, 500, { ok: false, error: 'connect action failed' });
  }
};

module.exports._test = {
  normalizeCode,
  hashCode,
  generateCode,
  isServiceAuthorized,
  serviceToken,
  ACTIONS,
  CODE_LENGTH,
  CODE_TTL_MINUTES,
};
