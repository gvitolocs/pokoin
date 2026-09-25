import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AVATAR_FILE_MAX_BYTES,
  AVATAR_SOURCE_MAX,
  AVATAR_PASTELS,
  avatarColor,
  MASCOT_GRID,
  mascotRenderSize,
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

test('default avatar pastel is stable per user and spread across the palette', () => {
  assert.equal(avatarColor('jZX1dJsfRAYsV7HHEcK3NdDSqI83'), avatarColor('jZX1dJsfRAYsV7HHEcK3NdDSqI83'));
  assert.equal(avatarColor('Pokoin'), avatarColor('pokoin'));
  assert.ok(AVATAR_PASTELS.includes(avatarColor('')));
  const used = new Set(Array.from({ length: 200 }, (_, i) => avatarColor(`uid-${i}`)));
  assert.equal(used.size, AVATAR_PASTELS.length);
  // No yellows/oranges: they swallow the golden mascot.
  for (const hex of AVATAR_PASTELS) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(!(r > 220 && g > 200 && b < 170), `${hex} is too yellow`);
  }
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

test('mascot pixels land on whole device pixels (no uneven columns)', () => {
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    for (const size of [26, 40, 72, 88, 112]) {
      const out = mascotRenderSize(size, dpr);
      if (!out.crisp) continue;
      const devicePerSpritePixel = (out.width * dpr) / MASCOT_GRID.width;
      assert.equal(devicePerSpritePixel, out.scale, `size ${size} @${dpr}x`);
      assert.ok(Number.isInteger(out.scale) && out.scale >= 1);
      assert.ok(Math.abs((out.height * dpr) / MASCOT_GRID.height - out.scale) < 1e-9);
      assert.ok(out.width <= size * 0.8 + 1e-9, `size ${size} @${dpr}x overflows`);
    }
  }
  assert.deepEqual(mascotRenderSize(88, 2), { width: 52, height: 48, scale: 4, crisp: true });
  assert.deepEqual(mascotRenderSize(112, 1), { width: 78, height: 72, scale: 3, crisp: true });
});

test('tiny avatars fall back to a smooth downscale instead of overflowing', () => {
  const out = mascotRenderSize(24, 1);
  assert.equal(out.crisp, false);
  assert.ok(out.width < 24);
  assert.equal(mascotRenderSize(26, 2).crisp, true);
});
