import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isGatewayStatus, retriesRequest, withGatewayRetry } from './api-retry.js';
import { isApiRequestPath, isNetworkError, isOriginDownError, isTunnelHtml } from './working-page.js';

// api.js imports browser-only modules; run the real fetchApiText body with an
// injected fetch (same approach as api-c1.test.js).
const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const start = source.indexOf('function fetchApiText(');
const end = source.indexOf('\nfunction parseApiText(', start);
assert.ok(start >= 0 && end > start, 'fetchApiText is present');
const fetchSource = source.slice(start, end);

function apiFetcher(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body ?? '',
      headers: { get: () => '' },
    };
  };
  const deps = {
    fetch,
    gameHeadersForUrl: (_url, headers) => headers,
    gameRequestHeaders: () => ({}),
    gameRequestHeadersFor: () => ({}),
    catalogGameFromUrl: () => '',
    isApiRequestPath,
    isNetworkError,
    isOriginDownError,
    isTunnelHtml,
    isGatewayStatus,
    retriesRequest,
    withGatewayRetry: (attempt, options) => withGatewayRetry(attempt, { ...options, wait: async () => {} }),
  };
  const fetchApiText = new Function(...Object.keys(deps), `${fetchSource}\nreturn fetchApiText;`)(...Object.values(deps));
  return { fetchApiText, calls };
}

const URL_ = 'https://api.pokoin.com/api/poko-connect';
const preflightFailed = () => new TypeError('Failed to fetch');

test('a link-code POST whose preflight hit the down origin is sent again and returns the code', async () => {
  const { fetchApiText, calls } = apiFetcher([preflightFailed(), { status: 502, body: 'Bad Gateway' }, { status: 200, body: '{"code":"ABCD2345"}' }]);
  const { text } = await fetchApiText(URL_, { method: 'POST', retry: true, body: '{"action":"create_code"}' }, '/api/poko-connect');
  assert.equal(JSON.parse(text).code, 'ABCD2345');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].init.body, '{"action":"create_code"}');
  assert.ok(!('retry' in calls[2].init), 'retry is not a fetch option');
});

test('seller settings GET retries a 530 from Cloudflare by default', async () => {
  const { fetchApiText, calls } = apiFetcher([{ status: 530, body: 'error code: 1033' }, { status: 200, body: '{"shipFromCountry":"IT"}' }]);
  const { text } = await fetchApiText('https://api.pokoin.com/api/marketplace-seller-settings', {}, '/api/marketplace-seller-settings');
  assert.equal(JSON.parse(text).shipFromCountry, 'IT');
  assert.equal(calls.length, 2);
});

test('a write without retry: true fails on the first gateway error', async () => {
  const { fetchApiText, calls } = apiFetcher([preflightFailed(), { status: 200, body: '{}' }]);
  await assert.rejects(fetchApiText(URL_, { method: 'POST' }, '/api/poko-connect'), /The network request failed\./);
  assert.equal(calls.length, 1);
});

test('a handler error (401, 500) is answered at once', async () => {
  const { fetchApiText, calls } = apiFetcher([{ status: 401, body: '{"error":"unauthorized"}' }]);
  await assert.rejects(fetchApiText(URL_, { method: 'POST', retry: true }, '/api/poko-connect'), /unauthorized/);
  assert.equal(calls.length, 1);
  const server = apiFetcher([{ status: 500, body: '{"error":"boom"}' }]);
  await assert.rejects(server.fetchApiText('https://api.pokoin.com/api/x', {}, '/api/x'), /boom/);
  assert.equal(server.calls.length, 1);
});

test('three gateway failures in a row still say the network request failed', async () => {
  const { fetchApiText, calls } = apiFetcher([preflightFailed(), preflightFailed(), preflightFailed()]);
  await assert.rejects(fetchApiText(URL_, { method: 'POST', retry: true }, '/api/poko-connect'), /The network request failed\./);
  assert.equal(calls.length, 3);
});
