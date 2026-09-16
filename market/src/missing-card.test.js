import assert from 'node:assert/strict';
import test from 'node:test';
import { isCardTraderPlaceholderSize, MISSING_CARD_SRC } from './missing-card.js';

test('only the CardTrader 186×260 fallback counts as a missing-scan placeholder', () => {
  assert.equal(isCardTraderPlaceholderSize(186, 260), true);
  assert.equal(isCardTraderPlaceholderSize(180, 251), false);
  assert.equal(isCardTraderPlaceholderSize(240, 335), false);
  assert.equal(isCardTraderPlaceholderSize(733, 1024), false);
  assert.equal(isCardTraderPlaceholderSize(0, 0), false);
});

test('missing-card asset is a same-origin 63:88 WebP', () => {
  assert.equal(MISSING_CARD_SRC, '/home/missing-card.webp');
});
