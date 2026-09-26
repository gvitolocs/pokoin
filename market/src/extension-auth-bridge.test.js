import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXTENSION_AUTH_PATH,
  EXTENSION_AUTH_REQUEST,
  EXTENSION_DESK_SESSION,
  EXTENSION_DESK_SESSION_REQUEST,
  extensionAuthTokenPayload,
  framedByChromeExtension,
  isTrustedDeskSessionEvent,
  publicApiUrl,
  isExtensionAuthRequest,
  isExtensionDeskSession,
  isExtensionDeskSessionRequest,
} from './extension-auth-bridge.js';

test('extension auth request is the Chrome content-script shape', () => {
  assert.equal(isExtensionAuthRequest({
    type: EXTENSION_AUTH_REQUEST,
    source: 'pokemon-card-extension',
  }), true);
  assert.equal(isExtensionAuthRequest({ type: EXTENSION_AUTH_REQUEST }), false);
  assert.equal(isExtensionAuthRequest({ source: 'pokemon-card-extension' }), false);
});

test('token payload uses accessToken for pokoin-auth-bridge.js', () => {
  const payload = extensionAuthTokenPayload(
    { uid: 'u1', email: 'a@pokoin.com' },
    'x'.repeat(24),
    { expirationTime: '2099-01-01T00:00:00.000Z' },
  );
  assert.equal(payload.type, 'pokoin-auth-token');
  assert.equal(payload.ok, true);
  assert.equal(payload.token.accessToken.length, 24);
  assert.equal(payload.token.uid, 'u1');
  assert.equal(payload.token.email, 'a@pokoin.com');
  assert.equal(payload.token.expiresAt, '2099-01-01T00:00:00.000Z');
  assert.equal(extensionAuthTokenPayload(null, 'short'), null);
  assert.equal(EXTENSION_AUTH_PATH, '/extension/auth-bridge');
});

test('framedByChromeExtension is false outside a browser frame', () => {
  assert.equal(framedByChromeExtension(), false);
  const top = { credentialless: false, document: { referrer: '' } };
  top.self = top;
  top.top = top;
  assert.equal(framedByChromeExtension(top), false);
});

test('framedByChromeExtension detects the credentialless side-panel iframe', () => {
  assert.equal(framedByChromeExtension({ credentialless: true }), true);
  assert.equal(framedByChromeExtension({
    credentialless: false,
    location: { ancestorOrigins: ['chrome-extension://abcdefghijklmnopqrstuvwxyz123456'] },
  }), true);
  assert.equal(framedByChromeExtension({
    credentialless: false,
    location: { search: '?pokoin_embed=1', ancestorOrigins: [] },
  }), true);
  const self = { document: { referrer: '' } };
  self.self = self;
  self.top = {};
  assert.equal(framedByChromeExtension(self), true);
});

test('desk session tokens are accepted only from the framing extension', () => {
  const parent = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const win = { location: { origin: 'https://pokoin.com', ancestorOrigins: [parent] } };
  assert.equal(isTrustedDeskSessionEvent({ origin: parent }, win), true);
  assert.equal(isTrustedDeskSessionEvent({ origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }, win), false);
  assert.equal(isTrustedDeskSessionEvent({ origin: parent }, { location: { ancestorOrigins: [] } }), false);
  assert.equal(isTrustedDeskSessionEvent({ origin: 'https://pokoin.com' }, win), true);
  assert.equal(isTrustedDeskSessionEvent({ origin: 'https://evil.example' }, win), false);
});

test('publicApiUrl uses api.pokoin.com inside the side-panel iframe', () => {
  assert.equal(publicApiUrl('/api/marketplace-expansion-page?limit=500'), '/api/marketplace-expansion-page?limit=500');
  assert.equal(
    publicApiUrl('/api/marketplace-expansion-page?limit=500', { credentialless: true }),
    'https://api.pokoin.com/api/marketplace-expansion-page?limit=500',
  );
  assert.equal(
    publicApiUrl('/api/healthz', { location: { search: '?pokoin_embed=1' } }),
    'https://api.pokoin.com/api/healthz',
  );
  assert.equal(publicApiUrl('/marketplace', { credentialless: true }), '/marketplace');
});

test('desk session messages carry the extension token into a credentialless iframe', () => {
  assert.equal(isExtensionDeskSession({
    type: EXTENSION_DESK_SESSION,
    source: 'pokemon-card-extension',
    token: 'z'.repeat(24),
    uid: 'desk-user',
  }), true);
  assert.equal(isExtensionDeskSession({
    type: EXTENSION_DESK_SESSION,
    source: 'pokemon-card-extension',
    token: 'z'.repeat(24),
  }), false);
  assert.equal(isExtensionDeskSessionRequest({
    type: EXTENSION_DESK_SESSION_REQUEST,
    source: 'pokoin-web',
  }), true);
  assert.equal(isExtensionDeskSessionRequest({
    type: EXTENSION_DESK_SESSION_REQUEST,
    source: 'pokemon-card-extension',
  }), false);
});
