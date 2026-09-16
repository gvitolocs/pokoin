import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COOKIE_BANNER_COPY,
  COOKIE_CONSENT_KEY,
  acceptCookieConsent,
  hasCookieConsent,
  isEmbeddedMarketplace,
  readConsentCookie,
  shouldShowCookieBanner,
} from './cookie-consent.js';

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.hasOwn(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
  };
}

test('cookie banner copy names sign-in and cart, not analytics we do not run', () => {
  assert.match(COOKIE_BANNER_COPY, /signed in/i);
  assert.match(COOKIE_BANNER_COPY, /cart/i);
  assert.doesNotMatch(COOKIE_BANNER_COPY, /analytics|advertis/i);
});

test('accepting writes the shared pokoin.cookieConsent flag', () => {
  const store = memoryStore();
  assert.equal(hasCookieConsent(store), false);
  acceptCookieConsent(store);
  assert.equal(store.getItem(COOKIE_CONSENT_KEY), '1');
  assert.equal(hasCookieConsent(store), true);
});

test('consent cookie is treated as accepted when localStorage is empty', () => {
  const store = memoryStore();
  assert.equal(hasCookieConsent(store, 'other=1; pokoin_cookie_consent=1'), true);
  assert.equal(readConsentCookie('pokoin_cookie_consent=1'), '1');
});

test('banner stays hidden in credentialless and framed embeds', () => {
  const store = memoryStore();
  assert.equal(isEmbeddedMarketplace({ credentialless: true, self: {}, top: {} }), true);
  const self = {};
  assert.equal(isEmbeddedMarketplace({ credentialless: false, self, top: {} }), true);
  assert.equal(isEmbeddedMarketplace({ self, top: self }), false);
  assert.equal(shouldShowCookieBanner(store, { credentialless: true, self, top: self }), false);
  assert.equal(shouldShowCookieBanner(store, { credentialless: false, self, top: self }), true);
});
