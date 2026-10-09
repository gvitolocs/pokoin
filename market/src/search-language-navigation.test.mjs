import test from 'node:test';
import assert from 'node:assert/strict';
import { searchLanguageNavigationPath } from './locale.js';
test('search language preserves the same printing desk and game', () => {
 for (const path of ['/marketplace/en/cards/806390/card-mega-rayquaza-ex-gold', '/marketplace/en/cards/806390', '/lorcana/marketplace/en/cards/708344/rare-megara']) {
  assert.equal(searchLanguageNavigationPath(path, 'it'), path);
 }
});
test('search and version browsers still change title language', () => {
 assert.equal(searchLanguageNavigationPath('/marketplace/en/artists/tomokazu-komiya', 'it'), '/marketplace/it/artists/tomokazu-komiya');
 assert.equal(searchLanguageNavigationPath('/marketplace/en/cards/806390/versions', 'it'), '/marketplace/it/cards/806390/versions');
});
