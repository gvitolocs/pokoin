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

test('a delayed Redis reply is read without half-closing the socket', async () => {
  const net = require('node:net');
  const server = net.createServer((socket) => {
    socket.on('data', () => {
      setTimeout(() => {
        socket.write([
          '*3',
          ':1',
          '$18',
          'pokoin:card:342318',
          '*6',
          '$7',
          'card_id',
          '$6',
          '342318',
          '$13',
          'search_weight',
          '$1',
          '4',
          '$22',
          'effective_print_bucket',
          '$7',
          'western',
          '',
        ].join('\r\n'));
      }, 50);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const previousPort = process.env.REDIS_PORT;
  process.env.REDIS_PORT = String(port);
  delete require.cache[require.resolve('./_redis_search')];
  try {
    const { redisSearchCandidates } = require('./_redis_search');
    const found = await redisSearchCandidates('pikachu', 4, 0, {});
    assert.equal(found.estimatedTotalHits, 1);
    assert.equal(found.hits[0].card_id, '342318');
  } finally {
    if (previousPort == null) delete process.env.REDIS_PORT;
    else process.env.REDIS_PORT = previousPort;
    delete require.cache[require.resolve('./_redis_search')];
    server.close();
  }
});

test('umbrean asks for a two-edit fuzzy match', () => {
  const query = redisSearchQuery('umbrean', 'all');
  assert.match(query, /@name_compact:%%umbrean%%/);
});
