import assert from 'node:assert/strict';
import test from 'node:test';
import { afterPaint, claimedPath, crossGameFullLoad, crossGameHome } from './yield-nav.js';

const here = { origin: 'https://pokoin.com', pathname: '/marketplace' };
const click = (extra = {}) => ({ defaultPrevented: false, button: 0, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...extra });
const anchor = (href, attrs = {}) => ({
  href,
  target: attrs.target || '',
  getAttribute: (name) => (name in attrs ? attrs[name] : null),
  hasAttribute: (name) => name === 'href' ? href != null : name in attrs,
});

test('claims a plain same-origin link to another path', () => {
  assert.equal(claimedPath(click(), anchor('https://pokoin.com/marketplace/en/cards/806390?x=1#shop'), here),
    '/marketplace/en/cards/806390?x=1#shop');
});

test('leaves modified, prevented and non-primary clicks to the browser/router', () => {
  const a = anchor('https://pokoin.com/marketplace/en/cards/1');
  for (const extra of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    assert.equal(claimedPath(click(extra), a, here), '', JSON.stringify(extra));
  }
});

test('leaves external, targeted, download, rel=external and non-http links alone', () => {
  assert.equal(claimedPath(click(), anchor('https://cdn.pokoin.com/x.jpg'), here), '');
  assert.equal(claimedPath(click(), anchor('https://pokoin.com/cart', { target: '_blank' }), here), '');
  assert.equal(claimedPath(click(), anchor('https://pokoin.com/x.zip', { download: '' }), here), '');
  assert.equal(claimedPath(click(), anchor('https://pokoin.com/login', { rel: 'nofollow external' }), here), '');
  assert.equal(claimedPath(click(), anchor('mailto:hi@pokoin.com'), here), '');
  assert.equal(claimedPath(click(), null, here), '');
});

test('same-path links (hash or query only) stay with the router', () => {
  assert.equal(claimedPath(click(), anchor('https://pokoin.com/marketplace#rails'), here), '');
  assert.equal(claimedPath(click(), anchor('https://pokoin.com/marketplace?tab=jp'), here), '');
});

test('another game\'s marketplace home is not given the current slug', () => {
  assert.equal(crossGameHome('/one-piece/marketplace', '/marketplace'), true);
  assert.equal(crossGameHome('/marketplace', '/magic/marketplace'), true);
  assert.equal(crossGameHome('/one-piece/marketplace', '/one-piece/marketplace'), false);
  assert.equal(crossGameHome('/marketplace', '/marketplace/sets/base'), false);
});

test('a different game loads in full unless the target is the marketplace home', () => {
  assert.equal(crossGameFullLoad('/marketplace', '/one-piece/marketplace'), false);
  assert.equal(crossGameFullLoad('/one-piece/marketplace/en/cards/1/x', '/marketplace'), false);
  assert.equal(crossGameFullLoad('/marketplace', '/one-piece/marketplace/search?q=luffy'), true);
  assert.equal(crossGameFullLoad('/riftbound/marketplace', '/riftbound/marketplace/sets/radiance'), false);
  assert.equal(crossGameFullLoad('/marketplace', '/wallet'), false);
});

test('afterPaint runs only the newest pending callback', async () => {
  const ran = [];
  afterPaint(() => ran.push('a'));
  afterPaint(() => ran.push('b'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ran, ['b']);
});
