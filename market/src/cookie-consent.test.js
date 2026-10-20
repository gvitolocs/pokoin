import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COOKIE_BANNER_COPY,
  COOKIE_CONSENT_KEY,
  COOKIE_CONSENT_ESSENTIAL,
  acceptCookieConsent,
  hasCookieConsent,
  hasFullCookieConsent,
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

// CookieBanner publishing --cookie-banner-h is guarded in solid/src/components/Chrome.test.js.
test('the chat button and panel sit above the cookie banner instead of covering Accept', async () => {
  const fs = await import('node:fs');
  const dock = fs.readFileSync(new URL('./chat-dock.css', import.meta.url), 'utf8');
  const fab = dock.match(/\.chat-fab \{[^}]*\}/)[0];
  assert.match(fab, /bottom: calc\(1\.1rem \+ var\(--cookie-banner-h, 0px\)\)/);
  assert.match(dock, /bottom: calc\(0\.85rem \+ var\(--cookie-banner-h, 0px\)\)/);
  const panel = dock.match(/\.chat-dock \{[^}]*\}/)[0];
  assert.match(panel, /bottom: var\(--cookie-banner-h, 0px\)/);
});

test('essential-only answers the banner but does not count as full consent', () => {
  const store = memoryStore();
  acceptCookieConsent(store, COOKIE_CONSENT_ESSENTIAL);
  assert.equal(store.getItem(COOKIE_CONSENT_KEY), 'essential');
  assert.equal(hasCookieConsent(store), true);
  assert.equal(hasFullCookieConsent(store), false);
  assert.equal(shouldShowCookieBanner(store, { self: {}, top: null }), false);
  assert.equal(hasFullCookieConsent(memoryStore(), 'pokoin_cookie_consent=essential'), false);
  assert.equal(hasCookieConsent(memoryStore(), 'pokoin_cookie_consent=essential'), true);
  acceptCookieConsent(store);
  assert.equal(hasFullCookieConsent(store), true);
});
