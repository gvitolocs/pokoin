import assert from 'node:assert/strict';
import test from 'node:test';
import { isCardTraderPlaceholderSize, MISSING_CARD_RETRY_MS, MISSING_CARD_SRC, retryImageUrl } from './missing-card.js';

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

test('a retry round adds r=<attempt> without touching the rest of the URL', () => {
  assert.equal(MISSING_CARD_RETRY_MS, 1500);
  assert.equal(retryImageUrl('/card-images/1_a_homepage.webp?v=t480', 1), '/card-images/1_a_homepage.webp?v=t480&r=1');
  assert.equal(retryImageUrl('/card-images/1_a.jpg', 1), '/card-images/1_a.jpg?r=1');
  assert.equal(retryImageUrl('https://cdn.pokoin.com/1_a.jpg?v=bsu2.t480', 1), 'https://cdn.pokoin.com/1_a.jpg?v=bsu2.t480&r=1');
  assert.equal(retryImageUrl('/card-images/1_a.jpg?r=1', 2), '/card-images/1_a.jpg?r=2');
  assert.equal(retryImageUrl('/card-images/1_a.jpg?v=t480&r=1', 2), '/card-images/1_a.jpg?v=t480&r=2');
  assert.equal(retryImageUrl('/card-images/1_a.jpg#x', 1), '/card-images/1_a.jpg?r=1#x');
  assert.equal(retryImageUrl('/card-images/1_a.jpg?v=t480#x', 1), '/card-images/1_a.jpg?v=t480&r=1#x');
  assert.equal(retryImageUrl('/card-images/1_a.jpg?v=t480', 0), '/card-images/1_a.jpg?v=t480');
  assert.equal(retryImageUrl('', 1), '');
});
