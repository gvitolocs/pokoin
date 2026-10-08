// Render-core tests for the Pokoin News article renderer (task W1).
// Uses the sample records in news/fixtures/sample-articles.json unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateArticle } from '../lib/schema.mjs';
import { esc } from '../lib/html.mjs';
import { formatDate, formatPkn } from '../lib/format.mjs';
import { niceTicks, renderChart } from '../lib/charts.mjs';
import { renderArticleBody } from '../lib/article.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'sample-articles.json'), 'utf8'));
const ctx = { baseUrl: 'https://pokoin.com' };

const render = (record) => renderArticleBody(record, ctx);
const clone = (record) => JSON.parse(JSON.stringify(record));
const byTemplate = (template) => fixtures.find((record) => record.template === template);

test('1. every fixture is valid and renders exactly one escaped <h1>', () => {
  assert.ok(fixtures.length >= 3, 'expected at least three fixture records');
  for (const record of fixtures) {
    assert.deepEqual(validateArticle(record).errors, [], `fixture ${record.slug} must validate`);
    const html = render(record);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${record.slug} must have one h1`);
    assert.ok(
      html.includes(`<h1 class="nx-h1">${esc(record.headline)}</h1>`),
      `${record.slug} h1 must equal the escaped headline`,
    );
  }
});

test('2. every paragraph block text appears in the rendered body', () => {
  for (const record of fixtures) {
    const html = render(record);
    const paragraphs = (record.blocks || []).filter((block) => block && block.type === 'paragraph');
    for (const block of paragraphs) {
      assert.ok(html.includes(esc(block.text)), `${record.slug}: missing "${block.text.slice(0, 40)}…"`);
    }
  }
});

test('3. analysis block renders the POKO ANALYSIS label and the fixed note', () => {
  const html = render(byTemplate('market_pulse'));
  assert.ok(html.includes('POKO ANALYSIS'));
  assert.ok(
    html.includes("Analysis is Poko's interpretation of the evidence above. It adds no new facts."),
    'analysis note must be present verbatim',
  );
});

test('4. fact_check renders the verdict text and an icon glyph', () => {
  const record = byTemplate('fact_check');
  const block = record.blocks.find((entry) => entry.type === 'fact_check');
  const html = render(record);
  assert.ok(html.includes(`<strong>${block.verdict}</strong>`), 'verdict text is required');
  assert.ok(html.includes('DISPUTED'), 'verdict must be shown as text');
  assert.ok(html.includes('⇄'), 'verdict must carry an icon glyph, not colour alone');
  assert.ok(html.includes('nx-verdict--disputed'));
});

test('5. market module visibility, values, window, currency and source note', () => {
  const reveal = byTemplate('reveal');
  assert.equal(reveal.market, null);
  assert.ok(!render(reveal).includes('POKOIN MARKET DATA'), 'null market must be hidden');

  const marketRecord = byTemplate('market_pulse');
  const insufficient = clone(marketRecord);
  insufficient.market.sufficient = false;
  assert.ok(!render(insufficient).includes('POKOIN MARKET DATA'), 'insufficient market must be hidden');

  const html = render(marketRecord);
  assert.ok(html.includes('POKOIN MARKET DATA'));
  for (const metric of marketRecord.market.metrics) {
    const expected = metric.unit === 'PKN' ? formatPkn(metric.value) : `${metric.value} ${metric.unit}`;
    assert.ok(html.includes(expected), `metric ${metric.id} must render as "${expected}"`);
  }
  assert.ok(!html.includes('50,126'), 'PKN values must not carry thousands separators');
  const window = marketRecord.market.window;
  const fromShort = formatDate(window.from).replace(/,\s*\d{4}$/, '');
  assert.ok(
    html.includes(`Window: ${fromShort} – ${formatDate(window.to)} (${window.days} days)`),
    'window must render a human-readable range with the shared year written once',
  );
  assert.ok(html.includes('Currency: PKN'));
  assert.ok(html.includes(marketRecord.market.sourceNote));
  assert.ok(html.includes(`Observations: ${marketRecord.market.observations}`));
});

test('6. charts expose role/title/desc, tabulate every point, and drop thin series', () => {
  const record = byTemplate('market_pulse');
  for (const chart of record.market.charts) {
    const svg = renderChart(chart);
    assert.ok(svg.includes('role="img"'), `${chart.id} needs role="img"`);
    assert.ok(svg.includes(`<title id="${chart.id}-t">${esc(chart.title)}</title>`));
    assert.ok(svg.includes(`<desc id="${chart.id}-d">${esc(chart.summary)}</desc>`));
    assert.ok(svg.includes('Data table'));
    for (const series of chart.series) {
      for (const point of series.points) {
        assert.ok(svg.includes(String(point.y)), `${chart.id} must tabulate ${point.y}`);
      }
    }
  }
  const chart = record.market.charts[0];
  assert.equal(renderChart({ ...chart, series: [] }), '', 'empty series must render nothing');
  assert.equal(
    renderChart({ ...chart, series: [{ label: 'One', points: [{ x: '2026-09-11', y: 5 }] }] }),
    '',
    'single-point series must render nothing',
  );
});

test('7. related_card without listings omits the Pokoin listings line', () => {
  const record = byTemplate('market_pulse');
  const withoutListings = clone(record);
  withoutListings.related.cards[0].listings = null;
  const html = render(withoutListings);
  assert.ok(!html.includes('Listings tracked by Pokoin'), 'missing listings must not be shown');
  assert.ok(html.includes('View card'));

  const withListings = render(record);
  assert.ok(withListings.includes('Listings tracked by Pokoin: 100 from 88 sellers'));
});

test('8. sources section lists every source url and tags primary sources', () => {
  const record = byTemplate('reveal');
  const html = render(record);
  for (const source of record.sources) {
    assert.ok(html.includes(source.url), `source url ${source.url} must appear`);
    assert.ok(html.includes(`id="src-${source.id}"`), `source anchor src-${source.id} must appear`);
  }
  assert.ok(html.includes('Primary source'));
  assert.ok(!render(byTemplate('fact_check')).includes('Primary source'), 'secondary-only sources carry no primary tag');
});

test('9. dynamic text is escaped', () => {
  const record = clone(byTemplate('reveal'));
  record.headline = 'Pokémon TCG <script>alert(1)</script> reveals Delta Reign promos';
  const html = render(record);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'), 'raw script markup must not survive rendering');
});

test('10. the Updated time appears only when dateModified is later', () => {
  const updated = render(byTemplate('reveal'));
  assert.ok(updated.includes('Published <time'));
  assert.ok(updated.includes('Updated <time'));

  const unchanged = render(byTemplate('fact_check'));
  assert.ok(unchanged.includes('Published <time'));
  assert.ok(!unchanged.includes('Updated <time'));
});

test('11. niceTicks(0, 97, 4) returns round ascending ticks covering 0..97', () => {
  const ticks = niceTicks(0, 97, 4);
  assert.ok(Array.isArray(ticks));
  assert.ok(ticks.length >= 2);
  assert.ok(ticks[0] <= 0, 'first tick must cover the minimum');
  assert.ok(ticks[ticks.length - 1] >= 97, 'last tick must cover the maximum');
  for (let index = 1; index < ticks.length; index += 1) {
    assert.ok(ticks[index] > ticks[index - 1], 'ticks must ascend');
  }
  for (const tick of ticks) assert.ok(Number.isInteger(tick), `tick ${tick} must be a round number`);
});

test('update notes: date-only notes show the day and never repeat "Update —"', async () => {
  const { renderBlock } = await import('../lib/blocks.mjs');
  const record = fixtures[0];
  const dated = renderBlock({ type: 'update_note', at: '2026-10-03T00:00:00.000Z', text: 'Update — October 3: Dexerto now carries the report.' }, record, {});
  assert.match(dated, /Update — Oct 3, 2026<\/strong> Dexerto now carries the report\./);
  const timed = renderBlock({ type: 'update_note', at: '2026-10-05T15:03:00.000Z', text: 'Pokémon confirmed the date.' }, record, {});
  assert.match(timed, /Update — 15:03 UTC<\/strong> Pokémon confirmed the date\./);
});

test('reading-stats hooks: cards and the article carry id and path; dashboard slug is reserved', async () => {
  const { renderArticleCard } = await import('../lib/pages.mjs');
  const { RESERVED_SLUGS, articlePath } = await import('../lib/schema.mjs');
  const record = fixtures[0];
  const card = renderArticleCard(record);
  assert.ok(card.includes(`data-article-id="${esc(record.id)}"`));
  assert.ok(card.includes(`data-article-path="${esc(articlePath(record))}"`));
  const body = render(record);
  assert.match(body, /<article class="nx-article[^>]* data-article-id="[^"]+" data-article-path="\/news\/[^"]+">/);
  assert.ok(RESERVED_SLUGS.includes('dashboard'));
});
