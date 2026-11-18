import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const page = fs.readFileSync(new URL('./ArtworkHover.jsx', import.meta.url), 'utf8');
const tests = JSON.parse(fs.readFileSync(new URL('../../../market/public/review/tests.json', import.meta.url)));
const vercel = JSON.parse(fs.readFileSync(new URL('../../../vercel.json', import.meta.url)));

test('artwork hover board is listed in the test dock and rewritten on Vercel', () => {
  assert.ok(tests.tests.some((entry) => entry.path === '/artwork' && entry.label === 'Artwork'));
  assert.ok(vercel.rewrites.some((entry) => entry.source === '/artwork'));
});

test('artwork board uses real figure masks and album hover structure', () => {
  assert.match(page, /\/card-images\/figure-masks\/\$\{sample\(\)\.version\}\.webp/);
  assert.match(page, /tile tile-cut tile-album artwork-test-card/);
  assert.match(page, /Hover or focus/);
});

test('artifact cleanup board compares raw vs cleaned masks', () => {
  assert.match(page, /figure-masks-clean/);
  assert.match(page, /labels=\{\['Before', 'After'\]\}/);
});
