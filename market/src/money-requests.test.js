import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canPayRequest,
  newClientToken,
  notificationLine,
  requestIsPending,
  requestStatusLabel,
  unreadNotificationCount,
} from './money-requests.js';

test('request status labels cover the whole machine', () => {
  assert.equal(requestStatusLabel('pending'), 'Requested');
  assert.equal(requestStatusLabel('paid'), 'Paid ✓');
  assert.equal(requestStatusLabel('declined'), 'Declined');
  assert.equal(requestStatusLabel('cancelled'), 'Cancelled');
  assert.equal(requestStatusLabel('expired'), 'Expired');
  assert.equal(requestStatusLabel(undefined), 'Requested');
});

test('only pending incoming requests are payable client-side', () => {
  assert.equal(canPayRequest({ direction: 'incoming', status: 'pending' }), true);
  assert.equal(canPayRequest({ direction: 'incoming', status: 'paid' }), false);
  assert.equal(canPayRequest({ direction: 'outgoing', status: 'pending' }), false);
  assert.equal(canPayRequest(undefined), false);
  assert.equal(requestIsPending({ status: 'pending' }), true);
  assert.equal(requestIsPending({ status: 'declined' }), false);
});

test('unread count and notification lines render human copy', () => {
  assert.equal(unreadNotificationCount([
    { read: false },
    { read: true },
    { read: false },
  ]), 2);
  assert.equal(
    notificationLine({ type: 'money_request_created', actorUsername: 'giuseppe', amountPkn: 125 }),
    '@giuseppe requested 125 PKN',
  );
  assert.equal(
    notificationLine({ type: 'money_request_paid', actorUsername: 'renato', amountPkn: 40 }),
    '@renato paid your 40 PKN request',
  );
  assert.equal(
    notificationLine({ type: 'money_request_declined', actorUsername: '', amountPkn: 5 }),
    'Someone declined your 5 PKN request',
  );
});

test('client tokens are unique strings for idempotent creates', () => {
  const a = newClientToken();
  const b = newClientToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 8);
});
