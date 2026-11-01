import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const form = readFileSync(new URL('./ListingForm.jsx', import.meta.url), 'utf8');

test('the form never lists in a hidden PKN state after a reset', () => {
  assert.match(form, /const listIn = untrack\(currencyManual \? currency : sellerCurrency\);/);
  assert.match(form, /LIST_CURRENCIES\.filter\(\(code\) => code !== 'PKN'\)/);
});
