import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = new Set([
  'suggest-rank.js',
  'suggest-live.js',
  'suggest-catalog.js',
  'suggest-resolve.js',
  'search-score.js',
  'suggest-pool.js',
  'data/suggest-names.js',
]);
const STATIC = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

/** Static import graph from the React entry (dynamic import() does not count). */
function reachable(entry) {
  const parent = new Map([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    const source = fs.readFileSync(file, 'utf8');
    STATIC.lastIndex = 0;
    let match;
    while ((match = STATIC.exec(source))) {
      const spec = match[1] || match[2];
      if (!spec.startsWith('.')) continue;
      let target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target) && fs.existsSync(`${target}.js`)) target = `${target}.js`;
      if (!fs.existsSync(target) || parent.has(target) || !/\.(js|jsx)$/.test(target)) continue;
      parent.set(target, file);
      queue.push(target);
    }
  }
  return parent;
}

test('the React entry does not statically reach the suggest engine (it loads on search intent)', () => {
  const graph = reachable(path.join(SRC, 'main.jsx'));
  for (const file of graph.keys()) {
    const rel = path.relative(SRC, file);
    if (!ENGINE.has(rel)) continue;
    const chain = [];
    for (let at = file; at; at = graph.get(at)) chain.unshift(path.relative(SRC, at));
    assert.fail(`entry reaches ${rel}: ${chain.join(' -> ')}`);
  }
});
