import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const panel = fs.readFileSync(new URL('./NativeSales.jsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../../../../market/src/api.js', import.meta.url), 'utf8');

/**
 * CARD-01 P7: "Sold on Pokoin" was an async memo with no cache behind it, so the
 * panel existed only from the frame its answer landed — a section inserted under
 * a visitor who had already moved on. With the sold-slices cache pattern the desk
 * paints it in its first frame or does not have it, and a re-read that agrees with
 * what is drawn stays off the DOM.
 */
test('the panel paints from the stored rows, not from the answer', () => {
  assert.match(panel, /import \{ peekNativeSales, saveNativeSales \} from '@market\/native-sales-cache\.js';/);
  assert.match(panel, /const \[sales, setSales\] = createSignal\(peekNativeSales\(id\)\?\.sales \?\? null\);/);
  // No Suspense round trip decides when this panel appears.
  assert.doesNotMatch(panel, /Loading|createMemo/);
});

test('the stored rows are still re-read, and a failed read keeps them drawn', () => {
  const read = panel.slice(panel.indexOf('fetchNativeSales(id'), panel.indexOf('const rows = ()'));
  assert.match(read, /const rows = Array\.isArray\(data\?\.sales\) \? data\.sales : null;\n\s*if \(!rows\) return;/);
  assert.match(read, /saveNativeSales\(id, rows\);/);
  assert.ok(read.indexOf('saveNativeSales(id, rows)') < read.indexOf('setSales('), 'stored, then painted');
  // The cache paints the first frame, never the data the desk keeps showing, and
  // an answer identical to it does not rebuild the list.
  assert.match(read, /setSales\(\(prev\) => \(prev && JSON\.stringify\(prev\) === JSON\.stringify\(rows\) \? prev : rows\)\);/);
  assert.match(read, /\.catch\(\(\) => \{\n\s*\/\* the rows this desk already showed are better than none \*\//);
});

test('the panel is one section, shown for rows it already has', () => {
  assert.match(panel, /const rows = \(\) => sales\(\) \|\| \[\];/);
  assert.match(panel, /<Show when=\{rows\(\)\.length\}>\n\s*<section class="panel native-sales" aria-label="Sold on Pokoin">/);
  assert.equal((panel.match(/class="panel native-sales"/g) || []).length, 1);
});

test('the neighbour warm writes the very store this panel reads', () => {
  const at = api.indexOf('if (native) {');
  const warm = api.slice(at, at + 400);
  assert.match(warm, /fetchNativeSales\(id, \{ signal \}\)/);
  assert.match(warm, /if \(Array\.isArray\(data\?\.sales\)\) saveNativeSales\(id, data\.sales\);/);
  assert.match(api, /import \{ saveNativeSales \} from '\.\/native-sales-cache\.js';/);
});
