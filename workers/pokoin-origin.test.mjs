import assert from 'node:assert/strict';
import test from 'node:test';
import { allowExtensionDeskFrame, isExtensionFramePath, isMarketplaceDeskPath, isMarketplaceSellerPath, originDeskRequest } from './pokoin-origin.js';

test('marketplace desk paths are the Pokoin card pages', () => {
  assert.equal(isMarketplaceDeskPath('/marketplace/en/cards/548832'), true);
  assert.equal(isMarketplaceDeskPath('/marketplace/en/cards/548832/mew-ex'), true);
  assert.equal(isMarketplaceDeskPath('/marketplace/en'), false);
  assert.equal(isMarketplaceDeskPath('/api/marketplace-home'), false);
});

test('side-panel iframe may open seller and account pages, not only card desks', () => {
  assert.equal(isMarketplaceSellerPath('/marketplace/en/users/giuseppe'), true);
  assert.equal(isExtensionFramePath('/marketplace/en/cards/548832'), true);
  assert.equal(isExtensionFramePath('/marketplace/en/users/giuseppe'), true);
  assert.equal(isExtensionFramePath('/profile'), true);
  assert.equal(isExtensionFramePath('/auth'), true);
  assert.equal(isExtensionFramePath('/cart/'), true);
  assert.equal(isExtensionFramePath('/api/marketplace-listings'), false);
  assert.equal(isExtensionFramePath('/marketplace'), false);
  assert.equal(isExtensionFramePath('/marketplace/'), false);
  assert.equal(isExtensionFramePath('/marketplace/en/pokemon'), false);
  assert.equal(isExtensionFramePath('/marketplace/search'), false);
  assert.equal(isExtensionFramePath('/marketplace/sets/base-set'), false);
});

test('desk responses drop SAMEORIGIN and allow chrome-extension frames', () => {
  const framed = allowExtensionDeskFrame(new Response('<html></html>', {
    status: 200,
    headers: {
      'Content-Type': 'text/html',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "default-src 'self'",
    },
  }));
  assert.equal(framed.headers.get('X-Frame-Options'), null);
  assert.match(framed.headers.get('Content-Security-Policy'), /frame-ancestors 'self' chrome-extension:/);
  assert.doesNotMatch(framed.headers.get('Content-Security-Policy'), /SAMEORIGIN/i);
  assert.equal(framed.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
  assert.equal(framed.headers.get('x-pokoin-extension-frame'), '1');
});

test('POKOIN_EXTENSION_IDS pins frame-ancestors to those extensions', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  const framed = allowExtensionDeskFrame(new Response('<html></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  }), { POKOIN_EXTENSION_IDS: `${id}, not-an-id` });
  assert.equal(
    framed.headers.get('Content-Security-Policy'),
    `frame-ancestors 'self' chrome-extension://${id}`,
  );
});

test('desk origin fetches drop chrome-extension iframe referers', () => {
  const inbound = originDeskRequest(new Request('https://pokoin.com/marketplace/en/cards/548832', {
    headers: {
      Referer: 'chrome-extension://abcdefghijklmnopqrstuvwxyz123456/ui-pages/sidepanel.html',
      'Sec-Fetch-Dest': 'iframe',
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'en',
    },
  }));
  assert.equal(inbound.headers.get('Referer'), null);
  assert.equal(inbound.headers.get('Sec-Fetch-Dest'), null);
  assert.equal(inbound.headers.get('User-Agent'), 'Mozilla/5.0');
});
