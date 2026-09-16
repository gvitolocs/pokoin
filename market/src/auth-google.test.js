import assert from 'node:assert/strict';
import test from 'node:test';
import {
  googleAuthPopupFailed,
  isAuthFramed,
  topLevelLoginUrl,
} from './auth-google.js';

test('side-panel iframe is framed so Google sign-in must leave the embed', () => {
  assert.equal(isAuthFramed({ self: 1, top: 1 }), false);
  assert.equal(isAuthFramed({ self: 1, top: 2 }), true);
  assert.equal(isAuthFramed({
    get self() { return this; },
    get top() { throw new Error('Blocked a frame with origin'); },
  }), true);
});

test('Firebase popup-blocked is the extension iframe failure', () => {
  assert.equal(googleAuthPopupFailed({ code: 'auth/popup-blocked' }), true);
  assert.equal(googleAuthPopupFailed({ message: 'Firebase: Error (auth/popup-blocked).' }), true);
  assert.equal(googleAuthPopupFailed({ code: 'auth/wrong-password' }), false);
});

test('framed Google sign-in opens top-level /login with from=', () => {
  assert.equal(
    topLevelLoginUrl('https://pokoin.com', '/marketplace/en/cards/470324'),
    'https://pokoin.com/login?from=%2Fmarketplace%2Fen%2Fcards%2F470324',
  );
});
