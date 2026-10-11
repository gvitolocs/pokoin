import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.dirname(fileURLToPath(import.meta.url));

test('cardFromAutocomplete keeps camelCase multigame imageUrl', () => {
  const src = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  assert.match(src, /row\.gridImageUrl/);
  assert.match(src, /row\.imageUrl/);
  assert.match(src, /Multigame API emits camelCase imageUrl/);
});

test('leftoverUrl prefixes satellite CDN folders', () => {
  const src = fs.readFileSync(path.join(root, 'card-stub.js'), 'utf8');
  assert.match(src, /game\(\)\.slug \? `\$\{game\(\)\.slug\}\/`/);
  assert.match(src, /\/card-images\/\$\{prefix\}/);
});
