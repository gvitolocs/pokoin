import assert from 'node:assert/strict';
import test from 'node:test';
import { artistDeskIsUnknown, artistNameFromSlug, artistSlug } from './artist-name.js';

test('artistNameFromSlug title-cases the URL slug for first paint', () => {
  assert.equal(artistNameFromSlug('tomokazu-komiya'), 'Tomokazu Komiya');
  assert.equal(artistNameFromSlug('mitsuhiro-arita'), 'Mitsuhiro Arita');
  assert.equal(artistNameFromSlug('narumi-sato'), 'Narumi Sato');
  assert.equal(artistNameFromSlug(artistSlug('Tomokazu Komiya')), 'Tomokazu Komiya');
});

test('empty artist API payload is not a fake illustrator desk', () => {
  assert.equal(artistDeskIsUnknown(null), false);
  assert.equal(artistDeskIsUnknown({ artist: { name: 'Saboteri' }, cards: [] }), false);
  assert.equal(artistDeskIsUnknown({ artist: null, cards: [] }), true);
  assert.equal(artistDeskIsUnknown({ artist: undefined, cards: [] }), true);
});
