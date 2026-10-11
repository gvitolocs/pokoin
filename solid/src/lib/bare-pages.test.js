import assert from 'node:assert/strict';
import test from 'node:test';
import { isBarePath } from './bare-pages.js';

test('review boards and the extension bridge are bare, with or without a trailing slash', () => {
  for (const path of ['/tests', '/sanitize/', '/ocr/artists', '/poko/archive/', '/extension/auth-bridge']) {
    assert.equal(isBarePath(path), true, path);
  }
});

test('desk pages keep the header', () => {
  for (const path of ['/', '/marketplace', '/ocr/x', '/about', '/inventory/scan', '/forum', '']) {
    assert.equal(isBarePath(path), false, path);
  }
});
