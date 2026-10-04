import assert from 'node:assert/strict';
import test from 'node:test';
import { shortlinkCardPath } from './shortlink.js';

test('numeric short links open the card desk inside the current game', () => {
  assert.equal(shortlinkCardPath('/661762'), '/marketplace/en/cards/661762');
  assert.equal(shortlinkCardPath('/661762/'), '/marketplace/en/cards/661762');
  assert.equal(shortlinkCardPath('/661762/rare-jinx-loose-cannon-251-origins'),
    '/marketplace/en/cards/661762/rare-jinx-loose-cannon-251-origins');
});

test('anything else is not a short link', () => {
  for (const path of ['', '/', '/marketplace', '/abc', '/66a1', '/661762/x/y', '/661762/<script>', '/1234567890123']) {
    assert.equal(shortlinkCardPath(path), '', path);
  }
});
