import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestIds, newRequestId, walletIntent } from './wallet-request-id.js';

const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('the request id of one intent survives every send of that intent', () => {
  const ids = createRequestIds();
  const intent = walletIntent('transfer', 'bob', 250);
  const first = ids.idFor(intent);
  assert.match(first, IS_UUID);
  // The answer never arrived, so the user presses Send again: same intent, same id.
  assert.equal(ids.idFor(intent), first);
  assert.equal(ids.idFor(walletIntent('transfer', ' BOB ', '250')), first);
});

test('an intent the user changed is a new request with a new id', () => {
  const ids = createRequestIds();
  const sent = ids.idFor(walletIntent('transfer', 'bob', 250));
  // Another recipient, another amount, or another action is another request, so
  // it cannot ride on the id of the one already sent.
  assert.notEqual(ids.idFor(walletIntent('transfer', 'carol', 250)), sent);
  const amount = ids.idFor(walletIntent('transfer', 'bob', 251));
  assert.notEqual(amount, sent);
  assert.notEqual(ids.idFor(walletIntent('withdraw', '0xabc', 250)), amount);
});

test('a landed intent spends its id so the next press names a new one', () => {
  const ids = createRequestIds();
  const intent = walletIntent('transfer', 'bob', 250);
  const sent = ids.idFor(intent);
  ids.settle();
  assert.notEqual(ids.idFor(intent), sent);
});

test('an intent is named by its target and its whole PKN amount', () => {
  assert.equal(walletIntent('transfer', ' Bob ', '250.4'), 'transfer|bob|250');
  assert.equal(walletIntent('withdraw', '0xAbC', 250), 'withdraw|0xabc|250');
  assert.equal(walletIntent('transfer', 'bob', ''), 'transfer|bob|0');
});

test('every intent gets its own id', () => {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const id = newRequestId();
    assert.match(id, IS_UUID);
    assert.equal(id.length, 36);
    seen.add(id);
  }
  assert.equal(seen.size, 200);
});

test('a page without randomUUID still mints a valid request id', () => {
  // A page served outside a secure context has no randomUUID to borrow.
  const minted = globalThis.crypto.randomUUID;
  try {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    const id = newRequestId();
    assert.match(id, IS_UUID, id);
    assert.notEqual(id, newRequestId());
  } finally {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: minted, configurable: true });
  }
});
