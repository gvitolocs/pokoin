import assert from 'node:assert/strict';
import test from 'node:test';
import { imageFilesFromClipboard } from './user-photos.js';

test('clipboard image items become photo files', () => {
  const shot = { name: 'shot.png', type: 'image/png' };
  const files = imageFilesFromClipboard({
    items: [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => shot },
    ],
    files: [],
  });
  assert.deepEqual(files, [shot]);
});

test('clipboard files are used when items have no image', () => {
  const shot = { name: 'shot.jpg', type: 'image/jpeg' };
  const files = imageFilesFromClipboard({
    items: [{ kind: 'string', type: 'text/plain' }],
    files: [shot, { name: 'note.txt', type: 'text/plain' }],
  });
  assert.deepEqual(files, [shot]);
});

test('a text paste does not attach a photo', () => {
  assert.deepEqual(imageFilesFromClipboard({
    items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
    files: [],
  }), []);
  assert.deepEqual(imageFilesFromClipboard(null), []);
});
