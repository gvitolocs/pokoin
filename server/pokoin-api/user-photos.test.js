'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parsePhotoKey, authRedirect, publicApiHost, wantsHtml } = require('./user-photos')._test;

test('parsePhotoKey accepts chat and listing keys only', () => {
  assert.deepEqual(
    parsePhotoKey('user-photos/chat/Ax7G1IOIOvZUd7mrIc5gsw0Fcgt2/5962f78b9aacb6bcf053abab.jpg'),
    {
      kind: 'chat',
      uid: 'Ax7G1IOIOvZUd7mrIc5gsw0Fcgt2',
      id: '5962f78b9aacb6bcf053abab',
      key: 'user-photos/chat/Ax7G1IOIOvZUd7mrIc5gsw0Fcgt2/5962f78b9aacb6bcf053abab.jpg',
    },
  );
  assert.ok(parsePhotoKey('/user-photos/listing/uid12345678/abcdef012345.jpg'));
  assert.equal(parsePhotoKey('user-photos/chat/../etc/passwd.jpg'), null);
  assert.equal(parsePhotoKey('user-photos/profile/uid12345678/abcdef012345.jpg'), null);
});

test('unauthenticated browser GETs redirect to /auth', () => {
  const location = authRedirect({
    headers: { host: 'api.pokoin.com', 'x-forwarded-proto': 'https' },
    url: '/api/user-photos/chat/u/abcdef012345.jpg',
  });
  assert.match(location, /^https:\/\/pokoin\.com\/auth\?from=/);
  const once = decodeURIComponent(location);
  assert.match(once, /\/messages\?photo=/);
  assert.match(decodeURIComponent(once), /https:\/\/api\.pokoin\.com\/api\/user-photos\//);
});

test('publicApiHost ignores loopback Host from the Pi reverse proxy', () => {
  assert.equal(
    publicApiHost({ headers: { host: '127.0.0.1:18080', 'x-forwarded-host': 'api.pokoin.com' } }),
    'api.pokoin.com',
  );
  assert.equal(
    publicApiHost({ headers: { host: '127.0.0.1:18080' } }),
    'api.pokoin.com',
  );
});

test('wantsHtml follows Accept', () => {
  assert.equal(wantsHtml({ headers: { accept: 'text/html,application/xhtml+xml' } }), true);
  assert.equal(wantsHtml({ headers: { accept: 'image/avif,image/webp,*/*' } }), false);
});
