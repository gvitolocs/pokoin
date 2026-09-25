import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AVATAR_FILE_MAX_BYTES,
  AVATAR_SOURCE_MAX,
  avatarInitials,
  clampArea,
  dataUrlBytes,
  displayableAvatarUrl,
  fitWithin,
  nextRotation,
  rotatedSize,
  safeAvatarUrl,
  validateAvatarFile,
} from './avatar.js';
import { profileFromSession, readAuthSession, writeAuthSession } from './auth-session.js';

function memoryStore() {
  const data = {};
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
  };
}

test('stored avatar URLs are https only', () => {
  assert.equal(safeAvatarUrl('https://cdn.pokoin.com/profile-pictures/u/a.webp'), 'https://cdn.pokoin.com/profile-pictures/u/a.webp');
  assert.equal(safeAvatarUrl('http://example.com/a.png'), '');
  assert.equal(safeAvatarUrl('javascript:alert(1)'), '');
  assert.equal(safeAvatarUrl('data:image/png;base64,AAAA'), '');
  assert.equal(safeAvatarUrl(null), '');
});

test('editor previews may show data: and blob: images but not other data types', () => {
  assert.equal(displayableAvatarUrl('data:image/webp;base64,UklG'), 'data:image/webp;base64,UklG');
  assert.equal(displayableAvatarUrl('blob:https://pokoin.com/123'), 'blob:https://pokoin.com/123');
  assert.equal(displayableAvatarUrl('data:text/html;base64,PGgxPg=='), '');
  assert.equal(displayableAvatarUrl('data:image/svg+xml;base64,PHN2Zz4='), '');
});

test('initials: two words, one word, emails, wallets, emoji', () => {
  assert.equal(avatarInitials('Giuseppe Vitolo'), 'GV');
  assert.equal(avatarInitials('pokoin'), 'PO');
  assert.equal(avatarInitials('mario.rossi@gmail.com'), 'MR');
  assert.equal(avatarInitials('0xabcdef0123456789abcdef0123456789abcdef01'), '?');
  assert.equal(avatarInitials('🔥 ash_ketchum'), 'AK');
  assert.equal(avatarInitials(''), '?');
});

test('file validation accepts photos and explains every rejection', () => {
  assert.equal(validateAvatarFile({ type: 'image/jpeg', size: 1200 }), '');
  assert.equal(validateAvatarFile({ type: 'image/heic', size: 1200 }), '');
  assert.equal(validateAvatarFile({ type: '', size: 1200 }), '');
  assert.match(validateAvatarFile(null), /Choose a photo/);
  assert.match(validateAvatarFile({ type: 'application/pdf', size: 10 }), /not an image/);
  assert.match(validateAvatarFile({ type: 'image/svg+xml', size: 10 }), /JPG, PNG/);
  assert.match(validateAvatarFile({ type: 'image/png', size: AVATAR_FILE_MAX_BYTES + 1 }), /25 MB/);
  assert.match(validateAvatarFile({ type: 'image/png', size: 0 }), /empty/);
});

test('sources are downscaled to the working size and never upscaled', () => {
  assert.deepEqual(fitWithin(8000, 6000), { width: AVATAR_SOURCE_MAX, height: 1536, scale: AVATAR_SOURCE_MAX / 8000 });
  assert.deepEqual(fitWithin(3000, 4000), { width: 1536, height: AVATAR_SOURCE_MAX, scale: AVATAR_SOURCE_MAX / 4000 });
  assert.deepEqual(fitWithin(640, 480), { width: 640, height: 480, scale: 1 });
});

test('rotation geometry swaps sides on quarter turns and cycles 0-270', () => {
  const quarter = rotatedSize(400, 300, 90);
  assert.equal(Math.round(quarter.width), 300);
  assert.equal(Math.round(quarter.height), 400);
  const half = rotatedSize(400, 300, 180);
  assert.equal(Math.round(half.width), 400);
  assert.equal(nextRotation(0), 90);
  assert.equal(nextRotation(270), 0);
  assert.equal(nextRotation(-90), 0);
  assert.equal(nextRotation(93), 180);
});

test('crop areas are clamped inside the rotated image', () => {
  assert.deepEqual(
    clampArea({ x: -2.4, y: 10.6, width: 301, height: 301 }, { width: 300, height: 400 }),
    { x: 0, y: 11, width: 300, height: 300 },
  );
  assert.deepEqual(
    clampArea({ x: 250, y: 390, width: 100, height: 100 }, { width: 300, height: 400 }),
    { x: 200, y: 300, width: 100, height: 100 },
  );
});

test('data URL byte size matches the decoded payload', () => {
  assert.equal(dataUrlBytes('data:image/png;base64,AAAA'), 3);
  assert.equal(dataUrlBytes('data:image/png;base64,AAA='), 2);
  assert.equal(dataUrlBytes(''), 0);
});

test('session hint keeps the https photo for first paint and drops unsafe ones', () => {
  const store = memoryStore();
  writeAuthSession({ uid: 'u1', photoUrl: 'https://cdn.pokoin.com/profile-pictures/u1/a.webp' }, store);
  const session = readAuthSession(store);
  assert.equal(session.photoUrl, 'https://cdn.pokoin.com/profile-pictures/u1/a.webp');
  assert.equal(profileFromSession(session).photoUrl, 'https://cdn.pokoin.com/profile-pictures/u1/a.webp');

  writeAuthSession({ uid: 'u1', photoUrl: 'data:image/png;base64,AAAA' }, store);
  assert.equal(readAuthSession(store).photoUrl, '');
});
