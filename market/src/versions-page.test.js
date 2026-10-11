import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

test('desk zoom lightbox fills most of the viewport', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.zoom img\s*\{[^}]*max-width:\s*min\(96vw,\s*42rem\)/s);
  assert.match(css, /\.zoom img\s*\{[^}]*max-height:\s*min\(92vh,\s*58rem\)/s);
  assert.doesNotMatch(css, /\.zoom img\s*\{[^}]*max-height:\s*45vh/s);
});
