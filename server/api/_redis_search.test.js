'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { redisSearchQuery } = require('./_redis_search');

const FT_SEARCH_REPLY =
  '*3\r\n:1\r\n$4\r\ndoc1\r\n*6\r\n$7\r\ncard_id\r\n$3\r\n123\r\n$13\r\nsearch_weight\r\n$1\r\n5\r\n$22\r\neffective_print_bucket\r\n$7\r\nwestern\r\n';

// Start a throwaway RESP server, point the module at it, and load the module
// fresh so it picks up REDIS_HOST/REDIS_PORT read at load time.
async function withFakeRedis(handler, run) {
  const server = net.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const previous = {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    timeout: process.env.REDIS_SEARCH_TIMEOUT_MS,
  };
  process.env.REDIS_HOST = '127.0.0.1';
  process.env.REDIS_PORT = String(port);
  process.env.REDIS_SEARCH_TIMEOUT_MS = '2000';
  const modulePath = require.resolve('./_redis_search');
  delete require.cache[modulePath];
  const fresh = require('./_redis_search');
  try {
    return await run(fresh);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    delete require.cache[modulePath];
    if (previous.host === undefined) delete process.env.REDIS_HOST; else process.env.REDIS_HOST = previous.host;
    if (previous.port === undefined) delete process.env.REDIS_PORT; else process.env.REDIS_PORT = previous.port;
    if (previous.timeout === undefined) delete process.env.REDIS_SEARCH_TIMEOUT_MS;
    else process.env.REDIS_SEARCH_TIMEOUT_MS = previous.timeout;
  }
}

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

test('a full reply arrives while the client keeps the connection open', async () => {
  const handler = (socket) => {
    let replied = false;
    socket.on('data', () => {});
    // Redis 8 drops the client when it half-closes before the reply.
    socket.on('end', () => { if (!replied) socket.destroy(); });
    setTimeout(() => {
      if (replied) return;
      replied = true;
      socket.write(FT_SEARCH_REPLY);
    }, 20);
  };
  await withFakeRedis(handler, async ({ redisSearchCandidates }) => {
    const result = await redisSearchCandidates('pikachu');
    assert.equal(result.estimatedTotalHits, 1);
    assert.equal(result.hits[0].card_id, '123');
    assert.equal(result.hits[0].effective_print_bucket, 'western');
  });
});

test('a reply split across three writes is parsed whole', async () => {
  const handler = (socket) => {
    socket.on('data', () => {
      const buf = Buffer.from(FT_SEARCH_REPLY);
      const size = Math.ceil(buf.length / 3);
      const send = (index) => {
        if (index >= 3) return;
        socket.write(buf.slice(index * size, (index + 1) * size));
        setTimeout(() => send(index + 1), 10);
      };
      send(0);
    });
  };
  await withFakeRedis(handler, async ({ redisSearchCandidates }) => {
    const result = await redisSearchCandidates('pikachu');
    assert.equal(result.estimatedTotalHits, 1);
    assert.equal(result.hits[0].card_id, '123');
  });
});

test('an error reply rejects with the server message', async () => {
  const handler = (socket) => {
    socket.on('data', () => socket.write('-ERR Unknown index name\r\n'));
  };
  await withFakeRedis(handler, async ({ redisSearchCandidates }) => {
    await assert.rejects(redisSearchCandidates('pikachu'), /Unknown index name/);
  });
});

test('a connection closed without a full reply rejects', async () => {
  const handler = (socket) => {
    socket.once('data', () => socket.end());
  };
  await withFakeRedis(handler, async ({ redisSearchCandidates }) => {
    await assert.rejects(redisSearchCandidates('pikachu'), /redis search failed/);
  });
});
