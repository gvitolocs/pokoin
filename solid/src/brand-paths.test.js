import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(file, out);
    else if (/\.jsx?$/.test(entry.name) && !entry.name.endsWith('.test.js')) out.push(file);
  }
  return out;
}

test('no page hard-codes /brand/ (production serves it under /market/; use brandSrc)', () => {
  const offenders = sources(SRC)
    .filter((file) => /["'`]\/brand\//.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file));
  assert.deepEqual(offenders, []);
});
