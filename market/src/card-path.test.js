import assert from 'node:assert/strict';
import test from 'node:test';
import { printingSlugFromCanonicalPath } from './card-path.js';

test('printing slug is the segment after /cards/:id on prefixed and pokemon paths', () => {
  assert.equal(
    printingSlugFromCanonicalPath('/marketplace/en/cards/342436/card-charizard'),
    'card-charizard',
  );
  assert.equal(printingSlugFromCanonicalPath('/marketplace/en/cards/342436'), '');
  assert.equal(
    printingSlugFromCanonicalPath('/one-piece/marketplace/en/cards/598560/luffy'),
    'luffy',
  );
  assert.equal(
    printingSlugFromCanonicalPath('/star-wars/marketplace/en/cards/795832/uncommon-the-student-guides-the-master?currency=EUR'),
    'uncommon-the-student-guides-the-master',
  );
  assert.equal(printingSlugFromCanonicalPath(''), '');
});
