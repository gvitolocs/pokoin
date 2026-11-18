import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { normalizeCollections } from '../../../market/src/portfolio-collections.js';
import {
  PREVIEW_COLLECTIONS,
  previewCollectionsFrom,
} from '../../../market/src/portfolio-collections-preview.js';
import {
  COLLECTIONS_LEVEL,
  collectionSeriesOn,
  normalizeSegments,
  segmentGroups,
  segmentLevels,
  segmentWindow,
  withCollections,
} from '../../../market/src/portfolio-segments.js';
import { previewSegmentsFrom } from '../../../market/src/portfolio-segments-preview.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const homeSrc = read('./SellerHome.jsx');
const viewSrc = read('../components/dashboard/SellerDashboardView.jsx');
const tableSrc = read('../components/dashboard/SegmentTable.jsx');
const editorSrc = read('../components/dashboard/CollectionEditor.jsx');
const bookSrc = read('../lib/collections-book.js');
const css = read('../../../market/src/seller-collections.css');
const segmentsCss = read('../../../market/src/seller-segments.css');

/** Ten days of book value, enough for a change and a plotted line. */
function series() {
  return Array.from({ length: 10 }, (_, i) => ({
    date: `2026-11-${String(i + 8).padStart(2, '0')}`,
    currencyPkn: 10,
    cardsKnown: true,
    cardsValuePkn: 1000 + i * 25,
    cardsHeld: 12,
    cardsPriced: 9,
  }));
}

function previewModel() {
  const answer = previewCollectionsFrom(series());
  return withCollections(
    normalizeSegments(previewSegmentsFrom(series())),
    normalizeCollections(answer).model,
  );
}

test('the page owns one book, asked for on the seller id and nothing else', () => {
  assert.match(homeSrc, /import \{ createCollectionsBook \} from '\.\.\/lib\/collections-book\.js';/);
  assert.match(homeSrc, /const collections = createCollectionsBook\(\);/);
  // Its own effect, on `sellerUid`: a signed-out desk asks for nothing, and a
  // different seller never sees what the previous one had open.
  assert.match(homeSrc, /createEffect\(\s*\(\) => sellerUid\(\),\s*\(id\) => \{\s*collections\.load\(id\);/);
  assert.match(homeSrc, /collections=\{collections\}/);
  // Live and preview both hand the same object down: two call sites, one prop.
  assert.equal([...homeSrc.matchAll(/collections=\{collections\}/g)].length, 2);
});

test('the saved lists do not ride the value graph', () => {
  // The history request, its segment side cache and the retry are one block;
  // the book is not in it, so a slow collections read cannot delay the graph
  // and a failing one cannot take the table's own model down.
  const from = homeSrc.indexOf('fetchPortfolioHistory(token)');
  const to = homeSrc.indexOf('// The saved collections, keyed on the seller');
  assert.ok(from > 0 && to > from, 'the history block is not where the segment tests expect it');
  assert.doesNotMatch(homeSrc.slice(from, to), /collections\.(load|reload|save|remove)/);
  assert.ok(homeSrc.indexOf('collections.load(id)') > to, 'the book loads in its own effect, after the history one');
});

test('one model is split: the levels, then the saved lists inside it', () => {
  const model = previewModel();
  assert.ok(segmentLevels(model).some((level) => level.id === 'collections'), 'no Collections level');
  const rows = segmentGroups(model, 'collections', {}).flatMap((group) => group.rows);
  assert.deepEqual(rows.map((row) => row.label), PREVIEW_COLLECTIONS.map((row) => row.name));
  assert.ok(rows.every((row) => row.state === 'ok'), 'a saved list with a price plots a line');
  // Copies are what the row counts, so the sealed list with one never-sold box
  // says how much of it the desk can actually price.
  const sealed = rows.find((row) => row.label === 'What if: 2023 sealed');
  assert.ok(sealed.held > sealed.priced, 'a never-sold product still counts as held');
  // And the compare line is the book on the collection's own days: versusPaths
  // plots by index, so an unaligned pair would compare a Tuesday to a Friday.
  const open = rows[0];
  const compare = collectionSeriesOn(model, open.series);
  assert.deepEqual(compare.map((day) => day.date), open.series.map((day) => day.date));
  assert.ok(compare.every((day) => Number(day.valuePkn) > 0), 'the book has a value on every plotted day');
});

test('the desk hands the table the nested model, not two sources', () => {
  // One call, one rule: the saved lists are nested by the helper that also
  // decides they wait for the history read to be over.
  assert.match(viewSrc, /joinedSegments\(\{[\s\S]{0,220}pending: Boolean\(props\.historyPending\),[\s\S]{0,140}collections: props\.collections\?\.model\(\) \|\| null,[\s\S]{0,40}\}\)/);
  assert.doesNotMatch(viewSrc, /withCollections\(/);
  assert.match(viewSrc, /<SegmentTable[\s\S]{0,40}model=\{segmentModel\(\)\}/);
  assert.doesNotMatch(viewSrc, /<SegmentTable[\s\S]{0,60}model=\{props\.segments \|\| null\}/);
  assert.match(viewSrc, /collections=\{props\.collections \|\| null\}/);
  // The editor exists only while a list is being edited, and a new list to edit
  // is a new dialog: `keyed` is what throws the old draft away.
  assert.match(viewSrc, /<Show keyed when=\{props\.collections\?\.editing\(\)\}>/);
  assert.match(viewSrc, /book=\{props\.collections\}/);
});

test('the book is the only thing that talks to the API', () => {
  assert.match(bookSrc, /import \{ getBearer \} from '\.\.\/stores\/auth\.js';/);
  assert.match(bookSrc, /fetchCollections: fetchPortfolioCollections/);
  assert.match(bookSrc, /saveCollection: savePortfolioCollection/);
  assert.match(bookSrc, /deleteCollection: deletePortfolioCollection/);
  assert.match(bookSrc, /createCollectionsStore\(\{/);
  assert.match(bookSrc, /store\.subscribe\(setView\);\s*onCleanup\(stop\);/);
  // The table's two questions are values on the snapshot, so reading them in
  // render tracks them; calling the store would read a closure and miss.
  assert.match(bookSrc, /const atLimit = \(\) => view\(\)\.atLimit;/);
  assert.match(bookSrc, /model: \(\) => view\(\)\.levelModel/);
  // Switching seller closes what they had open.
  assert.match(bookSrc, /if \(String\(uid \|\| ''\) !== store\.get\(\)\.uid\) setEditing\(null\);/);
  // The editor never asks for a price: it reads what the answer already says.
  assert.doesNotMatch(editorSrc, /fetchPriceCheck|fetchPortfolioCollections|savePortfolioCollection|deletePortfolioCollection/);
});

test('the Collections level says what it cannot do yet', () => {
  // The button stays on screen at the limit and explains itself — a control
  // that is dead with no reason reads as a broken page.
  assert.match(tableSrc, /You can keep up to \$\{limit\(\)\} collections\. Delete one first\./);
  assert.match(tableSrc, /disabled=\{!book\(\) \|\| full\(\)\}/);
  assert.match(tableSrc, /data-testid="segment-collections-new"/);
  // A load that failed is this level's line and its retry, not a dead table,
  // and the retry says so while it is out instead of taking the level with it.
  assert.match(tableSrc, /<Show when=\{book\(\)\?\.error\(\) \|\| book\(\)\?\.pending\(\)\}>/);
  assert.match(tableSrc, /\{book\(\)\.pending\(\) \? 'Loading…' : message\(\)\}/);
  assert.match(tableSrc, /disabled=\{Boolean\(book\(\)\.pending\(\)\)\} data-testid="segment-collections-retry" onClick=\{\(\) => book\(\)\?\.reload\(\)\}>Try again</);
  // An empty saved list still says so; an empty row says no cards yet.
  assert.match(tableSrc, /emptyNote=\{isCollections\(\) \? 'No cards yet' : ''\}/);
  assert.match(tableSrc, /data-testid="segment-collections-none"/);
  // The opened row answers how much of the list the desk can price.
  assert.match(tableSrc, /`Priced \$\{cards\(row\.priced\)\} of \$\{cards\(row\.held\)\} cards`/);
  // And one delete, confirmed in place, with the list named in the question.
  assert.match(tableSrc, /Delete “\{props\.row\.label\}” and its history\?/);
  assert.match(tableSrc, /data-testid=\{`segment-collection-confirm-\$\{props\.row\.key\}`\}/);
});

test('a saved list with nothing sold still opens: Edit and Delete live there', () => {
  const lists = [
    { id: 'sealed', name: 'Sealed nobody sold', items: [{ game: 'pokemon', cardId: '176014', name: 'Evolving Skies Booster Bundle', quantity: 2, pricePkn: null }] },
    { id: 'bare', name: 'List with no card', items: [] },
  ];
  const model = withCollections(
    normalizeSegments(previewSegmentsFrom(series())),
    normalizeCollections(previewCollectionsFrom(series(), lists)).model,
  );
  const rows = segmentGroups(model, COLLECTIONS_LEVEL, segmentWindow(model, { id: '1M', days: 30 }))
    .flatMap((group) => group.rows);
  // Neither has a line to plot, which is exactly the case that used to strand a
  // list: a row with no series is drawn by PlainRow, and only the table decides
  // whether it opens.
  assert.deepEqual(rows.map((row) => row.state), ['unpriced', 'empty']);
  assert.match(tableSrc, /onToggle=\{isCollections\(\) \? \(\) => toggleRow\(row\(\)\.key\) : undefined\}/);
  assert.match(tableSrc, /&& row\.state === 'ok'\) \|\| openCollection\(\)\);/);
  // What it opens to is the counts and the two buttons, not an empty chart.
  assert.match(tableSrc, /<Show when=\{row\(\)\.state === 'ok'\}>\s*<p class="segment-legend">/);
  assert.match(tableSrc, /<Show when=\{row\(\)\.state === 'ok'\}>\s*<VersusChart/);
  assert.match(tableSrc, /No card in this list yet\. Edit adds one\./);
  // The pointer cursor returns only for a plain row that is a button.
  assert.match(segmentsCss, /button\.segment-row\.is-plain \{\n\s*cursor: pointer;/);
});

test('the editor keeps its own draft and closes without sending it', () => {
  assert.match(editorSrc, /role="dialog"/);
  assert.match(editorSrc, /aria-modal="true"/);
  assert.match(editorSrc, /onKeyDown=\{onKey\}/);
  // Escape and Cancel are the same thing: throw the draft away.
  assert.match(editorSrc, /onClose: \(\) => props\.onClose\(\),/);
  assert.match(editorSrc, /onClick=\{\(\) => props\.onClose\(\)\} data-testid="collections-cancel"/);
  // A refused save says why in the dialog's own voice and keeps every field.
  assert.match(editorSrc, /setServerProblem\(answer\?\.message \|\| 'Could not save the collection\.'\)/);
  assert.match(editorSrc, /disabled=\{saving\(\) \|\| Boolean\(problems\(\)\.length\)\}/);
  assert.match(editorSrc, /import '@market\/seller-collections\.css';/);
});

test('the card search sends the public id of the game the picker shows', () => {
  // The header's game uses the header's typeahead; anything else is the
  // marketplace search, asked for cards of that game.
  assert.match(editorSrc, /createSignal\(props\.hostGame \|\| game\(\)\.id\)/);
  assert.match(editorSrc, /createLiveSuggest\(query, \{ kind: 'singles', limit: SEARCH_LIMIT \}\)/);
  assert.match(editorSrc, /productType: 'card', game: gameId/);
  // A result with no public card id is dropped, not sent as something else.
  assert.match(editorSrc, /filter\(\(row\) => \/\^\\d\+\$\/\.test\(row\.cardId\)\)/);
  assert.doesNotMatch(editorSrc, /product_id|listing_id|blueprintId/);
});

test('an amount is written in the currency the desk shows, or not at all', () => {
  // The editor and the table share one label rule, and neither defaults to PKN:
  // while the display currency is still being read the cell keeps its shape with
  // a placeholder instead of the wrong unit.
  assert.match(editorSrc, /import \{ assetsAmountLabel as amount \} from '@market\/seller-currency\.js';/);
  assert.match(tableSrc, /import \{ assetsAmountLabel as amount \} from '@market\/seller-currency\.js';/);
  assert.doesNotMatch(editorSrc, /formatPknNumber|formatAssetsValue/);
  assert.doesNotMatch(editorSrc, /props\.currency \|\| 'PKN'/);
  assert.match(editorSrc, /pending: '—',/);
  assert.match(editorSrc, /itemPriceLine\(item\(\), \{ currencyPending: Boolean\(props\.currencyPending\) \}\)/);
  assert.match(viewSrc, /currency=\{props\.moverCurrency \|\| ''\}\n\s*currencyPending=\{Boolean\(props\.moverCurrencyPending\)\}/);
});

test('a row shows the server price of its exact slice, or says it has none', () => {
  // Which line a row shows is the module's decision (itemPriceLine); the form
  // only writes it, and only the server's answer ever becomes an amount.
  assert.match(editorSrc, /itemPriceLine,[\s\S]*\} from '@market\/portfolio-collections\.js';/);
  assert.match(editorSrc, /const line = createMemo\(\(\) => itemPriceLine\(item\(\), \{ currencyPending: Boolean\(props\.currencyPending\) \}\)\)/);
  assert.match(editorSrc, /\{line\(\) === 'amount' \? amount\(item\(\)\.pricePkn, props\.currency\) : PRICE_TEXT\[line\(\)\]\}/);
  // A card new to the list, or one a facet has moved off its priced slice, waits
  // for the save. A search result's number is what somebody asks for a card.
  assert.match(editorSrc, /later: 'Priced after saving'/);
  assert.match(editorSrc, /sold: 'No sold price'/);
  assert.doesNotMatch(editorSrc, /pricePkn:/);
  // Only an amount wears the gold of a number.
  assert.match(editorSrc, /collections-item-price\$\{line\(\) === 'amount' \? '' : ' is-note'\}/);
  assert.match(css, /\.collections-item-price\.is-note \{\n\s*color: var\(--muted\);/);
});

test('the item rows use the listing forms vocabulary and clamp copies', () => {
  assert.match(editorSrc, /import \{ LIST_LANGS, MOOD_CONDS \} from '@market\/card-desk\.js';/);
  assert.match(editorSrc, /<For each=\{MOOD_CONDS\}>/);
  assert.match(editorSrc, /<For each=\{LIST_LANGS\}>/);
  assert.doesNotMatch(editorSrc, /<option value="NM">|conditionOptions|LANGUAGES =/);
  assert.match(editorSrc, /min="1"/);
  assert.match(editorSrc, /max=\{props\.limits\.quantity\}/);
  assert.match(editorSrc, /reverse: event\.currentTarget\.checked/);
  assert.match(editorSrc, /firstEdition: event\.currentTarget\.checked/);
  assert.match(editorSrc, /graded: event\.currentTarget\.checked/);
  // Today's price is the answer's, and a card the desk cannot price says so.
  assert.match(editorSrc, /'No sold price'/);
  // The count the brief asks for, straight off the server's limit.
  assert.match(editorSrc, /\$\{draft\(\)\.items\.length\} of \$\{limits\(\)\.items\} cards/);
});

test('one card in the draft is one row, and keeps what is typed in it', () => {
  // Keyed on the id the draft mints when the row enters — not the slice key,
  // which every facet change rewrites. A new object under the same key updates
  // the row in place, and the focus in it survives.
  assert.match(editorSrc, /<For each=\{draft\(\)\.items\} keyed=\{\(row\) => row\.rowId\}>/);
  assert.match(editorSrc, /\{\(item\) => \(\n\s+<ItemRow\n\s+item=\{item\(\)\}/);
  // The copies field is the seller's text until it lets go of it: an empty field
  // stays empty instead of being rewritten under the caret.
  assert.match(editorSrc, /const copies = createMemo\(\(\) => typed\(\) \?\? String\(item\(\)\.quantity\)\)/);
  assert.match(editorSrc, /value=\{copies\(\)\}/);
  assert.match(editorSrc, /onInput=\{\(event\) => setTyped\(event\.currentTarget\.value\)\}/);
  assert.match(editorSrc, /onBlur=\{commit\}/);
  // Committing is the module's own clamp, and only ever writes a change.
  assert.match(editorSrc, /commitQuantity\(typed\(\), item\(\)\.quantity, props\.limits\)/);
  assert.match(editorSrc, /if \(value !== item\(\)\.quantity\) patch\(\{ quantity: value \}\)/);
  assert.doesNotMatch(editorSrc, /onInput=\{\(event\) => patch\(\{ quantity: Number/);
});

test('the collections CSS is tokens, and a phone gets the whole screen', () => {
  // No hex: both colour schemes come from the dashboard tokens alone.
  assert.deepEqual([...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]), []);
  const tokens = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  const defined = read('../../../market/src/styles.css') + read('../../../market/src/seller-home.css');
  for (const token of tokens) {
    assert.ok(defined.includes(`${token}:`), `${token} is used but never defined`);
  }
  // Under 520px the dialog is the screen, not a card inside a scrollable page.
  const phone = /@media \(max-width: 520px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] || '';
  assert.ok(phone, 'the collections CSS has no phone block');
  assert.match(phone, /\.collections-editor \{\n\s*top: 0;\n\s*left: 0;\n\s*translate: none;/);
  assert.match(phone, /width: 100%;/);
  assert.match(phone, /height: 100%;/);
  assert.match(phone, /border-radius: 0;/);
  // Every control a thumb works with, and nothing that can widen the page.
  assert.match(phone, /min-height: 44px;/);
  for (const selector of ['.collections-field input', '.collections-field select', '.collections-mini select', '.collections-foot .btn', '.segment-collections-new']) {
    assert.ok(phone.includes(selector), `the phone block leaves ${selector} at its desktop height`);
  }
  // The button that opens the whole dialog is a thumb target too, and the body
  // keeps its own scroll: a flick past the end of the list must not move the
  // dashboard behind it, and the page itself cannot scroll while it is up.
  assert.match(css, /\.collections-body \{\n\s*overscroll-behavior: contain;/);
  assert.match(editorSrc, /const overflow = document\.body\.style\.overflow;\n\s*document\.body\.style\.overflow = 'hidden';/);
  assert.match(editorSrc, /return \(\) => \{\n\s*document\.body\.style\.overflow = overflow;/);
  assert.match(css, /overflow-wrap: anywhere;/);
  assert.match(css, /\.collections-editor \{[^}]*width: min\(46rem, calc\(100vw - 1\.5rem\)\);/);
});

test('the preview fixture is the same two lists the API shape carries', () => {
  const [binder, sealed] = PREVIEW_COLLECTIONS;
  assert.equal(binder.items.length, 6);
  assert.ok(binder.items.some((item) => item.graded), 'the binder has a slab in it');
  assert.ok(binder.items.some((item) => item.reverse || item.firstEdition), 'and a marked or 1st printing');
  assert.equal(sealed.items.length, 3);
  assert.ok(sealed.items.some((item) => item.pricePkn == null), 'one product nobody has sold');
  const answer = previewCollectionsFrom(series(), PREVIEW_COLLECTIONS);
  assert.equal(answer.limits.collections, 20);
  assert.deepEqual(answer.segmentDefs.map((def) => def.group), ['collection', 'collection']);
  const normalized = normalizeCollections(answer);
  assert.deepEqual(normalized.collections.map((row) => row.id), [binder.id, sealed.id]);
  // Memory only: the fixture answers whoever asks and never reaches for a token.
  // It seeds itself on the first ask and then answers with what the desk holds,
  // so deleting the last list leaves the empty level on screen.
  assert.match(homeSrc, /previewAnswer: \(rows, seeding\) => previewCollectionsFrom\(/);
  assert.match(homeSrc, /seeding \? PREVIEW_COLLECTIONS : rows/);
  assert.doesNotMatch(homeSrc, /rows\.length \? rows : PREVIEW_COLLECTIONS/);
  assert.match(homeSrc, /createEffect\(\(\) => 'preview', \(\) => \{ collections\.load\('preview'\); \}\);/);
});
