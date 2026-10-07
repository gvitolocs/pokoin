'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  BASE_URL,
  oauthHeader,
  authorizeUrl,
  exchangeRequestToken,
  fetchSoldItems,
  listInventory,
  adjustStock,
} = require('./cardmarket');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(payload && payload.__headers ? payload.__headers : {}),
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function xmlResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => text,
  };
}

function createFetch(handler) {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    const record = { url: String(url), options: options || {} };
    calls.push(record);
    return handler(record, calls.length - 1);
  };
  return { fetchFn, calls };
}

const ENV = { CARDMARKET_APP_TOKEN: 'app-token', CARDMARKET_APP_SECRET: 'app-secret' };

function ctxWith(fetchFn, credentials = { accessToken: 'acc-token', accessSecret: 'acc-secret' }) {
  return { credentials, metadata: {}, env: ENV, fetchFn };
}

/** The RFC3986 encoding the adapter promises, recomputed in the test. */
function enc(value) {
  return encodeURIComponent(String(value)).replace(
    /[!*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function headerParams(authorization) {
  const header = String(authorization || '');
  return Object.fromEntries(
    [...header.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], decodeURIComponent(match[2])]),
  );
}

// ---------------------------------------------------------------------------
// OAuth 1.0a header
// ---------------------------------------------------------------------------

test('oauthHeader builds the documented base string (sorted params, realm without query)', () => {
  const url = `${BASE_URL}/output.json/account?foo=bar`;
  const header = oauthHeader({
    method: 'GET',
    url,
    appToken: 'app-token',
    appSecret: 'app-secret',
    accessToken: 'acc-token',
    accessSecret: 'acc-secret',
    nonce: 'abc123',
    timestamp: '1700000000',
  });

  // Independent expected value from the documented base string.
  const base = `${BASE_URL}/output.json/account`;
  const pairs = [
    `oauth_consumer_key=${enc('app-token')}`,
    `oauth_nonce=${enc('abc123')}`,
    `oauth_signature_method=${enc('HMAC-SHA1')}`,
    `oauth_timestamp=${enc('1700000000')}`,
    `oauth_token=${enc('acc-token')}`,
    `oauth_version=${enc('1.0')}`,
    `foo=${enc('bar')}`,
  ].sort();
  const baseString = `GET&${enc(base)}&${enc(pairs.join('&'))}`;
  const signature = crypto
    .createHmac('sha1', `${enc('app-secret')}&${enc('acc-secret')}`)
    .update(baseString)
    .digest('base64');

  assert.ok(header.startsWith(`OAuth realm="${base}"`), header);
  assert.match(header, /oauth_consumer_key="app-token"/);
  assert.match(header, /oauth_nonce="abc123"/);
  assert.match(header, /oauth_signature_method="HMAC-SHA1"/);
  assert.match(header, /oauth_timestamp="1700000000"/);
  assert.match(header, /oauth_token="acc-token"/);
  assert.match(header, /oauth_version="1.0"/);
  assert.ok(header.includes(`oauth_signature="${enc(signature)}"`), header);
  assert.ok(!header.includes('?foo=bar'), 'realm must not carry the query string');

  // The query params are part of the signed base string.
  const withoutQuery = oauthHeader({
    method: 'GET',
    url: `${BASE_URL}/output.json/account`,
    appToken: 'app-token',
    appSecret: 'app-secret',
    accessToken: 'acc-token',
    accessSecret: 'acc-secret',
    nonce: 'abc123',
    timestamp: '1700000000',
  });
  assert.notEqual(withoutQuery, header);
});

test('authorizeUrl points at the widget app token', () => {
  assert.equal(authorizeUrl({ env: ENV }), `${BASE_URL}/authenticate/app-token`);
});

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

test('exchangeRequestToken uses the request token and an empty secret', async () => {
  const { fetchFn, calls } = createFetch((call) => {
    if (call.url.endsWith('/output.json/access')) {
      return jsonResponse(200, { oauth_token: 'ACCESS', oauth_token_secret: 'SECRET' });
    }
    if (call.url.endsWith('/output.json/account')) {
      return jsonResponse(200, { account: { username: 'seller', idUser: 12345, country: 'IT' } });
    }
    throw new Error(`unexpected url ${call.url}`);
  });

  const result = await exchangeRequestToken(ctxWith(fetchFn, {}), 'REQ-TOKEN');

  assert.deepEqual(result.credentials, { accessToken: 'ACCESS', accessSecret: 'SECRET' });
  assert.deepEqual(result.metadata, { username: 'seller', idUser: '12345', country: 'IT' });

  const access = calls[0];
  const accessUrl = `${BASE_URL}/output.json/access`;
  assert.equal(access.options.method, 'POST');
  assert.equal(access.options.headers['Content-Type'], 'application/xml');
  assert.match(access.options.body, /<app_key>app-token<\/app_key>/);
  assert.match(access.options.body, /<request_token>REQ-TOKEN<\/request_token>/);

  // Signature recomputed with oauth_token = request token and EMPTY secret.
  const params = headerParams(access.options.headers.Authorization);
  assert.equal(params.oauth_token, 'REQ-TOKEN');
  assert.equal(params.realm, accessUrl);
  const pairs = [
    `oauth_consumer_key=${enc('app-token')}`,
    `oauth_nonce=${enc(params.oauth_nonce)}`,
    `oauth_signature_method=${enc('HMAC-SHA1')}`,
    `oauth_timestamp=${enc(params.oauth_timestamp)}`,
    `oauth_token=${enc('REQ-TOKEN')}`,
    `oauth_version=${enc('1.0')}`,
  ].sort();
  const baseString = `POST&${enc(accessUrl)}&${enc(pairs.join('&'))}`;
  const expected = crypto
    .createHmac('sha1', `${enc('app-secret')}&`)
    .update(baseString)
    .digest('base64');
  assert.equal(params.oauth_signature, expected);

  const account = calls[1];
  assert.equal(accountUrl(account.url), `${BASE_URL}/output.json/account`);
  assert.equal(headerParams(account.options.headers.Authorization).oauth_token, 'ACCESS');
});

function accountUrl(url) {
  return String(url).split('?')[0];
}

// ---------------------------------------------------------------------------
// Sold items
// ---------------------------------------------------------------------------

test('fetchSoldItems reads paid and cancelled orders with 206 pagination', async () => {
  const { fetchFn, calls } = createFetch((call) => {
    if (call.url.includes('/orders/1/2')) {
      if (call.url.endsWith('start=1')) {
        return jsonResponse(206, {
          order: [{
            idOrder: 100,
            state: { datePaid: '2026-02-02T00:00:00Z' },
            article: [{ idArticle: 1, idProduct: 9, count: 2, price: '3.50' }],
          }],
        });
      }
      return jsonResponse(200, {
        order: [{
          idOrder: 101,
          state: { datePaid: '2026-02-03T00:00:00Z' },
          article: [{ idArticle: 2, idProduct: 10, count: 1, price: '1.00' }],
        }],
      });
    }
    if (call.url.includes('/orders/1/128')) {
      return jsonResponse(200, {
        order: [{
          idOrder: 200,
          state: { dateCanceled: '2026-02-04T00:00:00Z' },
          article: [{ idArticle: 3, idProduct: 11, count: 1, price: '2.00' }],
        }],
      });
    }
    return jsonResponse(204, {});
  });

  const result = await fetchSoldItems(ctxWith(fetchFn), { since: '2026-02-01T00:00:00Z' });

  assert.equal(result.complete, true);
  assert.equal(result.sales.length, 2);
  assert.equal(result.cancels.length, 1);
  assert.deepEqual(result.sales[0], {
    orderId: '100',
    itemId: '1',
    externalId: '1',
    idProduct: '9',
    quantity: 2,
    unitPriceCents: 350,
    currency: 'EUR',
    soldAt: '2026-02-02T00:00:00Z',
  });
  assert.equal(result.cancels[0].orderId, '200');
  assert.equal(result.cancels[0].soldAt, '2026-02-04T00:00:00Z');
  assert.ok(calls.some((call) => call.url.endsWith('start=101')));
});

test('fetchSoldItems treats HTTP 204 as an empty read', async () => {
  const { fetchFn } = createFetch(() => jsonResponse(204, {}));
  const result = await fetchSoldItems(ctxWith(fetchFn), { since: '2026-02-01T00:00:00Z' });
  assert.deepEqual(result, { complete: true, sales: [], cancels: [] });
});

// ---------------------------------------------------------------------------
// Inventory + adjust
// ---------------------------------------------------------------------------

test('listInventory shapes MKM stock articles', async () => {
  const { fetchFn, calls } = createFetch(() => jsonResponse(200, {
    article: [{
      idArticle: 7,
      idProduct: 42,
      count: 4,
      price: '2.50',
      condition: 'NM',
      isFoil: true,
      language: { languageName: 'English' },
      product: { enName: 'Pikachu', expansion: 'Base Set', nr: '58' },
    }],
  }));

  const result = await listInventory(ctxWith(fetchFn));

  assert.equal(result.complete, true);
  assert.equal(calls[0].url, `${BASE_URL}/output.json/stock`);
  assert.deepEqual(result.items, [{
    externalId: '7',
    sku: '',
    name: 'Pikachu',
    setName: 'Base Set',
    collectorNumber: '58',
    condition: 'NM',
    language: 'English',
    foil: true,
    quantity: 4,
    priceCents: 250,
    currency: 'EUR',
    meta: { idProduct: '42' },
  }]);
});

test('adjustStock chooses decrease or increase and maps a refusal', async () => {
  const decrease = createFetch(() => xmlResponse(200, ''));
  const down = await adjustStock(ctxWith(decrease.fetchFn), {
    link: { external_id: '555' },
    delta: -2,
  });
  assert.deepEqual(down, { ok: true });
  assert.equal(decrease.calls[0].options.method, 'PUT');
  assert.match(decrease.calls[0].url, /\/output\.json\/stock\/decrease$/);
  assert.match(decrease.calls[0].options.body, /<idArticle>555<\/idArticle>/);
  assert.match(decrease.calls[0].options.body, /<count>2<\/count>/);

  const increase = createFetch(() => xmlResponse(200, ''));
  const up = await adjustStock(ctxWith(increase.fetchFn), {
    link: { external_id: '555' },
    delta: 3,
  });
  assert.deepEqual(up, { ok: true });
  assert.match(increase.calls[0].url, /\/output\.json\/stock\/increase$/);
  assert.match(increase.calls[0].options.body, /<count>3<\/count>/);

  const refused = createFetch(() => xmlResponse(200, '<response><notDecreased>2</notDecreased></response>'));
  const bad = await adjustStock(ctxWith(refused.fetchFn), {
    link: { external_id: '555' },
    delta: -2,
  });
  assert.deepEqual(bad, { ok: false, error: 'cardmarket_refused' });
});

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

test('missing app env is 503 platform_unavailable', async () => {
  const ctx = { credentials: {}, metadata: {}, env: {}, fetchFn: async () => jsonResponse(200, {}) };
  const unavailable = (error) => error.statusCode === 503 && error.code === 'platform_unavailable';
  await assert.rejects(async () => authorizeUrl(ctx), unavailable);
  await assert.rejects(async () => fetchSoldItems(ctx, { since: '' }), unavailable);
  await assert.rejects(async () => listInventory(ctx), unavailable);
  await assert.rejects(async () => adjustStock(ctx, { link: { external_id: '1' }, delta: -1 }), unavailable);
});
