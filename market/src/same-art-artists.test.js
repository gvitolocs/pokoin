import assert from 'node:assert/strict';
import test from 'node:test';
import { ocrArtistsQuery, sameArtArtistFills, uniqueGroupArtist } from './same-art-artists.js';

test('same artwork copies the unique illustrator onto empty siblings', () => {
  assert.equal(
    uniqueGroupArtist([
      { artist: 'Saboteri' },
      { artist: '' },
      { illustrator: 'Saboteri' },
    ]),
    'Saboteri',
  );
  const fills = sameArtArtistFills([
    { version: 'v791574', ctId: 395787, artist: 'Saboteri' },
    { version: 'v791574', ctId: 396485, cardId: 792970, artist: '' },
    { version: 'v791574', ctId: 401184, artist: '' },
  ]);
  assert.deepEqual(
    fills.map((row) => row.ctId).sort(),
    [396485, 401184],
  );
  assert.equal(fills[0].artist, 'Saboteri');
});

test('same artwork does not copy when two names share a CLIP key', () => {
  assert.deepEqual(
    sameArtArtistFills([
      { version: 'v1', ctId: 1, name: 'Charizard', artist: 'Mitsuhiro Arita' },
      { version: 'v1', ctId: 2, name: 'Pikachu', artist: '' },
    ]),
    [],
  );
});

test('same artwork does not copy when two illustrators disagree', () => {
  assert.equal(
    uniqueGroupArtist([{ artist: 'Ken Sugimori' }, { artist: 'Mitsuhiro Arita' }]),
    '',
  );
  assert.deepEqual(
    sameArtArtistFills([
      { version: 'v1', ctId: 1, artist: 'Ken Sugimori' },
      { version: 'v1', ctId: 2, artist: 'Mitsuhiro Arita' },
      { version: 'v1', ctId: 3, artist: '' },
    ]),
    [],
  );
});

test('OCR artist table query deep-links a catalog illustrator', () => {
  assert.equal(ocrArtistsQuery('Saboteri'), '/ocr/artists?q=Saboteri');
  assert.equal(ocrArtistsQuery(''), '/ocr/artists');
});
