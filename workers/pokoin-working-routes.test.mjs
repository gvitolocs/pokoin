import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const raw = fs.readFileSync(new URL('../wrangler.pokoin-working.jsonc', import.meta.url), 'utf8');
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));

test('pokoin-working has no api.pokoin.com routes (Worker quota + edge cache)', () => {
  // On api.pokoin.com/* the Worker counted every API request against the free
  // 100k/day quota and sat in front of the edge cache (2026-10-01).
  assert.deepEqual(config.routes, []);
});
