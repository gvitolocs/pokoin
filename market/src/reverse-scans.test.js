import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { reverseScanUrl } from './reverse-scans.js';

const wiggly = 'https://cdn.pokoin.com/reverse/114719_wigglytuff-rare-holo-13-100-ex-crystal-guardians.jpg?v=rv1';

test('a card-page reverseScan on the CDN reverse folder is the toggle scan', () => {
  assert.equal(reverseScanUrl({ reverseScan: wiggly }), wiggly);
  assert.equal(
    reverseScanUrl({ reverseScan: 'https://cdn.pokoin.com/reverse/269615_slowpoke-036-190-shiny-treasure-ex.jpg' }),
    'https://cdn.pokoin.com/reverse/269615_slowpoke-036-190-shiny-treasure-ex.jpg',
  );
});

test('cards without a verified reverse scan show no sparkles', () => {
  for (const card of [undefined, null, {}, { reverseScan: '' }, { reverseScan: 42 }]) {
    assert.equal(reverseScanUrl(card), '');
  }
});

test('only the Pokoin CDN reverse folder is accepted', () => {
  for (const url of [
    'https://evil.example/reverse/114719_x.jpg',
    'https://cdn.pokoin.com/114719_wigglytuff.jpg',
    'https://cdn.pokoin.com/reverse/../114719_x.jpg',
    'https://cdn.pokoin.com/reverse/114719_x.webp',
    'javascript:alert(1)',
  ]) {
    assert.equal(reverseScanUrl({ reverseScan: url }), '', url);
  }
});

test('the reverse table is CardTrader id → flat JPEG name, with a cache token', () => {
  const table = JSON.parse(fs.readFileSync(new URL('./data/reverse-scans.json', import.meta.url), 'utf8'));
  assert.match(table.token, /^[A-Za-z0-9.-]+$/);
  const entries = Object.entries(table.scans);
  assert.ok(entries.length > 0);
  for (const [id, file] of entries) {
    assert.match(id, /^\d+$/);
    assert.ok(file.startsWith(`${id}_`) && file.endsWith('.jpg') && !file.includes('/'), file);
    assert.equal(reverseScanUrl({ reverseScan: `https://cdn.pokoin.com/reverse/${file}?v=${table.token}` }).length > 0, true);
  }
  assert.equal(table.scans['114719'], '114719_wigglytuff-rare-holo-13-100-ex-crystal-guardians.jpg');
});
