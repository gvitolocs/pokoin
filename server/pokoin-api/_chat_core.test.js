'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('./_chat_core.js');

test('direct conversation keys are canonical and delimiter-safe', () => {
  assert.equal(core.pairKeyFor('uid__a', 'uid_b'), core.pairKeyFor('uid_b', 'uid__a'));
  assert.match(core.pairKeyFor('a', 'b'), /^direct_[a-f0-9]{64}$/);
  assert.throws(() => core.pairKeyFor('a', 'a'));
});

test('membership and unread state use the authoritative member list', () => {
  const members = ['a', 'b'];
  assert.equal(core.isParticipant(members, 'a'), true);
  assert.equal(core.isParticipant(members, 'c'), false);
  assert.equal(core.otherMember(members, 'a'), 'b');
  assert.deepEqual(core.bumpUnread({}, members, 'a'), { a: 0, b: 1 });
});

test('event previews are human readable', () => {
  assert.equal(core.previewForEvent({ type: 'text', text: 'hello' }, 'a'), 'hello');
  assert.equal(core.previewForEvent({ type: 'money_request', amountPkn: 125, senderUid: 'b' }, 'a'), 'Requested 125 PKN');
  assert.equal(core.previewForEvent({ type: 'payment', amountPkn: 20, senderUid: 'a' }, 'a'), 'You sent 20 PKN');
});

test('client operation ids are stable per user and token', () => {
  assert.equal(core.operationId('a', 'retry-1'), core.operationId('a', 'retry-1'));
  assert.notEqual(core.operationId('a', 'retry-1'), core.operationId('b', 'retry-1'));
  assert.equal(core.operationId('a', ''), '');
});
