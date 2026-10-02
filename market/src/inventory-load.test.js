import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('inventory top-up uses the bearer from the same callback', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(root, 'pages/Inventory.jsx'), 'utf8');
  assert.match(
    src,
    /then\(async \(token\) => \{[\s\S]*fetchSellerListings\(uid, token[\s\S]*topUpInventory\(uid, token, gen\)/,
  );
  assert.doesNotMatch(
    src,
    /\.then\(\(data\) => \{[\s\S]*topUpInventory\(uid, token/,
  );
});
