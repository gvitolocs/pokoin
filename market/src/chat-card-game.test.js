import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCard } from './api.js';
import { cardReference, resolveTagGame } from './chat-listing.js';
import {
  catalogGameFromUrl,
  gameRequestHeadersFor,
  knownGameId,
  withGameQueryFor,
} from './game.js';
import { fetchCardTiles } from './lists.js';
import { tagsToPokoCards } from './poko-chat.js';

test('a tag game prefers the row, then a Poko default, then the page', () => {
  assert.equal(knownGameId('one-piece'), 'one_piece');
  assert.equal(knownGameId(''), '');
  assert.equal(knownGameId('nope'), '');
  assert.equal(
    resolveTagGame({ game: 'one-piece' }, { defaultGame: 'pokemon', pageGame: 'magic' }),
    'one_piece',
  );
  assert.equal(
    resolveTagGame({ game: '' }, { defaultGame: 'pokemon', pageGame: 'one_piece' }),
    'pokemon',
  );
  assert.equal(
    resolveTagGame({}, { pageGame: 'magic' }),
    'magic',
  );
  assert.equal(resolveTagGame({}, { pageGame: 'pokemon' }), 'pokemon');
  assert.equal(
    withGameQueryFor('/api/marketplace-card-tiles?ids=12', 'one_piece'),
    '/api/marketplace-card-tiles?ids=12&game=one_piece',
  );
  assert.equal(
    withGameQueryFor('/api/marketplace-card-page?cardId=12', 'pokemon'),
    '/api/marketplace-card-page?cardId=12',
  );
  assert.equal(gameRequestHeadersFor('one_piece', 'pokoin.com')['x-pokoin-game'], 'one_piece');
  assert.equal(gameRequestHeadersFor('pokemon', 'onepiece.pokoin.com')['x-pokoin-game'], undefined);
  assert.equal(
    catalogGameFromUrl('https://api.pokoin.com/api/marketplace-card-page?cardId=12&game=magic'),
    'magic',
  );
  assert.equal(
    catalogGameFromUrl('https://api.pokoin.com/api/marketplace-card-page?cardId=12'),
    'pokemon',
  );
});

test('explicit game replaces the page game on tile and card reads, and cache keys stay apart', async () => {
  const previous = globalThis.window;
  globalThis.window = {
    location: { hostname: 'pokoin.com', pathname: '/one-piece/marketplace/search' },
  };
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    calls.push({ href, headers: init?.headers || {} });
    const game = new URL(href).searchParams.get('game') || 'pokemon';
    const body = href.includes('marketplace-card-tiles')
      ? { cards: [{ id: '12', name: `Tile ${game}`, canonicalPath: '/marketplace/en/cards/12/nami' }] }
      : {
        game,
        canonicalPath: '/marketplace/en/cards/12/nami',
        card: { id: '12', name: `Page ${game}`, canonicalPath: '/marketplace/en/cards/12/nami' },
      };
    return {
      ok: true,
      headers: { get: () => '' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  try {
    assert.equal(cardReference({ id: '12', name: 'Nami' }).game, 'one_piece');
    const dragged = cardReference({ id: '12', name: 'Mimikyu', game: 'pokemon' });
    assert.equal(dragged.game, 'pokemon');
    assert.equal(tagsToPokoCards([dragged])[0].game, 'pokemon');

    const tiles = await fetchCardTiles(['12'], { game: 'pokemon' });
    assert.equal(tiles[0].name, 'Tile pokemon');
    const tileCall = calls.find((call) => call.href.includes('marketplace-card-tiles'));
    assert.ok(tileCall, 'tiles were requested');
    assert.equal(new URL(tileCall.href).searchParams.get('game'), null);
    assert.equal(tileCall.headers['x-pokoin-game'], undefined);

    calls.length = 0;
    await fetchCardTiles(['12'], { game: 'one_piece' });
    const satelliteTiles = calls.find((call) => call.href.includes('marketplace-card-tiles'));
    assert.equal(new URL(satelliteTiles.href).searchParams.get('game'), 'one_piece');
    assert.equal(satelliteTiles.headers['x-pokoin-game'], 'one_piece');

    calls.length = 0;
    const pokemon = await fetchCard('12', { game: 'pokemon', lang: 'en' });
    assert.equal(pokemon.card.name, 'Page pokemon');
    const onePiece = await fetchCard('12', { game: 'one_piece', lang: 'en' });
    assert.equal(onePiece.card.name, 'Page one_piece');
    const pageCalls = calls.filter((call) => call.href.includes('marketplace-card-page'));
    assert.equal(pageCalls.length, 2);
    assert.equal(new URL(pageCalls[0].href).searchParams.get('game'), null);
    assert.equal(pageCalls[0].headers['x-pokoin-game'], undefined);
    assert.equal(new URL(pageCalls[1].href).searchParams.get('game'), 'one_piece');
    assert.equal(pageCalls[1].headers['x-pokoin-game'], 'one_piece');

    calls.length = 0;
    const again = await fetchCard('12', { game: 'pokemon', lang: 'en' });
    assert.equal(again.card.name, 'Page pokemon');
    assert.equal(
      calls.filter((call) => call.href.includes('marketplace-card-page')).length,
      0,
      'a second read of the same game reuses the cache',
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
