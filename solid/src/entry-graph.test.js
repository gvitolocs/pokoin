import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const MARKET = path.resolve(SRC, '../../market/src');
/** The typeahead engine: loads on search intent (lib/suggest-engine.js), never with the entry. */
const ENGINE = new Set([
  path.join(SRC, 'lib/suggest-engine.js'),
  ...['suggest-rank.js', 'suggest-live.js', 'suggest-catalog.js', 'suggest-resolve.js', 'search-score.js', 'suggest-pool.js']
    .map((name) => path.join(MARKET, name)),
]);
const STATIC = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function resolve(from, spec) {
  let base;
  if (spec.startsWith('@market/')) base = path.join(MARKET, spec.slice('@market/'.length));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  return [base, `${base}.js`, `${base}.jsx`].find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}

/** Static import graph from the Solid entry (dynamic import() does not count). */
function reachable(entry) {
  const parent = new Map([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    const source = fs.readFileSync(file, 'utf8');
    STATIC.lastIndex = 0;
    let match;
    while ((match = STATIC.exec(source))) {
      const target = resolve(file, match[1] || match[2]);
      if (!target || parent.has(target) || !/\.jsx?$/.test(target)) continue;
      parent.set(target, file);
      queue.push(target);
    }
  }
  return parent;
}

test('the entry does not statically reach the suggest engine (it loads on search intent)', () => {
  const graph = reachable(path.join(SRC, 'main.jsx'));
  assert.ok(graph.size > 50, `walked ${graph.size} modules`);
  assert.ok(graph.has(path.join(SRC, 'components/SearchBox.jsx')), 'the header search box is on the entry');
  for (const file of graph.keys()) {
    if (!ENGINE.has(file)) continue;
    const chain = [];
    for (let at = file; at; at = graph.get(at)) chain.unshift(path.relative(path.dirname(SRC), at));
    assert.fail(`entry reaches ${path.relative(path.dirname(SRC), file)}: ${chain.join(' -> ')}`);
  }
});
