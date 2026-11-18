import assert from 'node:assert/strict';
import test from 'node:test';
import { API_RETRY_DELAYS_MS, isGatewayStatus, retriesRequest, withGatewayRetry } from './api-retry.js';

function gatewayError() {
  const error = new Error('The network request failed.');
  error.gatewayFailure = true;
  return error;
}

const noWait = async () => {};

test('gateway statuses are the tunnel 502 and Cloudflare origin errors, not handler answers', () => {
  for (const status of [502, 520, 522, 524, 530]) assert.ok(isGatewayStatus(status), String(status));
  for (const status of [200, 400, 401, 404, 500, 503, 504]) assert.ok(!isGatewayStatus(status), String(status));
});

test('reads retry by default, writes only when the caller opts in', () => {
  assert.equal(retriesRequest({}), true);
  assert.equal(retriesRequest({ method: 'get' }), true);
  assert.equal(retriesRequest({ method: 'HEAD' }), true);
  assert.equal(retriesRequest({ method: 'POST' }), false);
  assert.equal(retriesRequest({ method: 'POST', retry: true }), true);
  assert.equal(retriesRequest({ method: 'GET', retry: false }), false);
});

test('a preflight the down origin answered is retried and the next pick succeeds', async () => {
  let calls = 0;
  const waits = [];
  const result = await withGatewayRetry(async () => {
    calls += 1;
    if (calls < 3) throw gatewayError();
    return 'code';
  }, { wait: async (ms) => { waits.push(ms); } });
  assert.equal(result, 'code');
  assert.equal(calls, 3);
  assert.deepEqual(waits, API_RETRY_DELAYS_MS);
});

test('gives up after the last delay and throws the gateway error', async () => {
  let calls = 0;
  await assert.rejects(
    withGatewayRetry(async () => { calls += 1; throw gatewayError(); }, { wait: noWait }),
    /The network request failed\./,
  );
  assert.equal(calls, API_RETRY_DELAYS_MS.length + 1);
});

test('handler errors and opted-out requests are not retried', async () => {
  let calls = 0;
  const unauthorized = Object.assign(new Error('unauthorized'), { status: 401 });
  await assert.rejects(withGatewayRetry(async () => { calls += 1; throw unauthorized; }, { wait: noWait }), /unauthorized/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withGatewayRetry(async () => { calls += 1; throw gatewayError(); }, { retry: false, wait: noWait }));
  assert.equal(calls, 1);
});

test('an aborted request stops retrying', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(withGatewayRetry(async () => {
    calls += 1;
    throw gatewayError();
  }, { signal: controller.signal, wait: async () => { controller.abort(); } }));
  assert.equal(calls, 1);
});

test('the real wait ends early when the request is aborted', async () => {
  const controller = new AbortController();
  let calls = 0;
  const started = Date.now();
  const run = withGatewayRetry(async () => { calls += 1; throw gatewayError(); }, { signal: controller.signal, delays: [10_000] });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(run);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 5_000);
});
