'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('./_money_request_core.js');

const now = Date.parse('2026-09-19T12:00:00Z');
const request = (extra = {}) => ({ status: 'pending', fromUid: 'a', toUid: 'b', amountPkn: 125, createdAt: now - 1000, ...extra });

test('money requests accept positive whole PKN only', () => {
  assert.deepEqual(core.validateAmountPkn(125), { amount: 125 });
  assert.ok(core.validateAmountPkn(0).error);
  assert.ok(core.validateAmountPkn(1.5).error);
});

test('request create normalises its payload', () => {
  const result = core.validateCreate({ recipientUsername: ' Renato ', amountPkn: 125, note: ' cards ' });
  assert.equal(result.value.toUsername, 'renato');
  assert.equal(result.value.note, 'cards');
});

test('terminal and expired requests cannot pay twice', () => {
  assert.equal(core.canPay(request(), 'b', now).ok, true);
  assert.equal(core.canPay(request({ status: 'paid' }), 'b', now).ok, false);
  assert.equal(core.canPay(request({ createdAt: now - 15 * 86400000 }), 'b', now).ok, false);
  assert.equal(core.canPay(request(), 'c', now).ok, false);
});

test('only recipient declines and only requester cancels', () => {
  assert.equal(core.canRespond(request(), 'b', 'decline', now).ok, true);
  assert.equal(core.canRespond(request(), 'a', 'cancel', now).ok, true);
  assert.equal(core.canRespond(request(), 'c', 'cancel', now).ok, false);
});
