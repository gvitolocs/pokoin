import test from 'node:test';
import assert from 'node:assert/strict';
import { chatPersonName, chatPersonPhoto, eventAriaLabel, requestActionFor, timestampMs } from './chat-format.js';

test('Firestore timestamps are normalized', () => {
  assert.equal(timestampMs({ seconds: 12 }), 12000);
  assert.equal(timestampMs({ _seconds: 9 }), 9000);
});

test('only pending requests expose a financial action', () => {
  assert.equal(requestActionFor({ type: 'money_request', requestStatus: 'pending', mine: false }), 'pay');
  assert.equal(requestActionFor({ type: 'money_request', requestStatus: 'pending', mine: true }), 'cancel');
  assert.equal(requestActionFor({ type: 'money_request', requestStatus: 'paid' }), '');
});

test('a conversation shows the display name and photo ahead of the handle', () => {
  assert.equal(chatPersonName({ peerDisplayName: 'Marco Rossi', peerUsername: 'redshakkio' }), 'Marco Rossi');
  assert.equal(chatPersonName({ peerUsername: 'redshakkio' }), 'redshakkio');
  assert.equal(chatPersonName(null), 'Pokoin user');
  assert.equal(chatPersonPhoto({ peerPhotoUrl: 'https://cdn.example/a.jpg' }), 'https://cdn.example/a.jpg');
  assert.equal(chatPersonPhoto(null), '');
});

test('typed events have meaningful accessible labels', () => {
  assert.equal(eventAriaLabel({ type: 'payment', amountPkn: 5, mine: false }), 'You received 5 PKN');
  assert.match(eventAriaLabel({ type: 'money_request', amountPkn: 8, requestStatus: 'declined' }), /declined/);
});
