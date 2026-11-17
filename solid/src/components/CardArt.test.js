import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const art = read('./CardArt.jsx');

test('a failed scan is fetched once more (r=1) before the missing-card scan', () => {
  assert.match(art, /import \{[^}]*MISSING_CARD_RETRY_MS[^}]*retryImageUrl[^}]*\} from '@market\/missing-card\.js';/);
  assert.match(art, /const \[retry, setRetry\] = createSignal\(\(\) => \(urls\(\), 0\)\);/);
  assert.match(art, /const shown = \(\) => retryImageUrl\(current\(\), retry\(\)\);/);
  assert.match(art, /src=\{props\.full \|\| gateOpen\(\) \? shown\(\) : undefined\}/);
  assert.match(art, /setTimeout\(\(\) => \{[\s\S]*?setIndex\(0\);\s*setRetry\(1\);[\s\S]*?\}, MISSING_CARD_RETRY_MS\);/);
  // The dead mark is written only after the retry round ran out, for 6 h.
  const retryAt = art.indexOf('if (retryable && !retry())');
  const deadAt = art.indexOf('rememberImageFallback(list[0], DEAD_IMAGE');
  assert.ok(retryAt > 0 && deadAt > retryAt);
  assert.match(art, /rememberImageFallback\(list\[0\], DEAD_IMAGE, \{ keepMs: 6 \* 60 \* 60_000 \}\);/);
  // Memo keys are the un-busted sibling URLs.
  assert.match(art, /rememberImageFallback\(urls\(\)\[0\], current\(\)\)/);
});

test('the CardTrader 186×260 placeholder goes dead without a retry', () => {
  assert.match(art, /isCardTraderPlaceholderSize\([\s\S]*?failCurrent\(\{ retryable: false \}\);/);
  assert.match(art, /onError=\{\(\) => failCurrent\(\)\}/);
});
