import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const apiSrc = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
const deskCss = fs.readFileSync(path.join(root, 'desk.css'), 'utf8');

// The Collection tab markup is guarded in solid/src/components/inventory/CollectionHoldings.test.js.
test('the collection remove BFF is an authenticated POST', () => {
  assert.match(apiSrc, /export function removeCollectionItem/);
  assert.match(apiSrc, /\/api\/marketplace-collection\?action=remove/);
  assert.match(apiSrc, /method: 'POST'/);
  assert.match(apiSrc, /JSON\.stringify\(\{ itemId, quantity \}\)/);
});

test('Collection red cross is a styled red X', () => {
  assert.match(deskCss, /\.thread-remove \{/);
  assert.match(deskCss, /#f87171/);
  assert.match(deskCss, /#ef4444/);
});
