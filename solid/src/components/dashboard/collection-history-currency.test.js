import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const panelSrc = read('./CollectionHistoryPanel.jsx');
const viewSrc = read('./SellerDashboardView.jsx');

// The chart's headline, legend, tip and table are valuations of what the seller
// holds, so they read in the currency the movers tiles and the segment table
// under the chart already use (docs/MARKET.md, "Segment graphs").
test('every collection history amount carries the display currency', () => {
  assert.match(panelSrc, /const currency = \(\) => String\(props\.currency \|\| 'PKN'\)\.trim\(\)\.toUpperCase\(\) \|\| 'PKN'/);
  assert.match(panelSrc, /formatHistoryTip\(day, currency\(\)\)/);
  assert.match(panelSrc, /formatHistoryDelta\(delta\(\), currency\(\)\)/);
  // Nine printed amounts: summary pair, headline, two legend rows, the band
  // peak label, and the three cells of the screen-reader table.
  assert.equal((panelSrc.match(/formatHistoryAmount\(/g) || []).length, 9);
  // Nothing is left to print the stored unit: the panel no longer imports it.
  assert.doesNotMatch(panelSrc, /formatPknNumber/);
  assert.doesNotMatch(panelSrc, /\} PKN/);
});

test('SellerDashboardView threads the currency into the history chart', () => {
  const historyCall = viewSrc.match(/<CollectionHistoryPanel[\s\S]*?\/>/)?.[0] || '';
  assert.match(historyCall, /currency=\{props\.moverCurrency \|\| ''\}/);
  // Presentational still: the currency comes from the page, not from a store.
  assert.doesNotMatch(viewSrc, /from '\.\.\/\.\.\/stores\/buyer\.js'/);
});
