import assert from 'node:assert/strict';
import test from 'node:test';
import {
  apiGameParam,
  game,
  gameBasename,
  gameHref,
  gameIdFromPath,
  gamePreviewHref,
  gameRequestHeaders,
  gameSwitchReloads,
  isCrossGameHome,
  isMarketplaceHomePath,
  isPokemonGame,
  setGamePathSource,
  stripGamePrefix,
  withGameQuery,
} from './game.js';

test('setGamePathSource makes game helpers follow the reader, then unset restores the document', () => {
  let path = '/marketplace';
  setGamePathSource(() => path);
  try {
    assert.equal(game().id, 'pokemon');
    assert.equal(isPokemonGame(), true);
    assert.equal(gameBasename(), '');
    assert.equal(apiGameParam(), '');
    assert.equal(withGameQuery('/api/marketplace-home'), '/api/marketplace-home');
    assert.deepEqual(gameRequestHeaders(), {});

    path = '/one-piece/marketplace';
    assert.equal(game().id, 'one_piece');
    assert.equal(isPokemonGame(), false);
    assert.equal(gameBasename(), '/one-piece');
    assert.equal(gameIdFromPath(path), 'one_piece');
    assert.equal(apiGameParam(), 'one_piece');
    assert.equal(withGameQuery('/api/marketplace-home'), '/api/marketplace-home?game=one_piece');
    assert.equal(gameRequestHeaders()['x-pokoin-game'], 'one_piece');
    assert.equal(gameHref('/marketplace/sets/op-01'), '/one-piece/marketplace/sets/op-01');
    assert.equal(gameHref('/one-piece/marketplace'), '/one-piece/marketplace');
    assert.equal(gameHref('/cart'), '/cart');

    setGamePathSource(() => null);
    assert.equal(game().id, 'pokemon');
    assert.equal(gameBasename(), '');
  } finally {
    setGamePathSource(null);
  }
});

test('stripGamePrefix removes only a known leading game slug', () => {
  assert.equal(stripGamePrefix('/one-piece/marketplace/x'), '/marketplace/x');
  assert.equal(stripGamePrefix('/riftbound/marketplace'), '/marketplace');
  assert.equal(stripGamePrefix('/star-wars-destiny/product/box'), '/product/box');
  assert.equal(stripGamePrefix('/one-piece'), '/');
  assert.equal(stripGamePrefix('/one-piece/'), '/');
  assert.equal(stripGamePrefix('/marketplace'), '/marketplace');
  assert.equal(stripGamePrefix('/marketplace/'), '/marketplace/');
  assert.equal(stripGamePrefix('/wallet'), '/wallet');
  assert.equal(stripGamePrefix('/not-a-game/marketplace'), '/not-a-game/marketplace');
  assert.equal(stripGamePrefix(''), '');
});

test('isMarketplaceHomePath is only the marketplace root, per game', () => {
  assert.equal(isMarketplaceHomePath('/marketplace'), true);
  assert.equal(isMarketplaceHomePath('/marketplace/'), true);
  assert.equal(isMarketplaceHomePath('/one-piece/marketplace'), true);
  assert.equal(isMarketplaceHomePath('/one-piece/marketplace/'), true);
  assert.equal(isMarketplaceHomePath('/flesh-and-blood/marketplace'), true);
  assert.equal(isMarketplaceHomePath('/marketplace/search'), false);
  assert.equal(isMarketplaceHomePath('/one-piece/marketplace/en/cards/1/luffy'), false);
  assert.equal(isMarketplaceHomePath('/not-a-game/marketplace'), false);
  assert.equal(isMarketplaceHomePath('/one-piece'), false);
  assert.equal(isMarketplaceHomePath('/marketplace?q=1'), true);
});

test('isCrossGameHome is only another game\'s marketplace root', () => {
  assert.equal(isCrossGameHome('/one-piece/marketplace', '/marketplace'), true);
  assert.equal(isCrossGameHome('/marketplace', '/riftbound/marketplace/'), true);
  assert.equal(isCrossGameHome('/one-piece/marketplace', '/one-piece/marketplace'), false);
  assert.equal(isCrossGameHome('/marketplace', '/marketplace/search'), false);
  assert.equal(isCrossGameHome('/one-piece/marketplace', '/riftbound/marketplace/sets/x'), false);
});

test('gameSwitchReloads is a different game off the marketplace home', () => {
  assert.equal(gameSwitchReloads('/marketplace', '/one-piece/marketplace'), false);
  assert.equal(gameSwitchReloads('/one-piece/marketplace', '/marketplace'), false);
  assert.equal(gameSwitchReloads('/marketplace', '/one-piece/marketplace/'), false);
  assert.equal(gameSwitchReloads('/marketplace/en/cards/1/x', '/one-piece/marketplace/en/cards/1/x'), true);
  assert.equal(gameSwitchReloads('/one-piece/marketplace', '/riftbound/marketplace/search?q=1'), true);
  assert.equal(gameSwitchReloads('/one-piece/marketplace', '/one-piece/marketplace/sets/op-01'), false);
  assert.equal(gameSwitchReloads('/marketplace', '/marketplace/search'), false);
  assert.equal(gameSwitchReloads('/one-piece/marketplace', '/wallet'), true);
});

test('game preview links stay same-origin on pokoin.com and local dev', () => {
  assert.equal(gamePreviewHref('one_piece', 'pokoin.com'), '/one-piece/marketplace');
  assert.equal(gamePreviewHref('pokemon', 'www.pokoin.com'), '/marketplace');
  assert.equal(gamePreviewHref('riftbound', 'localhost'), '/riftbound/marketplace');
  assert.equal(gamePreviewHref('magic', 'app.localhost'), '/magic/marketplace');
  assert.equal(gamePreviewHref('yugioh', '127.0.0.1'), '/yugioh/marketplace');
  assert.equal(gamePreviewHref('lorcana', 'dashboard.pokoin.com'), 'https://pokoin.com/lorcana/marketplace');
  assert.equal(gamePreviewHref('digimon', 'test.pokoin.com'), 'https://pokoin.com/digimon/marketplace');
});
