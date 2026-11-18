import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['lib/game-navigate.js']);

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(file, out);
    else if (/\.jsx?$/.test(entry.name) && !entry.name.endsWith('.test.js')) out.push(file);
  }
  return out;
}

test('only game-navigate imports useNavigate from the router', () => {
  const offenders = [];
  for (const file of sources(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/import\s*\{[^}]*\buseNavigate\b[^}]*\}\s*from\s*['"]@solidjs\/router['"]/.test(text)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
});
