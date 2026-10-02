'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const path = require('node:path');

const TARGET = path.resolve(__dirname, 'poko-connect.js');

function loadHandler(stubs) {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db') {
      return {
        marketplaceQuery: stubs.marketplaceQuery,
        marketplaceWriteQuery: stubs.marketplaceWriteQuery || stubs.marketplaceQuery,
      };
    }
    if (request === './_firebase') {
      return {
        verifyBearerToken: stubs.verifyBearerToken || (async () => ''),
        authErrorResponse: (error) => ({
          statusCode: error.statusCode || 401,
          body: { error: error.message },
        }),
      };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return require(TARGET);
  } finally {
    Module._load = originalLoad;
  }
}

function makeRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function serviceReq(body) {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.POKONTACT_SERVICE_TOKEN || 'svc'}` },
    body,
  };
}

const WRITER_RESULT = (rows) => ({ rows });

function loadTestHelpers() {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db') {
      return { marketplaceQuery: async () => ({ rows: [] }), marketplaceWriteQuery: async () => ({ rows: [] }) };
    }
    if (request === './_firebase') {
      return { verifyBearerToken: async () => '', authErrorResponse: (e) => ({ statusCode: e.statusCode || 401, body: { error: e.message } }) };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return require(TARGET)._test;
  } finally {
    Module._load = originalLoad;
  }
}

test('codes are unambiguous, normalized, and never stored raw', async () => {
  const t = loadTestHelpers();
  for (let i = 0; i < 20; i += 1) {
    const code = t.generateCode();
    assert.equal(code.length, t.CODE_LENGTH);
    assert.match(code, /^[A-HJ-KM-NP-Z2-9]+$/);
    assert.ok(!/[0O1IL]/.test(code));
  }
  assert.equal(t.normalizeCode('pko-ab cd-12'), 'PKOABCD12');
  const hash = t.hashCode('TESTCODE1');
  assert.equal(hash, t.hashCode('TESTCODE1'));
  assert.notEqual(hash, t.hashCode('TESTCODE2'));
  assert.ok(!hash.includes('TESTCODE1'));
});

test('create_code requires a Firebase user and stores only a hash', async () => {
  const writes = [];
  let uid = '';
  const handler = loadHandler({
    verifyBearerToken: async () => uid,
    marketplaceWriteQuery: async (sql, params = []) => {
      writes.push({ sql, params });
      return WRITER_RESULT([{ expires_at: '2026-09-27T20:00:00Z' }]);
    },
  });

  uid = '';
  const denied = makeRes();
  await handler({ method: 'POST', headers: {}, body: { action: 'create_code' } }, denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(writes.length, 0);

  uid = 'firebase-uid-1';
  const res = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer fb-token' }, body: { action: 'create_code' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.code.length, 8);
  assert.equal(res.body.expiresAtMinutes, 15);
  // The raw code never appears in any SQL parameter.
  const insert = writes.find((w) => /insert into poko_telegram_link_codes/.test(w.sql));
  assert.ok(insert);
  assert.ok(!insert.params.includes(res.body.code));
  assert.equal(insert.params[0].length, 64); // sha256 hex
  // Prior codes for the uid are cleared first.
  assert.ok(writes.some((w) => /delete from poko_telegram_link_codes/.test(w.sql)));
});

test('GET is rejected and service actions require the service token', async () => {
  process.env.POKONTACT_SERVICE_TOKEN = 'svc';
  const handler = loadHandler({ marketplaceQuery: async () => WRITER_RESULT([]) });

  const get = makeRes();
  await handler({ method: 'GET', headers: {}, body: null }, get);
  assert.equal(get.statusCode, 405);

  const noToken = makeRes();
  process.env.POKONTACT_SERVICE_TOKEN = '';
  await handler(serviceReq({ action: 'status', telegramUserId: '123' }), noToken);
  assert.equal(noToken.statusCode, 503);
  process.env.POKONTACT_SERVICE_TOKEN = 'svc';

  const badToken = makeRes();
  await handler({ ...serviceReq({ action: 'status' }), headers: { authorization: 'Bearer wrong' } }, badToken);
  assert.equal(badToken.statusCode, 401);

  const unknown = makeRes();
  await handler(serviceReq({ action: 'drop_table' }), unknown);
  assert.equal(unknown.statusCode, 400);
});

test('redeem atomically redeems and relinks one-to-one', async () => {
  const writes = [];
  let redeemRows = [{ firebase_uid: 'firebase-uid-9' }];
  const handler = loadHandler({
    marketplaceWriteQuery: async (sql, params = []) => {
      writes.push({ sql, params });
      if (/update poko_telegram_link_codes/.test(sql)) return WRITER_RESULT(redeemRows);
      return WRITER_RESULT([]);
    },
  });

  const bad = makeRes();
  await handler(serviceReq({ action: 'redeem', code: 'AB' }), bad);
  assert.equal(bad.body.linked, false);
  assert.match(bad.body.error, /code and telegramUserId/);

  const expired = makeRes();
  redeemRows = [];
  await handler(serviceReq({ action: 'redeem', code: 'EXPIRED1', telegramUserId: '555000111' }), expired);
  assert.equal(expired.body.linked, false);
  assert.match(expired.body.error, /invalid, expired/);

  redeemRows = [{ firebase_uid: 'firebase-uid-9' }];
  const res = makeRes();
  await handler(serviceReq({
    action: 'redeem',
    code: 'abcd-wxyz',
    telegramUserId: '555000111',
    telegramUsername: '@raichu_fan',
    telegramDisplayName: 'Raichu Fan',
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.linked, true);
  assert.equal(res.body.firebaseUid, 'firebase-uid-9');
  // Hash lookup, not the raw code.
  const redeemWrite = writes.filter((w) => /update poko_telegram_link_codes/.test(w.sql)).pop();
  assert.equal(redeemWrite.params[0], loadTestHelpers().hashCode('ABCDWXYZ'));
  // One-to-one: other telegram rows for the same uid are removed, upsert keys on telegram id.
  assert.ok(writes.some((w) => /delete from poko_telegram_links/.test(w.sql)));
  const upsert = writes.find((w) => /insert into poko_telegram_links/.test(w.sql));
  assert.match(upsert.sql, /on conflict \(telegram_user_id\)/);
});

test('status and unlink report linked state without leaking other users', async () => {
  const reads = [];
  const writes = [];
  let statusRows = [];
  const handler = loadHandler({
    marketplaceQuery: async (sql, params = []) => {
      reads.push({ sql, params });
      return WRITER_RESULT(statusRows);
    },
    marketplaceWriteQuery: async (sql, params = []) => {
      writes.push({ sql, params });
      return WRITER_RESULT([]);
    },
  });

  const unlinked = makeRes();
  await handler(serviceReq({ action: 'status', telegramUserId: '555000111' }), unlinked);
  assert.equal(unlinked.body.linked, false);

  statusRows = [{ firebase_uid: 'fb-1', telegram_username: 'raichu_fan', telegram_display_name: 'Raichu Fan', linked_at: '2026-09-27' }];
  const linked = makeRes();
  await handler(serviceReq({ action: 'status', telegramUserId: '555000111' }), linked);
  assert.equal(linked.body.linked, true);
  assert.equal(linked.body.firebaseUid, 'fb-1');
  const statusRead = reads[reads.length - 1];
  assert.deepEqual(statusRead.params, ['555000111']);

  const unlinkRes = makeRes();
  await handler(serviceReq({ action: 'unlink', telegramUserId: '555000111' }), unlinkRes);
  assert.equal(unlinkRes.body.linked, false);
  assert.ok(writes.some((w) => /update poko_telegram_links/.test(w.sql) && /unlinked_at = now\(\)/.test(w.sql)));
});

test('discord redeem/status/unlink mirror telegram without cross-channel bleed', async () => {
  process.env.POKONTACT_SERVICE_TOKEN = 'svc';
  const writes = [];
  let statusRows = [];
  const handler = loadHandler({
    verifyBearerToken: async () => 'fb-dc',
    marketplaceQuery: async (sql) => {
      if (/from poko_discord_links/.test(sql)) return WRITER_RESULT(statusRows);
      return WRITER_RESULT([]);
    },
    marketplaceWriteQuery: async (sql, params) => {
      writes.push({ sql, params });
      if (/update poko_telegram_link_codes/.test(sql)) {
        return WRITER_RESULT([{ firebase_uid: 'fb-dc' }]);
      }
      return WRITER_RESULT([]);
    },
  });

  const redeemRes = makeRes();
  await handler(serviceReq({
    action: 'redeem',
    code: 'ABCD2345',
    discordUserId: '999888777',
    discordUsername: 'steelix_fan',
    discordDisplayName: 'Steelix Fan',
  }), redeemRes);
  assert.equal(redeemRes.body.linked, true);
  assert.equal(redeemRes.body.channel, 'discord');
  assert.equal(redeemRes.body.firebaseUid, 'fb-dc');
  assert.ok(writes.some((w) => /insert into poko_discord_links/.test(w.sql)));
  assert.ok(!writes.some((w) => /insert into poko_telegram_links/.test(w.sql)));

  statusRows = [{
    firebase_uid: 'fb-dc',
    discord_username: 'steelix_fan',
    discord_display_name: 'Steelix Fan',
    linked_at: '2026-09-29',
  }];
  const statusRes = makeRes();
  await handler(serviceReq({ action: 'status', discordUserId: '999888777' }), statusRes);
  assert.equal(statusRes.body.linked, true);
  assert.equal(statusRes.body.channel, 'discord');
  assert.equal(statusRes.body.firebaseUid, 'fb-dc');

  const unlinkRes = makeRes();
  await handler(serviceReq({ action: 'unlink', discordUserId: '999888777' }), unlinkRes);
  assert.equal(unlinkRes.body.linked, false);
  assert.ok(writes.some((w) => /update poko_discord_links/.test(w.sql) && /unlinked_at = now\(\)/.test(w.sql)));
});

test('create_code stores the uid from the decoded Firebase token, not the token object', async () => {
  const writes = [];
  const handler = loadHandler({
    verifyBearerToken: async () => ({ uid: 'decoded-uid-7', email: 'x@y.z', firebase: { sign_in_provider: 'google.com' } }),
    marketplaceWriteQuery: async (sql, params = []) => {
      writes.push({ sql, params });
      return WRITER_RESULT([{ expires_at: '2026-10-01T20:00:00Z' }]);
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer fb-token' }, body: { action: 'create_code' } }, res);
  assert.equal(res.statusCode, 200);
  const insert = writes.find((w) => /insert into poko_telegram_link_codes/.test(w.sql));
  assert.equal(insert.params[1], 'decoded-uid-7');
});
