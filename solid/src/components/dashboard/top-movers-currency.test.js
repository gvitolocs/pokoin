import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const panelSrc = read('./TopMoversPanel.jsx');
const viewSrc = read('./SellerDashboardView.jsx');
const homeSrc = read('../../pages/SellerHome.jsx');

// The owner reads his prices in DKK everywhere else on the site (docs/MARKET.md
// "Buyer display currency", docs/SCAN_LISTING_WORKFLOW.md "Price"), so the
// movers tiles convert client-side and the endpoint keeps answering in PKN.
test('every mover amount carries the display currency', () => {
  assert.match(panelSrc, /const currency = \(\) => String\(props\.currency \|\| 'PKN'\)/);
  assert.match(panelSrc, /formatMoverValue\(mover\(\), props\.currency\)/);
  assert.match(panelSrc, /formatMoverChange\(mover\(\), props\.currency\)/);
  // The tile's title text states the same amounts in the same unit.
  assert.match(panelSrc, /moverTitle\(mover\(\), props\.currency\)/);
  assert.match(panelSrc, /<MoverTile mover=\{mover\} currency=\{currency\(\)\} href=\{hrefFor\(mover\)\} \/>/);
  assert.doesNotMatch(panelSrc, /formatMover(?:Value|Change)\(mover\(\)\)/);
  assert.doesNotMatch(panelSrc, /moverTitle\(mover\(\)\)/);
});

test('the tiles hold the skeleton until the currency is known, then never swap', () => {
  assert.match(panelSrc, /const pending = \(\) => Boolean\(props\.currencyPending\) \|\| \(Boolean\(props\.pending\) && !rows\(\)\.length\)/);
  // No tile list, no empty note while the unit is still unknown.
  assert.match(panelSrc, /<Show when=\{pending\(\)\}>/);
  assert.match(panelSrc, /<Show when=\{!pending\(\) && !rows\(\)\.length\}>/);
  assert.match(panelSrc, /<Show when=\{!pending\(\) && rows\(\)\.length\}>/);
  // A window switch keeps the painted rows: props.pending alone still yields.
  assert.doesNotMatch(panelSrc, /const pending = \(\) => Boolean\(props\.pending\)/);
});

test('the sparkline stays unitless PKN geometry', () => {
  assert.match(panelSrc, /moverSpark\(mover\(\), SPARK\)/);
  assert.doesNotMatch(panelSrc, /moverSpark\(mover\(\), SPARK, currency/);
});

test('SellerDashboardView threads the currency into the movers sheet', () => {
  const moversCall = viewSrc.match(/<TopMoversPanel[\s\S]*?\/>/)?.[0] || '';
  assert.match(moversCall, /currency=\{props\.moverCurrency \|\| ''\}/);
  assert.match(moversCall, /currencyPending=\{Boolean\(props\.moverCurrencyPending\)\}/);
  // Presentational still: no settings read in the view.
  assert.doesNotMatch(viewSrc, /from '\.\.\/\.\.\/stores\/buyer\.js'/);
});

test('SellerHome picks the currency by the documented rule', () => {
  assert.match(homeSrc, /import \{ currencyFromSearch \} from '@market\/pkn\.js'/);
  assert.match(homeSrc, /import \{ buyerPending, sellerCurrency \} from '\.\.\/stores\/buyer\.js'/);
  // `?currency=` pin first, else the profile country's currency (docs/BUYSELL.md).
  assert.match(homeSrc, /const moverPin = \(\) => currencyFromSearch\(location\.search\)/);
  assert.match(homeSrc, /const moverCurrency = \(\) => moverPin\(\) \|\| sellerCurrency\(\)/);
  assert.match(homeSrc, /const moverCurrencyPending = \(\) => !moverPin\(\) && buyerPending\(\)/);
  assert.match(homeSrc, /moverCurrency=\{moverCurrency\(\)\}/);
  assert.match(homeSrc, /moverCurrencyPending=\{moverCurrencyPending\(\)\}/);
  // Fixtures carry no account: the preview states its currency and is never pending.
  assert.match(homeSrc, /moverCurrency="DKK"/);
  const preview = homeSrc.match(/function PreviewDashboard\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(preview, /moverCurrencyPending/);
  // Only the movers tile converts; the endpoint stays PKN.
  assert.doesNotMatch(homeSrc, /fetchPortfolioMovers\(token, days, currency/);
});
