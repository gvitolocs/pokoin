import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalRedirectUrl,
  pathFromSlugMap,
  placeholderCanonicalPath,
  shortlinkCardId,
  slugFromPackedIndex,
} from './shortlink-path.js';

test('root id and marketplace id shortlinks', () => {
  assert.equal(shortlinkCardId('/239324'), '239324');
  assert.equal(shortlinkCardId('/239324/'), '239324');
  assert.equal(shortlinkCardId('/marketplace/239324'), '239324');
  assert.equal(shortlinkCardId('/marketplace/239324/'), '239324');
});

test('SPA card path without slug is a shortlink; with slug is not', () => {
  assert.equal(shortlinkCardId('/marketplace/en/cards/239324'), '239324');
  assert.equal(shortlinkCardId('/marketplace/en/cards/239324/'), '239324');
  assert.equal(
    shortlinkCardId('/marketplace/en/cards/239324/card-gambler-060-062-fossil'),
    '',
  );
});

test('root id with a leftover slug still redirects', () => {
  assert.equal(shortlinkCardId('/239324/card-gambler-060-062-fossil'), '239324');
});

test('non-card paths are ignored', () => {
  assert.equal(shortlinkCardId('/'), '');
  assert.equal(shortlinkCardId('/marketplace'), '');
  assert.equal(shortlinkCardId('/marketplace/search'), '');
  assert.equal(shortlinkCardId('/favicon.ico'), '');
  assert.equal(shortlinkCardId('/0'), '');
  assert.equal(shortlinkCardId('/01'), '');
});

test('canonical redirect stays on pokoin.com', () => {
  assert.equal(
    canonicalRedirectUrl('/marketplace/en/cards/239324/card-gambler-060-062-fossil'),
    'https://pokoin.com/marketplace/en/cards/239324/card-gambler-060-062-fossil',
  );
  assert.equal(canonicalRedirectUrl('/wallet'), '');
});

test('in-memory slug map builds the canonical path', () => {
  assert.equal(
    pathFromSlugMap('239324', { 239324: 'card-gambler-060-062-fossil' }),
    '/marketplace/en/cards/239324/card-gambler-060-062-fossil',
  );
  assert.equal(pathFromSlugMap('1', {}), '');
});

test('unknown ids get a placeholder slug path the Worker will not intercept', () => {
  assert.equal(placeholderCanonicalPath('999'), '/marketplace/en/cards/999/card');
  assert.equal(shortlinkCardId(placeholderCanonicalPath('999')), '');
});

test('packed index binary-searches ids', () => {
  const ids = Uint32Array.from([10, 20, 239324]);
  const blob = 'aaabbbcard-gambler-060-062-fossil';
  const starts = Uint32Array.from([0, 3, 6, blob.length]);
  assert.equal(slugFromPackedIndex('239324', ids, starts, blob), 'card-gambler-060-062-fossil');
  assert.equal(slugFromPackedIndex('10', ids, starts, blob), 'aaa');
  assert.equal(slugFromPackedIndex('11', ids, starts, blob), '');
});
