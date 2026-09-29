import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { brandSrc } from './brand-assets.js';

const here = dirname(fileURLToPath(import.meta.url));

test('brand assets resolve under the build base', () => {
  assert.equal(brandSrc('flex/flex-hero.svg'), '/brand/flex/flex-hero.svg');
  assert.equal(brandSrc('/protection/shield.svg'), '/brand/protection/shield.svg');
});

test('no page hard-codes /brand/ (production serves it under /market/)', () => {
  const dirs = [join(here, 'pages'), join(here, 'components')];
  const offenders = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsx')) continue;
      const src = readFileSync(join(dir, name), 'utf8');
      if (/["'`]\/brand\//.test(src)) offenders.push(name);
    }
  }
  assert.deepEqual(offenders, []);
});
