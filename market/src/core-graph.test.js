// Guard: the framework-agnostic core of market/src (API client, caches,
// identity, ranking, …) is shared with the Solid app, so its static import
// graph must never reach React, Firebase, or a .jsx file. Dynamic import()
// is allowed — that is how Firestore stays lazy.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));

const ROOTS = [
  'api.js',
  'card-page-cache.js',
  'identity.js',
  'image-urls.js',
  'locale.js',
  'suggest-live.js',
  'suggest-rank.js',
  'suggest-catalog.js',
  'cart-model.js',
  'auth-session.js',
  'recents.js',
  'game.js',
  'pkn.js',
  'set-logos.js',
  'art-shade.js',
  'scroll-memory.js',
  'search-hot.js',
  'search-kind.js',
  'search-filters.js',
  'search-print.js',
  'suggest-resolve.js',
  'listing-meta.js',
  'associate-roles.js',
];

const FORBIDDEN_PACKAGES = new Set([
  'react',
  'react-dom',
  'react-router',
  'react-router-dom',
  'firebase',
]);

const CODE_EXT = new Set(['.js', '.mjs', '.jsx']);

// Statement-start only, so comments, strings and `import(` / `import.meta`
// never match. Clause characters cannot cross into ordinary code.
const IMPORT_FROM = /^[ \t]*import\s+([\w$*{},\s]+?)\s*from\s*['"]([^'"]+)['"]/gm;
const IMPORT_BARE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
const EXPORT_FROM = /^[ \t]*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[\w$\s,]*\})\s*from\s*['"]([^'"]+)['"]/gm;

function staticSpecifiers(source) {
  const out = [];
  for (const match of source.matchAll(IMPORT_FROM)) out.push(match[2]);
  for (const match of source.matchAll(IMPORT_BARE)) out.push(match[1]);
  for (const match of source.matchAll(EXPORT_FROM)) out.push(match[1]);
  return out;
}

function packageRoot(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isForbiddenPackage(specifier) {
  const root = packageRoot(specifier);
  return FORBIDDEN_PACKAGES.has(root) || root.startsWith('@firebase/');
}

function resolveLocal(fromFile, specifier) {
  const bare = specifier.split('?')[0];
  const base = path.resolve(path.dirname(fromFile), bare);
  const candidates = path.extname(base)
    ? [base]
    : [`${base}.js`, `${base}.jsx`, path.join(base, 'index.js')];
  return candidates.find((file) => fs.existsSync(file)) || candidates[0];
}

/** Breadth-first walk; returns every forbidden node with the chain that reached it. */
function findForbidden(roots) {
  const parent = new Map();
  const queue = [];
  for (const root of roots) {
    const file = path.join(SRC, root);
    parent.set(file, null);
    queue.push(file);
  }
  const offenders = [];
  const chainTo = (node) => {
    const chain = [];
    for (let at = node; at; at = parent.get(at)) {
      chain.unshift(at.startsWith(SRC) ? path.relative(SRC, at) : at);
    }
    return chain;
  };
  while (queue.length) {
    const file = queue.shift();
    if (file.endsWith('.jsx')) {
      offenders.push(chainTo(file));
      continue;
    }
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of staticSpecifiers(source)) {
      if (!specifier.startsWith('.')) {
        if (isForbiddenPackage(specifier)) offenders.push([...chainTo(file), specifier]);
        continue;
      }
      const next = resolveLocal(file, specifier);
      if (!CODE_EXT.has(path.extname(next)) || parent.has(next)) continue;
      parent.set(next, file);
      queue.push(next);
    }
  }
  return offenders;
}

test('staticSpecifiers reads static imports and re-exports only', () => {
  const source = [
    "import a from './a.js';",
    'import {',
    '  b,',
    '  c as d,',
    "} from './b.js';",
    "import * as e from 'react';",
    "import './side.css';",
    "export { f } from './f.js';",
    "export * from './g.js';",
    "const lazy = () => import('firebase/firestore');",
    "// import x from 'react-dom';",
    "const url = import.meta.env.BASE_URL;",
    "export function from() { return 'x'; }",
  ].join('\n');
  assert.deepEqual(staticSpecifiers(source).sort(), [
    './a.js',
    './b.js',
    './f.js',
    './g.js',
    './side.css',
    'react',
  ]);
});

test('core modules never statically reach React, Firebase, or .jsx', () => {
  const offenders = findForbidden(ROOTS);
  const report = offenders.map((chain) => `  ${chain.join(' -> ')}`).join('\n');
  assert.equal(offenders.length, 0, `forbidden static imports reachable from the core:\n${report}`);
});
