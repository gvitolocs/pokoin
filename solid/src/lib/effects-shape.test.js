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

test('createEffect calls provide both compute and effect functions', async () => {
  const violations = [];
  for (const file of await sourceFiles(sourceRoot)) {
    const ast = parse(await readFile(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
        && node.callee.name === 'createEffect' && node.arguments.length < 2) {
        violations.push(`${relative(sourceRoot, file)}:${node.loc.start.line}`);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(ast.program);
  }
  assert.deepEqual(violations, [], `createEffect needs a compute and an effect function:\n${violations.join('\n')}`);
});
