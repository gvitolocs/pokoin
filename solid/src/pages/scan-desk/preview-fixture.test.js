import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The scan desk reads the pricing fixture data statically, so whatever module it
// names ends up inside the ScanDesk chunk that every seller downloads in
// production. The rows belong to the lazily imported MyPokoin fixture only.
const src = fs.readFileSync(new URL('./preview-fixture.js', import.meta.url), 'utf8');

test('the scan desk preview imports the rules module, not the preview book', () => {
  assert.match(src, /from '\.\.\/mypokoin-preview-rules\.js'/);
  assert.doesNotMatch(src, /from '\.\.\/mypokoin-preview-fixture\.js'/);
});
