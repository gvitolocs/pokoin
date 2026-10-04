import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalSearchUniverse,
  redisSuggestWarmKey,
  resetSearchWarmupForTests,
} from './search-warmup.js';

test('canonicalSearchUniverse sorts multi-select languages', () => {
  assert.equal(
    canonicalSearchUniverse({ lang: 'DE,EN', printLang: 'western' }).key,
    canonicalSearchUniverse({ lang: 'en,de', printLang: 'western' }).key,
  );
  assert.equal(
    canonicalSearchUniverse({ lang: 'ja', printLang: 'japanese' }).key,
    'lang:ja:print:japanese',
  );
  assert.equal(
    canonicalSearchUniverse({ lang: 'any', printLang: 'western' }).key,
    'lang:any:print:western',
  );
});

test('redis suggest warm keys include both dimensions', () => {
  assert.equal(
    redisSuggestWarmKey({ lang: 'en', printLang: 'western', query: 'pika' }),
    'pokoin:search:v1:suggest:lang:en:print:western:pika',
  );
  resetSearchWarmupForTests();
});
