import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { clientDeskArtUrl, deskArtUrl } from './api.js';
import { GAMES } from './game.js';
import { cdnFetchUrl, rasterSiblings } from './image-urls.js';

// The card page's card.deskArtUrl is computed in Rust (pokoin-rust
// crates/catalog/src/desk_art.rs). This fixture holds the SPA's answers;
// `cargo test -p pokoin-catalog` asserts the Rust side against the same file.
const golden = JSON.parse(readFileSync(
  new URL('../../pokoin-rust/crates/catalog/fixtures/desk-art-golden.json', import.meta.url),
  'utf8',
));

function useGame(game) {
  const slug = GAMES[game]?.slug || '';
  globalThis.window = { location: { hostname: 'pokoin.com', pathname: slug ? `/${slug}/marketplace` : '/marketplace' } };
}

test('the desk uses the card page deskArtUrl when it has one', () => {
  useGame('pokemon');
  const card = { id: '222454', name: 'Defender', heroImageUrl: '/card-images/222454_defender-80-102-base-set.jpg' };
  assert.equal(deskArtUrl(card), 'https://cdn.pokoin.com/111227_defender-80-102-base-set.jpg?v=bsu2');
  assert.equal(deskArtUrl({ ...card, deskArtUrl: 'https://cdn.pokoin.com/1_served.jpg' }), 'https://cdn.pokoin.com/1_served.jpg');
  assert.equal(deskArtUrl({ ...card, deskArtUrl: '' }), deskArtUrl(card));
});

test('a served deskArtUrl is the first URL the desk <img> requests', () => {
  for (const { game, url } of golden.cases) {
    if (!url) continue;
    useGame(game);
    assert.equal(cdnFetchUrl(rasterSiblings(url, { full: true })[0] || ''), url, url);
  }
});

test('the SPA still gives every golden answer (regenerate the fixture when it changes)', () => {
  assert.ok(golden.cases.length >= 1000);
  const wrong = [];
  for (const { game, card, url } of golden.cases) {
    useGame(game);
    const got = clientDeskArtUrl(card);
    if (got !== url) wrong.push(`${game} ${card.id}: ${got} != ${url}`);
  }
  assert.deepEqual(wrong.slice(0, 10), []);
});


test('restored Espathra scans bypass an older immutable green-matte response', () => {
  useGame('pokemon');
  assert.equal(deskArtUrl({ deskArtUrl: 'https://cdn.pokoin.com/274190_espathra-ex.jpg' }),
    'https://cdn.pokoin.com/274190_espathra-ex.jpg?v=esp-original-20261018');
});
