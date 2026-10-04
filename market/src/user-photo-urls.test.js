import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatPhotoDisplayUrl,
  isChatPhotoUrl,
  userPhotoPath,
} from './user-photo-urls.js';

test('legacy r2.dev chat URLs rewrite to the API proxy', () => {
  const legacy = 'https://pub-9ee104c567bd4be19ec1364b0e34d11f.r2.dev/user-photos/chat/Ax7G1IOIOvZUd7mrIc5gsw0Fcgt2/5962f78b9aacb6bcf053abab.jpg';
  assert.equal(
    userPhotoPath(legacy),
    '/user-photos/chat/Ax7G1IOIOvZUd7mrIc5gsw0Fcgt2/5962f78b9aacb6bcf053abab.jpg',
  );
  assert.equal(
    chatPhotoDisplayUrl(legacy),
    'https://api.pokoin.com/api/user-photos/chat/Ax7G1IOIOvZUd7mrIc5gsw0Fcgt2/5962f78b9aacb6bcf053abab.jpg',
  );
  assert.equal(isChatPhotoUrl(legacy), true);
});

test('listing photos are not chat-gated in the SPA helper', () => {
  const listing = 'https://api.pokoin.com/api/user-photos/listing/uid12345678/abcdef012345.jpg';
  assert.equal(isChatPhotoUrl(listing), false);
  assert.equal(chatPhotoDisplayUrl(listing), listing);
});
