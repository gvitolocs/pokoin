import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ctLinkDirection, ctLinkHealth, ctLinkOption, formatSyncSummary, syncReason } from './cardtrader-link.js';

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
    pushedToCardTrader: { pushed: 5, failed: 1, remaining: 1051, linkedToExisting: 3, stoppedBy: 'rate_limited' },
  });
  assert.match(line, /^12 on CardTrader/);
  assert.doesNotMatch(line, /imported/);
  assert.match(line, /5 listed on CardTrader · 1051 waiting to list · 3 matched to CardTrader products · 1 refused by CardTrader/);
  assert.match(line, /the rest at the next sync \(CardTrader asked Pokoin to slow down\)/);
  assert.doesNotMatch(formatSyncSummary({ inventory: 9, pushedToCardTrader: { pushed: 9, remaining: 0, stoppedBy: 'done' } }), /next sync/);
  assert.match(formatSyncSummary({ inventory: 3, imported: 3 }), /3 imported/);
  assert.doesNotMatch(formatSyncSummary({ inventory: 3 }), /unresolved/);
});

test('a paused push and an incomplete sync say so', () => {
  const line = formatSyncSummary({ direction: 'both', inventory: 0, pushedToCardTrader: { blocked: 'incomplete_export', pushed: 0 } });
  assert.match(line, /listing on CardTrader paused: the CardTrader inventory was incomplete/);
  assert.doesNotMatch(line, /0 listed/);
  const health = ctLinkHealth({ sync: { lastSyncOk: true, lastSyncIncomplete: true, lastSyncError: 'mass_removal_guard' } });
  assert.equal(health.tone, 'warn');
  assert.match(health.text, /incomplete: CardTrader's export was missing most of your linked cards — nothing was removed or listed/);
  assert.equal(syncReason('pool timed out'), 'pool timed out');
});

test('connected panel is a link, not just a Sync button', () => {
  const src = fs.readFileSync(new URL('./CardTraderConnectPanel.jsx', import.meta.url), 'utf8');
  assert.match(src, /CT_LINK_DIRECTIONS/);
  assert.match(src, /Import locations/);
  assert.match(src, /Sync now/);
  assert.equal(src.includes("'Sync CardTrader'"), false);
});
