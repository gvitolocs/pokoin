'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { redisSearchQuery } = require('./_redis_search');

test('a set title token searches the set name', () => {
  const query = redisSearchQuery('base set charizard', 'all');
  assert.match(query, /@set_name:base\*/);
  assert.match(query, /@expansion_name:charizard\*/);
});

test('pika is a prefix query', () => {
  const query = redisSearchQuery('pika', 'all');
  assert.match(query, /@name_compact:pika\*/);
});

test("professor's research keeps both words without the apostrophe", () => {
  const query = redisSearchQuery("professor's research", 'all');
  assert.match(query, /@name:professors\*/);
  assert.match(query, /@name:research\*/);
  assert.doesNotMatch(query, /'/);
});

test('Umbreon star searches the name inside the western bucket', () => {
  const query = redisSearchQuery('Umbreon ☆', 'western');
  assert.match(query, /@name:umbreon\*/);
  assert.match(query, /@effective_print_bucket:\{western\}/);
});

test('collector 4/102 matches the number exactly', () => {
  const query = redisSearchQuery('charizard 4/102', 'all');
  assert.match(query, /@card_number:4\b/);
  assert.match(query, /@card_number:102\b/);
  assert.doesNotMatch(query, /@card_number:4\*/);
});

test('umbrean asks for a two-edit fuzzy match', () => {
  const query = redisSearchQuery('umbrean', 'all');
  assert.match(query, /@name_compact:%%umbrean%%/);
});
