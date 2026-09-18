import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const pageSrc = fs.readFileSync(path.join(root, 'pages/Collection.jsx'), 'utf8');
const apiSrc = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
const deskCss = fs.readFileSync(path.join(root, 'desk.css'), 'utf8');

test('Collection red cross removes physical holdings via the authenticated BFF', () => {
  assert.match(pageSrc, /removeCollectionItem/);
  assert.match(pageSrc, /data-testid="collection-remove"/);
  assert.match(pageSrc, /aria-label=\{`Remove \$\{row\.cardName \|\| row\.name \|\| row\.cardId\} from collection`\}/);
  // Only physical rows pass onRemove; NFT holdings keep no red cross.
  assert.match(pageSrc, /onRemove=\{removeItem\}/);
  assert.match(pageSrc, /nft\.map\(\(row\) => <HoldingRow key=\{row\.id\} row=\{row\} \/>\)/);
  // The row updates in place from the API result (after/deleted).
  assert.match(pageSrc, /result\.deleted/);
  assert.match(pageSrc, /quantity: result\.after/);

  assert.match(apiSrc, /export function removeCollectionItem/);
  assert.match(apiSrc, /\/api\/marketplace-collection\?action=remove/);
  assert.match(apiSrc, /method: 'POST'/);
  assert.match(apiSrc, /JSON\.stringify\(\{ itemId, quantity \}\)/);
});

test('Collection red cross is a styled X that hides while the remove is in flight', () => {
  assert.match(deskCss, /\.thread-remove \{/);
  assert.match(deskCss, /#f87171/);
  assert.match(deskCss, /#ef4444/);
  assert.match(pageSrc, /className="thread-remove"/);
  assert.match(pageSrc, /disabled=\{removing\}/);
  assert.match(pageSrc, /<path d="M6 6l12 12M18 6L6 18" \/>/);
});
