import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { normalizeSegments, segmentGroups } from '../../../market/src/portfolio-segments.js';
import { previewSegmentsFrom } from '../../../market/src/portfolio-segments-preview.js';
import {
  forgetSegments,
  peekSegments,
  rememberSegments,
} from '../../../market/src/portfolio-segments-cache.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const homeSrc = read('./SellerHome.jsx');
const viewSrc = read('../components/dashboard/SellerDashboardView.jsx');
const tableSrc = read('../components/dashboard/SegmentTable.jsx');
const authSrc = read('../stores/auth.js');

/** A raw answer from a server that has never heard of segments. */
function legacyPayload() {
  return {
    ok: true,
    days: [
      { date: '2026-11-16', currencyPkn: 10, cardsValuePkn: 900, cardsHeld: 4 },
      { date: '2026-11-17', currencyPkn: 10, cardsValuePkn: 1000, cardsHeld: 4 },
    ],
  };
}

test('the segment table rides the portfolio-history request', () => {
  // One request only: the split is remembered from the answer the graph reads.
  assert.match(homeSrc, /loadPortfolioHistory\(id, \(\) => getBearer\(\)/);
  assert.match(homeSrc, /fetchPortfolioHistory\(token\)/);
  assert.match(homeSrc, /rememberSegments\(id, data\)/);
  // An answer that lands after sign-out must not be filed under that uid.
  assert.match(homeSrc, /if \(!cancelled\) rememberSegments\(id, data\);/);
  assert.match(homeSrc, /peekSegments\(id\)/);
  assert.match(homeSrc, /subscribeSegments\(id,/);
  assert.match(homeSrc, /segments=\{segments\(\)\}/);
  assert.match(homeSrc, /segmentsPending=\{segmentsPending\(\)\}/);
});
test('a server without segmentDefs leaves the desk as it was', () => {
  assert.equal(normalizeSegments(legacyPayload()), null);
  assert.equal(normalizeSegments({ ok: true, days: [] }), null);
  assert.equal(normalizeSegments(null), null);
  // The cache keeps nothing, so nothing is painted and the old copy survives.
  assert.equal(rememberSegments('u-legacy', legacyPayload()), null);
  assert.equal(peekSegments('u-legacy'), null);
  // And the table itself renders no section at all without a model.
  assert.match(tableSrc, /<Show when=\{model\(\) \|\| skeleton\(\)\}>/);
  assert.match(tableSrc, /const model = \(\) => props\.model \|\| null/);
});

test('the table paints from the side cache and forgets on sign-out', () => {
  const payload = previewSegmentsFrom([
    { date: '2026-11-17', currencyPkn: 10, cardsKnown: true, cardsValuePkn: 1000, cardsHeld: 12, cardsPriced: 8 },
  ]);
  const model = rememberSegments('u-cache', payload);
  assert.ok(model);
  assert.deepEqual(peekSegments('u-cache'), model);
  // A different uid never sees it, and leaving drops it.
  assert.equal(peekSegments('u-other'), null);
  forgetSegments('u-cache');
  assert.equal(peekSegments('u-cache'), null);
  assert.match(authSrc, /forgetSegments\(leaving\);/);
  assert.match(authSrc, /clearPortfolioHistory\(leaving\);[\s\S]{0,80}forgetSegments\(leaving\);/);
});

test('rows come from the model, not from the key', () => {
  const model = normalizeSegments(previewSegmentsFrom([
    { date: '2026-11-16', currencyPkn: 10, cardsKnown: true, cardsValuePkn: 1000, cardsHeld: 12, cardsPriced: 8 },
    { date: '2026-11-17', currencyPkn: 10, cardsKnown: true, cardsValuePkn: 1100, cardsHeld: 12, cardsPriced: 8 },
  ]));
  const groups = segmentGroups(model, 'all', {});
  const rows = groups.flatMap((group) => group.rows);
  assert.ok(rows.length >= 2, 'one row per game');
  assert.ok(rows.some((row) => row.state === 'ok'), 'a row with a plotted line');
  assert.ok(rows.some((row) => row.state === 'empty'), 'a row nothing is held of');
  assert.ok(rows.some((row) => row.state === 'unpriced'), 'a row with stock but no price');
  // The states are what the desk renders, and the muted copy the brief asks for.
  assert.match(tableSrc, /row\.state === 'ok'/);
  assert.match(tableSrc, /None held/);
  assert.match(tableSrc, /No price data yet/);
});

test('the desk follows the graph window and keeps the levels switchable', () => {
  // Only onRange changed on the history panel line: the table copies the window.
  assert.match(viewSrc, /live=\{historyLive\(\)\} onRange=\{\(range\) => \{ setSegmentsRange\(range \|\| \{\}\)/);
  assert.match(viewSrc, /range=\{segmentsRange\(\)\}/);
  assert.match(tableSrc, /Number\(props\.range\?\.days\)/);
  assert.match(tableSrc, /const levels = createMemo\(\(\) => segmentLevels\(model\(\)\)\)/);
  assert.match(tableSrc, /segment-level-\$\{level\.id\}/);
  assert.match(tableSrc, /segment-row-\$\{(props\.)?row\.key\}/);
  assert.match(tableSrc, /data-testid="segment-chart"/);
  assert.match(tableSrc, /aria-expanded=/);
  assert.match(tableSrc, /aria-controls=\{`segment-chart-\$\{row\.key\}`\}/);
  // The amounts use the seller's display currency exactly like the movers.
  assert.match(tableSrc, /const currency = \(\) => String\(props\.currency \|\| 'PKN'\)/);
  assert.match(tableSrc, /Boolean\(props\.currencyPending\)/);
});

test('the charts are measured, not stretched, and honour reduced motion', () => {
  assert.match(tableSrc, /new ResizeObserver/);
  assert.match(tableSrc, /observer\.disconnect\(\)/);
  assert.doesNotMatch(tableSrc, /preserveAspectRatio="none"/);
  assert.match(tableSrc, /import '@market\/seller-segments\.css'/);
  const css = read('../../../market/src/seller-segments.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
  assert.match(css, /segment-draw-in 900ms/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*width: 72px/);
});

test('the fixture preview carries the segment table', () => {
  assert.match(homeSrc, /segments=\{normalizeSegments\(previewSegmentsFrom\(previewHistorySeries\(\)\)\)\}/);
});

test('the segment CSS paints with dashboard tokens only and copies no chrome', () => {
  const css = read('../../../market/src/seller-segments.css');
  // The documented liquidity fallback is the one colour literal allowed; every
  // other colour, including the panel chrome, is a variable the dashboard
  // already defines.
  const literals = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(literals)], ['#9085e9']);
  // And every one of those variables exists — an undefined token would paint
  // nothing at all rather than fail loudly.
  const tokens = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  const defined = read('../../../market/src/styles.css') + read('../../../market/src/seller-home.css');
  for (const token of tokens) {
    assert.ok(defined.includes(`${token}:`), `${token} is used but never defined`);
  }
  // The level switch is the history range presets' own class, not a copy of
  // their rules: seller-home.css is another workstream's file.
  assert.match(tableSrc, /class="segment-levels seller-history-presets"/);
  assert.doesNotMatch(css, /\.segment-level\b/);
});
