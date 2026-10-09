import assert from 'node:assert/strict';
import test from 'node:test';
import { afterPaint, claimedPath } from './yield-nav.js';

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

test('afterPaint runs only the newest pending callback', async () => {
  const ran = [];
  afterPaint(() => ran.push('a'));
  afterPaint(() => ran.push('b'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ran, ['b']);
});
