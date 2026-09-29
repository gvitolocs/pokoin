'use strict';

/**
 * Poko Telegram/Discord ↔ Pokoin profile linking.
 *
 * A signed-in user generates a short-lived code on the website
 * (action: create_code, Firebase bearer) and redeems it from Telegram or
 * Discord with `/connect <code>` (action: redeem, service bearer — Hermes).
 * One Pokoin account maps to at most one Telegram user and one Discord user.
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
  const discordUserId = cleanText(params.discordUserId, 40).replace(/[^0-9]/g, '');
  const channel = discordUserId ? 'discord' : (telegramUserId ? 'telegram' : '');
  if (!code || code.length < 6 || !channel) {
    return { action: 'redeem', linked: false, error: 'code and telegramUserId or discordUserId required' };
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
  if (channel === 'telegram') {
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
  } else {
    const discordUsername = cleanText(params.discordUsername, 60).replace(/^@/, '');
    const discordDisplayName = cleanText(params.discordDisplayName, 80);
    await marketplaceWriteQuery(
      `delete from poko_discord_links
        where firebase_uid = $1 and discord_user_id <> $2`,
      [uid, discordUserId],
    );
    await marketplaceWriteQuery(
      `insert into poko_discord_links (firebase_uid, discord_user_id, discord_username, discord_display_name)
       values ($1, $2, $3, $4)
       on conflict (discord_user_id) do update
          set firebase_uid = excluded.firebase_uid,
              discord_username = excluded.discord_username,
              discord_display_name = excluded.discord_display_name,
              linked_at = now(),
              unlinked_at = null`,
      [uid, discordUserId, discordUsername, discordDisplayName],
    );
  }
  return { action: 'redeem', linked: true, firebaseUid: uid, channel };
}

async function status(params = {}) {
  const telegramUserId = cleanText(params.telegramUserId, 40).replace(/[^0-9]/g, '');
  const discordUserId = cleanText(params.discordUserId, 40).replace(/[^0-9]/g, '');
  if (discordUserId) {
    const rows = await marketplaceQuery(
      `select firebase_uid, discord_username, discord_display_name, linked_at
         from poko_discord_links
        where discord_user_id = $1 and unlinked_at is null
        limit 1`,
      [discordUserId],
    );
    const row = rows.rows?.[0];
    if (!row) return { action: 'status', linked: false, channel: 'discord' };
    return {
      action: 'status',
      linked: true,
      channel: 'discord',
      firebaseUid: row.firebase_uid,
      discordUsername: row.discord_username || '',
      displayName: row.discord_display_name || '',
      linkedAt: row.linked_at,
    };
  }
  if (!telegramUserId) {
    return { action: 'status', linked: false, error: 'telegramUserId or discordUserId required' };
  }
  const rows = await marketplaceQuery(
    `select firebase_uid, telegram_username, telegram_display_name, linked_at
       from poko_telegram_links
      where telegram_user_id = $1 and unlinked_at is null
      limit 1`,
    [telegramUserId],
  );
  const row = rows.rows?.[0];
  if (!row) return { action: 'status', linked: false, channel: 'telegram' };
  return {
    action: 'status',
    linked: true,
    channel: 'telegram',
    firebaseUid: row.firebase_uid,
    telegramUsername: row.telegram_username || '',
    displayName: row.telegram_display_name || '',
    linkedAt: row.linked_at,
  };
}

async function myStatus(uid) {
  const [tg, dc] = await Promise.all([
    marketplaceQuery(
      `select telegram_username, linked_at
         from poko_telegram_links
        where firebase_uid = $1 and unlinked_at is null
        limit 1`,
      [uid],
    ),
    marketplaceQuery(
      `select discord_username, linked_at
         from poko_discord_links
        where firebase_uid = $1 and unlinked_at is null
        limit 1`,
      [uid],
    ),
  ]);
  const telegram = tg.rows?.[0]
    ? { linked: true, username: tg.rows[0].telegram_username || '', linkedAt: tg.rows[0].linked_at }
    : { linked: false };
  const discord = dc.rows?.[0]
    ? { linked: true, username: dc.rows[0].discord_username || '', linkedAt: dc.rows[0].linked_at }
    : { linked: false };
  return {
    action: 'my_status',
    // Back-compat: top-level fields still mean Telegram.
    linked: Boolean(telegram.linked),
    telegramUsername: telegram.username || '',
    linkedAt: telegram.linkedAt || null,
    telegram,
    discord,
  };
}

async function unlinkMe(uid, params = {}) {
  const channel = cleanText(params.channel, 20).toLowerCase();
  if (!channel || channel === 'telegram' || channel === 'all') {
    await marketplaceWriteQuery(
      `update poko_telegram_links
          set unlinked_at = now()
        where firebase_uid = $1 and unlinked_at is null`,
      [uid],
    );
  }
  if (channel === 'discord' || channel === 'all' || !channel) {
    // Default unlink_me (no channel) clears Telegram only for back-compat;
    // pass channel=discord|all for Discord.
    if (channel === 'discord' || channel === 'all') {
      await marketplaceWriteQuery(
        `update poko_discord_links
            set unlinked_at = now()
          where firebase_uid = $1 and unlinked_at is null`,
        [uid],
      );
    }
  }
  return { action: 'unlink_me', linked: false, channel: channel || 'telegram' };
}

async function unlink(params = {}) {
  const telegramUserId = cleanText(params.telegramUserId, 40).replace(/[^0-9]/g, '');
  const discordUserId = cleanText(params.discordUserId, 40).replace(/[^0-9]/g, '');
  if (discordUserId) {
    await marketplaceWriteQuery(
      `update poko_discord_links
          set unlinked_at = now()
        where discord_user_id = $1 and unlinked_at is null`,
      [discordUserId],
    );
    return { action: 'unlink', linked: false, channel: 'discord' };
  }
  if (!telegramUserId) {
    return { action: 'unlink', linked: false, error: 'telegramUserId or discordUserId required' };
  }
  await marketplaceWriteQuery(
    `update poko_telegram_links
        set unlinked_at = now()
      where telegram_user_id = $1 and unlinked_at is null`,
    [telegramUserId],
  );
  return { action: 'unlink', linked: false, channel: 'telegram' };
}

const FIREBASE_ACTIONS = { create_code: createCode, my_status: myStatus, unlink_me: unlinkMe };
const ACTIONS = { redeem, status, unlink };

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

  // Firebase-user actions (website): create_code, my_status, unlink_me.
  if (FIREBASE_ACTIONS[action]) {
    let uid = '';
    try {
      uid = await verifyBearerToken(req);
    } catch {
      uid = '';
    }
    if (!uid) {
      const authError = authErrorResponse({ statusCode: 401, message: 'unauthorized' });
      sendJson(res, authError.statusCode, authError.body);
      return;
    }
    try {
      let result;
      if (action === 'create_code') {
        result = await createCode(uid);
      } else if (action === 'unlink_me') {
        result = await unlinkMe(uid, req.body || {});
      } else {
        result = await FIREBASE_ACTIONS[action](uid);
      }
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      console.error('poko-connect firebase action failed', { action, error: String(error?.message || error).slice(0, 300) });
      sendJson(res, 500, { ok: false, error: 'connect action failed' });
    }
    return;
  }

  // Service-authenticated actions (Telegram / Discord side).
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
    sendJson(res, 400, { error: `unknown action; expected one of ${[...Object.keys(FIREBASE_ACTIONS), ...Object.keys(ACTIONS)].join(', ')}` });
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
  FIREBASE_ACTIONS,
  CODE_LENGTH,
  CODE_TTL_MINUTES,
};
