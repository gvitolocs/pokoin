import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// api.js imports browser-only modules; run its actual wallet senders with an
// injected getJson (same approach as api-c1.test.js).
const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');

function slice(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} is present`);
  return source.slice(start, end).replace(/^export function/, 'function');
}

const transferSource = slice(
  'export function transferAccountBalance(',
  '\n/**\n * Site PKN payout to a 0x address from the bank wallet.',
);
const withdrawSource = slice(
  'export function requestPknWithdraw(',
  '\n/** Credit site PKN after the caller funded the treasury on-chain. */',
);

function sender(functionSource, name) {
  const bodies = [];
  const getJson = async (path, options) => {
    bodies.push({ path, body: JSON.parse(options.body) });
    return { ok: true };
  };
  const fn = new Function('getJson', `${functionSource}\nreturn ${name};`)(getJson);
  return { fn, bodies };
}

test('a balance transfer carries the request id of the intent it was confirmed for', async () => {
  const { fn, bodies } = sender(transferSource, 'transferAccountBalance');
  await fn({ recipientUsername: ' Bob ', amountPkn: '250.4', requestId: '6b1f2a34-0000-4c9d-8f1e-0a1b2c3d4e5f' }, 'tok');
  assert.deepEqual(bodies, [{
    path: '/api/transfer-account-balance',
    body: {
      recipientUsername: 'bob',
      amountPkn: 250,
      requestId: '6b1f2a34-0000-4c9d-8f1e-0a1b2c3d4e5f',
    },
  }]);
  // The id is the caller's, never one the sender invents: a retry of the same
  // intent arrives under the id the server already applied.
  await fn({ recipientUsername: 'bob', amountPkn: 250, requestId: '6b1f2a34-0000-4c9d-8f1e-0a1b2c3d4e5f' }, 'tok');
  assert.deepEqual(bodies[1].body, bodies[0].body);
});

test('a withdrawal carries the request id of the intent it was confirmed for', async () => {
  const { fn, bodies } = sender(withdrawSource, 'requestPknWithdraw');
  await fn({ toAddress: '0xabc', amountPkn: 20, requestId: '00000000-0000-4000-8000-000000000000' }, 'tok');
  assert.deepEqual(bodies[0], {
    path: '/api/request-pkn-withdraw',
    body: {
      toAddress: '0xabc',
      amountPkn: 20,
      requestId: '00000000-0000-4000-8000-000000000000',
    },
  });
});
