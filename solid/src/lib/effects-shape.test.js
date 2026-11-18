import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(?:js|jsx)$/.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

const walk = (node, cb) => {
  if (!node || typeof node !== 'object') return;
  if (node.type) cb(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, cb));
    else if (value && typeof value === 'object') walk(value, cb);
  }
};

async function createEffectCalls() {
  const calls = [];
  for (const file of await sourceFiles(sourceRoot)) {
    const ast = parse(await readFile(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
    walk(ast.program, (node) => {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
        && node.callee.name === 'createEffect') {
        calls.push({ file, node });
      }
    });
  }
  return calls;
}

const where = ({ file, node }) => `${relative(sourceRoot, file)}:${node.loc.start.line}`;

test('createEffect calls provide both compute and effect functions', async () => {
  const violations = (await createEffectCalls())
    .filter(({ node }) => node.arguments.length < 2)
    .map(where);
  assert.deepEqual(violations, [], `createEffect needs a compute and an effect function:\n${violations.join('\n')}`);
});

test('createEffect effect callbacks do not return their last expression', async () => {
  // Solid 2 treats whatever an effect callback returns as its cleanup, so
  // `(value) => setDraft(value)` throws in dev and `TypeError: t is not a
  // function` in production. A block body that returns nothing is safe; so is
  // an expression that is itself the cleanup function.
  const isFunctionLiteral = (node) => node
    && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression');
  const violations = (await createEffectCalls())
    .filter(({ node }) => {
      const effect = node.arguments[1];
      return effect && effect.type === 'ArrowFunctionExpression'
        && effect.body.type !== 'BlockStatement' && !isFunctionLiteral(effect.body);
    })
    .map(where);
  assert.deepEqual(violations, [], `createEffect effect callbacks need a block body; an expression body returns its value to Solid as a cleanup:\n${violations.join('\n')}`);
});
