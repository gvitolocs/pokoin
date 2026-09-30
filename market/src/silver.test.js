import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SILVER_PRICE_PKN } from './silver.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('the web Silver price matches what the API charges', () => {
  const server = readFileSync(join(root, 'server/pokoin-api/unlock-silver.js'), 'utf8');
  const charged = Number(server.match(/const SILVER_PRICE_PKN = (\d+);/)[1]);
  assert.equal(SILVER_PRICE_PKN, 100);
  assert.equal(charged, SILVER_PRICE_PKN);
});
