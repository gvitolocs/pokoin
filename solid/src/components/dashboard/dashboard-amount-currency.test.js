import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const viewSrc = read('./SellerDashboardView.jsx');

// The tiles of the seller's own sheet — what his collection is worth, what his
// listings ask, what 1-Day Ready sold for — are valuations, so they read in the
// currency the movers tiles beside them already use (docs/MARKET.md, "Segment
// graphs"). The site balance is the exception: PKN is what it is held in.
test('the dashboard tiles print their amounts in the threaded currency', () => {
  assert.match(viewSrc, /function amount\(pkn, currency\) \{/);
  assert.match(viewSrc, /amount\(listed\(\)\.listedPkn, props\.moverCurrency\)/);
  assert.match(viewSrc, /amount\(oneDayReadyValue\(\), props\.moverCurrency\)/);
  // The 1-DR sheet and the trending rail take the currency from the view.
  assert.match(viewSrc, /<MoverCard card=\{card\} currency=\{props\.moverCurrency\} \/>/);
  assert.match(viewSrc, /<CardTraderAssetsPanel assets=\{assets\(\)\} currency=\{props\.moverCurrency\} \/>/);
  assert.match(viewSrc, /amount\(value, props\.currency\)/);
  assert.match(viewSrc, /amount\(totals\(\)\.valuePkn \|\| 0, props\.currency\)/);
  // The tile hover text names the same unit as the tile itself.
  assert.match(viewSrc, /function assetTitle\(item, currency\)/);
  assert.match(viewSrc, /assetTitle\(item, props\.currency\)/);
  assert.match(viewSrc, /last sold \$\{amount\(item\.pricePkn, currency\)\}/);
  // Nothing on these tiles is spelled in the stored unit any more.
  assert.doesNotMatch(viewSrc, /formatPkn\(/);
  assert.doesNotMatch(viewSrc, /counts 0 PKN/);
});

test('the site balance is PKN, so it prints PKN', () => {
  assert.match(viewSrc, /<strong>\{formatPknNumber\(balance\(\)\)\} PKN<\/strong>/);
});
