'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const valkey = require('./_valkey');

function listen(onSocket) {
  return new Promise((resolve) => {
    const server = net.createServer(onSocket);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('one socket pipelines commands and a refused server fails open', async () => {
  const seen = [];
  let sockets = 0;
  const server = await listen((socket) => {
    sockets += 1;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length) {
        const parsed = valkey._test.parseOne(buf);
        if (!parsed) return;
        buf = buf.slice(parsed.used);
        seen.push(parsed.value);
        socket.write('$3\r\nbar\r\n');
      }
    });
  });
  const { port } = server.address();
  valkey.configure({ host: '127.0.0.1', port, timeoutMs: 200 });
  try {
    const [first, second] = await Promise.all([
      valkey.command(['GET', 'a']),
      valkey.command(['GET', 'b']),
    ]);
    assert.equal(first, 'bar');
    assert.equal(second, 'bar');
    assert.equal(seen.length, 2);
    assert.equal(sockets, 1);
    const closedPort = port;
    valkey._test.resetConnection();
    await new Promise((resolve) => server.close(resolve));
    valkey.configure({ host: '127.0.0.1', port: closedPort, timeoutMs: 200 });
    const missed = await valkey.getJson('card-page:missing');
    assert.equal(missed, null);
  } finally {
    valkey._test.resetConnection();
    server.close();
  }
});
