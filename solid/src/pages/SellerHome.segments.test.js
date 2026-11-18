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
const panelSrc = read('../components/dashboard/CollectionHistoryPanel.jsx');
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
  assert.match(homeSrc, /loadPortfolioHistory\(id, \(\) => \{/);
  assert.match(homeSrc, /fetchPortfolioHistory\(token\)/);
  assert.match(homeSrc, /peekSegments\(id\)/);
  assert.match(homeSrc, /subscribeSegments\(id,/);
  assert.match(homeSrc, /segments=\{segments\(\)\}/);
  assert.match(homeSrc, /segmentsPending=\{segmentsPending\(\)\}/);
});
test('every answer fills the segment cache, not only one the page still sees', () => {
  // The history cache retries on its own and this fetcher is what it retries:
  // `cancelled` must not gate the split, or a follow-up day never reaches the
  // table. A sign-out answer is dropped by the cache's own epoch instead.
  assert.match(homeSrc, /try \{\s*rememberSegments\(id, data, epoch\);/);
  assert.match(homeSrc, /const epoch = segmentsEpoch\(id\);/);
  assert.doesNotMatch(homeSrc, /rememberSegments\([^)]*cancelled/);
  // It can never fail the history load: the raw answer still goes back up.
  assert.match(homeSrc, /rememberSegments\(id, data, epoch\);\s*\} catch \{[\s\S]{0,80}\}\s*return data;/);
});
test('a server without segmentDefs leaves the desk as it was', () => {
  assert.equal(normalizeSegments(legacyPayload()), null);
  assert.equal(normalizeSegments({ ok: true, days: [] }), null);
  assert.equal(normalizeSegments(null), null);
  // The cache keeps nothing, so nothing is painted and the old copy survives.
  assert.equal(rememberSegments('u-legacy', legacyPayload()), null);
  assert.equal(peekSegments('u-legacy'), null);
  // And the table itself renders no section at all without a model: a split
  // that is not coming has nothing to say, so not even a skeleton flashes.
  assert.match(tableSrc, /<Show when=\{visible\(\)\}>/);
  assert.match(tableSrc, /const visible = \(\) => model\(\) != null \|\| Boolean\(props\.pending\);/);
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
  // Another uid never inherits what is painted: the switch replaces the model
  // with that user's own copy, or with nothing.
  assert.match(homeSrc, /setSegments\(cachedSegments \|\| null\)/);
  assert.doesNotMatch(homeSrc, /if \(cachedSegments\) setSegments\(/);
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
  assert.match(tableSrc, /row\(\)\.state === 'ok'/);
  assert.match(tableSrc, /None held/);
  assert.match(tableSrc, /No price data yet/);
});

test('the desk follows the graph window and keeps the levels switchable', () => {
  // Only onRange changed on the history panel line: the table copies the window.
  assert.match(viewSrc, /live=\{historyLive\(\)\} onRange=\{\(range\) => \{ setSegmentsRange\(range \|\| \{\}\)/);
  assert.match(viewSrc, /range=\{segmentsRange\(\)\}/);
  // The whole range object is forwarded, so the graph's custom pick arrives
  // with its own two dates and the table does not have to guess them.
  assert.match(panelSrc, /props\.onRange\(id === 'custom' \? \{ id, days, label, from, to \} : \{ id, days, label \}\)/);
  // One helper decides the window for both the preset and the custom case.
  assert.match(tableSrc, /segmentWindow\(model\(\), props\.range\)/);
  assert.match(tableSrc, /const levels = createMemo\(\(\) => segmentLevels\(model\(\)\)\)/);
  assert.match(tableSrc, /segment-level-\$\{level\.id\}/);
  assert.match(tableSrc, /segment-row-\$\{(props\.)?row\(\)\.key\}/);
  assert.match(tableSrc, /data-testid="segment-chart"/);
  assert.match(tableSrc, /aria-expanded=/);
  assert.match(tableSrc, /aria-controls=\{isOpen\(row\(\)\.key\) \? `segment-chart-\$\{row\(\)\.key\}` : undefined\}/);
  // The amounts use the seller's display currency exactly like the movers.
  assert.match(tableSrc, /const currency = \(\) => String\(props\.currency \|\| 'PKN'\)/);
  assert.match(tableSrc, /Boolean\(props\.currencyPending\)/);
});

test('a long level switch scrolls inside itself, and the active pill stays seen', () => {
  const css = read('../../../market/src/seller-segments.css');
  const many = /\.segment-levels\.is-many \{([^}]*)\}/.exec(css)?.[1] || '';
  assert.ok(many, 'the switch has no many-levels rule');
  // Five names must not become two lines of chips, and must not widen the tile.
  assert.match(many, /flex-wrap: nowrap;/);
  assert.match(many, /overflow-x: auto;/);
  assert.match(many, /max-width: 100%;/);
  // A flick past either end is the switch's own business, not the page's.
  assert.match(many, /overscroll-behavior-x: contain;/);
  assert.match(css, /\.segment-levels\.is-many button \{[^}]*flex: none;[^}]*white-space: nowrap;/);
  // Four pills on a desktop tile and two on a phone still read as before, so
  // the threshold is the width the table itself was measured at.
  assert.match(tableSrc, /levels\(\)\.length > \(sparkSize\(\) === SPARK_PHONE \? 2 : 4\)/);
  assert.match(tableSrc, /classList=\{\{ 'is-many': manyLevels\(\) \}\}/);
  // The active level is revealed with `scrollLeft` on the switch and the two
  // rectangles, not `scrollIntoView` (which takes the page with it, vertically
  // included) and not `offsetLeft` (the pill row is not a positioned box).
  assert.match(tableSrc, /if \(rect\.left < boxRect\.left\) node\.scrollLeft -= boxRect\.left - rect\.left;/);
  assert.match(tableSrc, /else if \(rect\.right > boxRect\.right\) node\.scrollLeft \+= rect\.right - boxRect\.right;/);
  assert.doesNotMatch(tableSrc, /scrollIntoView|offsetLeft/);
  // The pills stay plain buttons in tab order: no roving tabindex, no tablist,
  // and a tabbed pill scrolls itself into view in any engine.
  assert.doesNotMatch(tableSrc, /tabindex/i);
  assert.doesNotMatch(tableSrc, /role="tablist"/);
  assert.match(tableSrc, /role="group"/);
});

test('the window is anchored to the days the model has, and the level it opens on', () => {
  // The table asks the shared helper for both, instead of counting back from
  // today (an empty tail of "None held") or always opening on "All games".
  assert.match(tableSrc, /const windowRange = createMemo\(\(\) => segmentWindow\(model\(\), props\.range\)\)/);
  assert.match(tableSrc, /segmentGroups\(model\(\), levelId\(\), windowRange\(\)\)/);
  assert.match(tableSrc, /collectionSeries\(model\(\), win\)/);
  assert.match(tableSrc, /const defaultLevel = \(\) => defaultSegmentLevel\(model\(\)\)/);
  assert.doesNotMatch(tableSrc, /utcDayKey\(\)/);
  // A row is open only while it is on this level and plottable, so a chart
  // never outlives the button that would close it.
  assert.match(tableSrc, /const openRow = createMemo\(\(\) => rows\(\)\.find\(\(row\) => row\.key === open\(\) && row\.state === 'ok'\)/);
  assert.doesNotMatch(tableSrc, /open\(\) === row\.key/);
  assert.match(tableSrc, /isOpen\(row\(\)\.key\)/);
});

test('a refresh keeps the rows it painted instead of remounting the table', () => {
  // Both lists are keyed, so a new day — or a range change — moves the rows
  // rather than rebuilding them: focus stays and the open chart does not replay.
  assert.match(tableSrc, /<For each=\{groups\(\)\} keyed=\{\(group\) => group\.title\}>/);
  assert.match(tableSrc, /<For each=\{group\(\)\.rows\} keyed=\{\(row\) => row\.key\}>/);
});

test('both observers are disconnected, and the effect returns the cleanup', () => {
  // This Solid version gives an effect body no owner: an `onCleanup` called
  // there registers nowhere. The disconnect is the effect's return value, so a
  // closed chart and an unmounted table both let go of their observer.
  assert.doesNotMatch(tableSrc, /onCleanup\(/);
  assert.equal([...tableSrc.matchAll(/return \(\) => observer\.disconnect\(\);/g)].length, 2);
  assert.match(tableSrc, /createEffect\(\(\) => \(visible\(\) \? 1 : 0\), \(mounted\) => \{/);
  assert.match(tableSrc, /createEffect\(\(\) => openRow\(\)\?\.key \|\| '', \(key\) => \{/);
});

test('an opened chart is decoration; the legend carries the numbers', () => {
  const chart = /function VersusChart\(props\) \{([\s\S]*?)\n\}/.exec(tableSrc)?.[1] || '';
  assert.ok(chart, 'the desk renders no versus chart');
  assert.match(chart, /<svg[^>]*aria-hidden="true"[^>]*>/);
  assert.match(chart, /class="segment-chart-days"/);
  // A closed row points at no id: `segment-chart-*` exists only while open.
  assert.doesNotMatch(tableSrc, /aria-controls=\{`segment-chart/);
});

test('the chart lines are one and a half to two device pixels', () => {
  const css = read('../../../market/src/seller-segments.css');
  assert.match(css, /\.segment-series-line \{[^}]*stroke-width: 2;/);
  assert.match(css, /\.segment-spark-line \{[^}]*stroke-width: 1\.5;/);
  assert.match(css, /\.segment-collection-line \{[^}]*stroke-width: 1\.5;/);
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

test('the row sparkline puts its end dot on the line, not the corner', () => {
  // The dot is a pure helper's job, because `sparkPoints` answers `[x, y]`
  // pairs: reading `.x`/`.y` off a pair leaves the circle at (0, 0).
  assert.match(tableSrc, /sparkEndPoint\(/);
  const circle = tableSrc.match(/<circle\s+class="segment-spark-dot"[^>]*\/>/);
  assert.ok(circle, 'the row sparkline draws no end dot');
  assert.match(circle[0], /\bcx=\{[^{}]+\.x\}/);
  assert.match(circle[0], /\bcy=\{[^{}]+\.y\}/);
});

test('a phone row is one line: name, sparkline, amount with its change', () => {
  const css = read('../../../market/src/seller-segments.css');
  // The phone block alone: a nested rule closes indented, so the first
  // column-zero brace ends the media query.
  const phone = /@media \(max-width: 520px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] || '';
  assert.ok(phone, 'the segment CSS has no phone block');
  // Four tracks of the same width in every row, so the columns line down the
  // table; only the name is flexible and it ellipsizes before anything else.
  assert.match(phone, /grid-template-columns: minmax\(0, 1fr\) 72px minmax\(0, 5\.5rem\) 1rem;/);
  assert.match(phone, /\.segment-row \.segment-label \{\s*grid-column: 1;\s*grid-row: 1 \/ span 2;/);
  assert.match(phone, /\.segment-row \.segment-spark \{\s*grid-column: 2;\s*grid-row: 1 \/ span 2;/);
  assert.match(phone, /\.segment-row \.segment-value \{\s*grid-column: 3;\s*grid-row: 1;/);
  assert.match(phone, /\.segment-row \.segment-change \{\s*grid-column: 3;\s*grid-row: 2;/);
  // The chevron stays, and the years go under the name instead of beside it.
  assert.match(phone, /\.segment-row \.segment-chevron \{\s*grid-column: 4;\s*grid-row: 1 \/ span 2;/);
  assert.match(phone, /\.segment-label \{[^}]*flex-direction: column;/);
  const hidden = [...phone.matchAll(/([^{}]+)\{\s*display: none;/g)].map((m) => m[1]).join(' ');
  assert.ok(hidden.includes('.segment-cards'), 'the cards count is what the phone drops');
  assert.ok(!hidden.includes('.segment-chevron'), 'the phone row keeps its chevron');
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
