import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRedirect,
  countRedirectRules,
  headerLines,
  redirectLines,
} from './write-cloudflare-web-routing.mjs';

test('redirect budget stays inside Workers Static Assets limits', () => {
  const counts = countRedirectRules();
  assert.ok(counts.dynamic <= 100, `dynamic ${counts.dynamic}`);
  assert.ok(counts.fixed <= 2000, `static ${counts.fixed}`);
  assert.ok(counts.dynamic > 0);
});

test('game-prefixed private paths 301 to the unprefixed route', () => {
  const lines = redirectLines();
  const wallet = lines.findIndex((line) => line === '/one-piece/wallet /wallet 301');
  const catchAll = lines.findIndex((line) => line === '/one-piece* /market/app 200');
  assert.ok(wallet > 0);
  assert.ok(catchAll > wallet, 'private 301s must precede the game SPA catch-all');

  for (const [from, to] of [
    ['/one-piece/wallet', '/wallet'],
    ['/one-piece/wallet/', '/wallet'],
    ['/magic/ambassadorprogram', '/ambassadorprogram'],
    ['/magic/dashboard', '/dashboard'],
    ['/magic/orders', '/orders'],
    ['/one-piece/profile', '/profile'],
    ['/one-piece/flex', '/flex'],
    ['/yugioh/auth', '/auth'],
    ['/riftbound/cart', '/cart'],
    ['/one-piece/messages', '/messages'],
    ['/one-piece/messages/', '/messages'],
  ]) {
    const hit = applyRedirect(from);
    assert.equal(hit?.code, 301, from);
    assert.equal(hit?.location, to, from);
  }

  const child = applyRedirect('/one-piece/messages/ada');
  assert.equal(child?.code, 301);
  assert.equal(child?.location, '/messages/ada');

  const dash = applyRedirect('/magic/dashboard/scan');
  assert.equal(dash?.code, 301);
  assert.equal(dash?.location, '/dashboard/scan');
});

test('game marketplace and news are not redirected off the prefix', () => {
  const market = applyRedirect('/one-piece/marketplace/en/cards/598560/luffy');
  assert.notEqual(market?.code, 301);
  assert.equal(market?.location, '/market/app');

  const news = applyRedirect('/one-piece/news/op-14');
  assert.notEqual(news?.code, 301);
  assert.equal(applyRedirect('/news/op-14'), null);

  const product = applyRedirect('/one-piece/product/box');
  assert.notEqual(product?.code, 301);
});

test('auth responses ask crawlers not to index', () => {
  const headers = headerLines();
  assert.match(headers, /\/auth\n {2}X-Robots-Tag: noindex, nofollow/);
  assert.match(headers, /\/auth\/\*\n {2}X-Robots-Tag: noindex, nofollow/);
  assert.doesNotMatch(headers, /Disallow/);
});
