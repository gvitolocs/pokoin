import assert from 'node:assert/strict';
import test from 'node:test';
import { isSearchLang, rewriteCatalogLang, searchLangFromPath } from './locale.js';

test('search langs are the TCG codes used in card URLs', () => {
  assert.equal(isSearchLang('en'), true);
  assert.equal(isSearchLang('zht'), true);
  assert.equal(isSearchLang('jp'), true);
  assert.equal(isSearchLang('EN'), true);
  assert.equal(isSearchLang('ja'), false);
});

test('card and artist paths rewrite the language segment', () => {
  assert.equal(
    rewriteCatalogLang('/marketplace/en/cards/221412/card-pikachu-48-162-breakthrough', 'it'),
    '/marketplace/it/cards/221412/card-pikachu-48-162-breakthrough',
  );
  assert.equal(
    rewriteCatalogLang('/marketplace/en/artists/ken-sugimori', 'jp'),
    '/marketplace/jp/artists/ken-sugimori',
  );
  assert.equal(rewriteCatalogLang('/marketplace', 'it'), '/marketplace');
  assert.equal(rewriteCatalogLang('/marketplace/search?q=pika', 'fr'), '/marketplace/search?q=pika');
});

test('path helper reads catalog language', () => {
  assert.equal(searchLangFromPath('/marketplace/it/cards/1/slug'), 'it');
  assert.equal(searchLangFromPath('/marketplace/zht/artists/x'), 'zht');
  assert.equal(searchLangFromPath('/marketplace/search'), '');
});
