import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(root, 'pages/Checkout.jsx'), 'utf8');

test('PKN balance voucher is opt-in and priced at 2 PKN per euro-cent', () => {
  assert.match(src, /useState\(false\); \/\/ opt-in PKN balance voucher/);
  assert.match(src, /Use my PKN balance as a discount/);
  assert.match(src, /pknDiscountEurCents = usePknDiscount \? pknVoucherEurCents : 0/);
  assert.match(src, /usePknDiscount: pknDiscountPkn >= 1/);
  assert.doesNotMatch(src, /pknDiscountPkn \* 50|\/ 50,/);
});

test('checkout does not claim the card is charged in EUR', () => {
  assert.doesNotMatch(src, /charged in EUR|Stripe charges EUR/);
});
