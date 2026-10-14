import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ctLinkDirection, ctLinkHealth, ctLinkOption, formatSyncSummary } from './cardtrader-link.js';

test('link direction comes from the status and defaults to CardTrader → Pokoin', () => {
  assert.equal(ctLinkDirection(null), 'ct_to_pokoin');
  assert.equal(ctLinkDirection({ inventorySync: { direction: 'both' } }), 'both');
  assert.equal(ctLinkDirection({ inventorySync: { direction: 'sideways' } }), 'ct_to_pokoin');
  assert.equal(ctLinkOption('pokoin_to_ct').label, 'Pokoin → CardTrader');
});

test('link health reads the last sync', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  assert.deepEqual(ctLinkHealth({ syncing: true }), { tone: 'syncing', text: 'Syncing now' });
  assert.equal(ctLinkHealth({ sync: { lastSyncOk: true, lastSyncAt: '2026-10-14T11:56:00Z' }, now }).text, 'Linked · checked 4 min ago');
  assert.equal(ctLinkHealth({ sync: { lastSyncOk: false, lastSyncError: 'export_failed' }, now }).tone, 'warn');
  assert.equal(ctLinkHealth({ sync: null, now }).tone, 'idle');
});

test('summary names CardTrader pushes and drops imports for Pokoin → CardTrader', () => {
  const line = formatSyncSummary({
    direction: 'pokoin_to_ct', inventory: 12, imported: 0, matchedExisting: 2,
    pushedToCardTrader: { pushed: 5, failed: 1 },
  });
  assert.match(line, /12 products checked/);
  assert.doesNotMatch(line, /imported/);
  assert.match(line, /5 listed on CardTrader · 1 refused by CardTrader/);
  assert.match(formatSyncSummary({ inventory: 3, imported: 3 }), /3 imported/);
});

test('connected panel is a link, not just a Sync button', () => {
  const src = fs.readFileSync(new URL('./CardTraderConnectPanel.jsx', import.meta.url), 'utf8');
  assert.match(src, /CT_LINK_DIRECTIONS/);
  assert.match(src, /Import locations/);
  assert.match(src, /Sync now/);
  assert.equal(src.includes("'Sync CardTrader'"), false);
});
