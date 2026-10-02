'use strict';

process.env.CARDTRADER_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

// The deploy stage has only server/pokoin-api (no ../server helpers, no node_modules).
const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (id === '../server/_firebase') return { getFirebaseAdmin: () => ({}), verifyBearerToken: async () => ({}) };
  if (id === '../server/_marketplace_db') return { marketplaceQuery: async () => ({ rows: [] }) };
  return originalRequire.apply(this, arguments);
};
const { connect, status } = require('./powertools-connect')._test;
const { zeroList } = require('./cardtrader-zero')._test;
Module.prototype.require = originalRequire;

const { createFirestore } = require('./_firestore_fake');
const { encryptSecret } = require('./_cardtrader_crypto');
const {
  cleanSessionToken,
  decryptPowerToolsSession,
  jwtFromSetCookie,
  loginThrottle,
  MAX_FAILED_LOGINS,
  safePowerToolsUser,
} = require('./_powertools_session');

const UID = 'seller-uid';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtSlBLeiJ9.c2lnbmF0dXJl';
const PT_USER = {
  _id: 'mJPKz6l9',
  username: 'seller@example.com',
  assignedCardtraderUser: {
    cardtraderUserId: 594690,
    cardtraderUserName: 'Seller',
    cardtraderApiToken: 'ct-oauth-secret',
    cardtraderRefreshToken: 'ct-refresh-secret',
  },
  pricingStrategies: [{ name: 'x' }],
};

function jsonResponse(status, body, headers = {}) {
  const list = Object.entries(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => list.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || null,
      getSetCookie: () => list.filter(([key]) => key.toLowerCase() === 'set-cookie').map(([, value]) => value),
    },
    text: async () => (body == null ? '' : JSON.stringify(body)),
  };
}

/** Fake Outseta + Power Tools. */
function fakePowerTools({ password = 'right', ptOrders = [], sessionOk = true, twoFactor = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/api/v1/tokens')) {
      const form = new URLSearchParams(init.body);
      if (twoFactor) return jsonResponse(200, { two_factor_required: true, challenge_token: 'c' });
      if (form.get('password') !== password) return jsonResponse(401, { Message: 'bad' });
      return jsonResponse(200, { access_token: 'outseta-access', token_type: 'bearer' });
    }
    if (url.endsWith('/api/auth/login')) {
      assert.deepEqual(JSON.parse(init.body), { accessToken: 'outseta-access' });
      return jsonResponse(200, { ok: true }, { 'set-cookie': `jwt=${JWT}; Domain=.tcgpowertools.com; Path=/; HttpOnly` });
    }
    const cookie = init.headers?.Cookie || '';
    if (!sessionOk || cookie !== `jwt=${JWT}`) return jsonResponse(401, null);
    if (url.endsWith('/api/user')) return jsonResponse(200, PT_USER);
    if (url.endsWith('/api/user/order')) return jsonResponse(200, ptOrders);
    return jsonResponse(404, null);
  };
  return { calls, fetchImpl };
}

function ctSeed(extra = {}) {
  return {
    seller_integrations: {
      [`${UID}__cardtrader`]: {
        enabled: true,
        encryptedToken: encryptSecret('ct-app-token'),
        metadata: { user: { id: '594690', username: 'Seller' } },
      },
      ...extra,
    },
  };
}

test('session token accepts a bare jwt or a pasted cookie string, nothing else', () => {
  assert.equal(cleanSessionToken(JWT), JWT);
  assert.equal(cleanSessionToken(`_ga=1; jwt=${JWT}; AMP=2`), JWT);
  assert.throws(() => cleanSessionToken('my password'), { code: 'powertools_session_invalid' });
});

test('jwt is read from Set-Cookie, a deleted cookie is not a session', () => {
  assert.equal(jwtFromSetCookie(jsonResponse(200, {}, { 'set-cookie': `jwt=${JWT}; Path=/` }).headers), JWT);
  assert.equal(jwtFromSetCookie(jsonResponse(200, {}, { 'set-cookie': 'jwt=deleted; Max-Age=0' }).headers), '');
});

test('Power Tools /api/user never leaks its CardTrader tokens', () => {
  const safe = safePowerToolsUser(PT_USER);
  assert.deepEqual(safe, {
    userId: 'mJPKz6l9',
    username: 'seller@example.com',
    cardtraderUserId: '594690',
    cardtraderUserName: 'Seller',
  });
  assert.doesNotMatch(JSON.stringify(safe), /secret/);
});

test('password sign-in stores only the encrypted session and matches the CardTrader seller', async () => {
  const { admin, firestore } = createFirestore(ctSeed());
  const pt = fakePowerTools();
  const result = await connect({ email: 'seller@example.com', password: 'right' }, UID, {
    admin, firestore, fetchImpl: pt.fetchImpl,
  });
  assert.equal(result.connected, true);
  assert.equal(result.cardtraderMatch, true);
  assert.equal(result.account.username, 'seller@example.com');
  const stored = (await firestore.collection('seller_integrations').doc(`${UID}__powertools`).get()).data();
  const raw = JSON.stringify(stored);
  assert.doesNotMatch(raw, /right/, 'password is never stored');
  assert.doesNotMatch(raw, new RegExp(JWT.split('.')[2]), 'session is stored encrypted');
  assert.doesNotMatch(raw, /ct-oauth-secret|ct-refresh-secret/);
  assert.equal(await decryptPowerToolsSession(firestore, UID), JWT);
});

test('wrong passwords are throttled per Pokoin user', async () => {
  const { admin, firestore } = createFirestore(ctSeed());
  const pt = fakePowerTools();
  for (let i = 0; i < MAX_FAILED_LOGINS; i += 1) {
    await assert.rejects(
      connect({ email: 'seller@example.com', password: 'wrong' }, UID, { admin, firestore, fetchImpl: pt.fetchImpl }),
      { code: 'powertools_invalid_credentials', statusCode: 401 },
    );
  }
  await assert.rejects(
    connect({ email: 'seller@example.com', password: 'right' }, UID, { admin, firestore, fetchImpl: pt.fetchImpl }),
    { code: 'powertools_login_throttled', statusCode: 429 },
  );
  const tokenCalls = pt.calls.filter((call) => call.url.endsWith('/tokens')).length;
  assert.equal(tokenCalls, MAX_FAILED_LOGINS, 'a throttled attempt never reaches Outseta');
  assert.equal(loginThrottle({ loginAttempts: { windowStartMs: 0, failed: 99 } }).blocked, false, 'window expires');
});

test('two-factor accounts are told to paste the session instead', async () => {
  const { admin, firestore } = createFirestore(ctSeed());
  const pt = fakePowerTools({ twoFactor: true });
  await assert.rejects(
    connect({ email: 'seller@example.com', password: 'right' }, UID, { admin, firestore, fetchImpl: pt.fetchImpl }),
    { code: 'powertools_two_factor' },
  );
  const result = await connect({ session: `jwt=${JWT}` }, UID, { admin, firestore, fetchImpl: pt.fetchImpl });
  assert.equal(result.connected, true);
});

test('a pasted session Power Tools rejects is not stored', async () => {
  const { admin, firestore } = createFirestore(ctSeed());
  const pt = fakePowerTools({ sessionOk: false });
  await assert.rejects(
    connect({ session: JWT }, UID, { admin, firestore, fetchImpl: pt.fetchImpl }),
    { statusCode: 401 },
  );
  assert.equal((await status(firestore, UID)).connected, false);
});

test('Zero list: CardTrader is the source, Power Tools state is an overlay', async () => {
  const { admin, firestore } = createFirestore(ctSeed({
    [`${UID}__powertools`]: { enabled: true, encryptedSession: encryptSecret(JWT), metadata: { username: 'seller@example.com' } },
  }));
  const seen = [];
  const fetchSellerOrders = async (token, { state }) => {
    seen.push([token, state]);
    if (state === 'paid') {
      return [
        { id: 900, state: 'paid', via_cardtrader_zero: true, order_items: [{ id: 1, product_id: 501, quantity: 1, name: 'Pikachu' }] },
        { id: 700, state: 'paid', via_cardtrader_zero: false, order_items: [{ id: 5, product_id: 505, quantity: 1 }] },
      ];
    }
    return [{ id: 803, state: 'hub_pending', via_cardtrader_zero: true, order_items: [{ id: 4, product_id: 504, quantity: 2 }] }];
  };
  const queries = [];
  const query = async (text, values) => {
    queries.push(values);
    return { rows: [{ id: 'listing-1', card_id: '7', source_listing_id: 'ct:501', location: 'Box 2' }] };
  };
  const result = await zeroList({
    admin,
    firestore,
    uid: UID,
    deps: {
      fetchSellerOrders,
      query,
      fetchPowerToolsOrders: async (jwt) => {
        assert.equal(jwt, JWT);
        return [{ source: 'Cardtrader', sourceOrderId: '900', state: { state: 'picking' }, articles: [{ sourceArticleId: '1', pickedQuantity: 1 }] }];
      },
    },
  });
  assert.deepEqual(seen.map(([token, state]) => [token, state]).sort(), [['ct-app-token', 'hub_pending'], ['ct-app-token', 'paid']]);
  assert.deepEqual(queries[0][1].sort(), ['ct:501', 'ct:504']);
  assert.equal(result.weekly.length, 1);
  assert.equal(result.weekly[0].items[0].location, 'Box 2');
  assert.equal(result.weekly[0].items[0].powerTools.orderState, 'picking');
  assert.equal(result.totals.pending.units, 2);
  assert.equal(result.powerTools.ok, true);
  assert.equal(result.cardtrader.username, 'Seller');
});

test('Zero list still loads when the Power Tools session expired', async () => {
  const { admin, firestore } = createFirestore(ctSeed({
    [`${UID}__powertools`]: { enabled: true, encryptedSession: encryptSecret(JWT), metadata: {} },
  }));
  const result = await zeroList({
    admin,
    firestore,
    uid: UID,
    deps: {
      fetchSellerOrders: async () => [],
      query: async () => ({ rows: [] }),
      fetchPowerToolsOrders: async () => {
        const error = new Error('expired');
        error.code = 'powertools_session_expired';
        throw error;
      },
    },
  });
  assert.equal(result.powerTools.ok, false);
  assert.equal(result.powerTools.code, 'powertools_session_expired');
  assert.ok((await status(firestore, UID)).sessionExpiredAt);
});

test('Zero list without a CardTrader connection is a 404', async () => {
  const { admin, firestore } = createFirestore({});
  await assert.rejects(zeroList({ admin, firestore, uid: UID, deps: {} }), { statusCode: 404 });
});
