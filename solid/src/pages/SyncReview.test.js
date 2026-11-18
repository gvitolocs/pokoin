import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('./SyncReview.jsx', import.meta.url), 'utf8');

// A sync row restates the ask the seller's own listing carries, and the desk
// shows that price in his local currency (docs/SCAN_LISTING_WORKFLOW.md
// "Price": seller's local currency, stored in PKN). PKN is what the row is
// stored in, not what the reconciliation table is for.
test('a sync row prints the stored ask in the seller currency, never PKN', () => {
  assert.equal((src.match(/\{row\.pricePkn \? ` · \$\{formatSellerPrice\(row\.pricePkn, sellerCurrency\(\)\)\}` : ''/g) || []).length, 2);
  assert.match(src, /import \{ formatSellerPrice \} from '@market\/seller-currency\.js';/);
  assert.match(src, /import \{ sellerCurrency \} from '\.\.\/stores\/buyer\.js';/);
  assert.doesNotMatch(src, /formatPkn\(/);
});
