import assert from 'node:assert/strict';
import test from 'node:test';
import { cardmarketChoices, needsCardmarketChooser } from './cardmarket-matches.js';

const V1 = 'https://www.cardmarket.com/en/Pokemon/Products/Singles/XY-Black-Star-Promos/M-Sharpedo-EX-V1-XYPRXY200';
const V2 = 'https://www.cardmarket.com/en/Pokemon/Products/Singles/XY-Black-Star-Promos/M-Sharpedo-EX-V2-XYPRXY200a';

test('two verified products open the chooser in source order', () => {
  const choices = cardmarketChoices({
    primary: V1,
    matches: [
      { url: V1, source: 'printing_link', label: 'XY Black Star Promos · M Sharpedo EX V1 XYPRXY200' },
      { url: V2, source: 'parsing', label: 'XY Black Star Promos · M Sharpedo EX V2 XYPRXY200a' },
    ],
  });
  assert.equal(choices.primary, V1);
  assert.deepEqual(choices.matches.map((m) => [m.url, m.source]), [[V1, 'printing_link'], [V2, 'parsing']]);
  assert.equal(needsCardmarketChooser(choices), true);
});

test('one match or none keeps the single-page button', () => {
  assert.equal(needsCardmarketChooser(cardmarketChoices({ primary: V1, matches: [{ url: V1, source: 'parsing', label: 'x' }] })), false);
  const generated = cardmarketChoices({ primary: 'https://www.cardmarket.com/en/Pokemon/Products/Singles?searchString=dawn+129', matches: [] });
  assert.equal(generated.primary.startsWith('https://www.cardmarket.com/'), true);
  assert.equal(needsCardmarketChooser(generated), false);
});

test('duplicate and non-Cardmarket URLs never become choices', () => {
  const choices = cardmarketChoices({
    primary: 'javascript:alert(1)',
    matches: [{ url: V1 }, { url: ` ${V1} ` }, { url: 'https://evil.example/cardmarket.com/' }, null, { url: V2, label: '' }],
  });
  assert.equal(choices.primary, '');
  assert.deepEqual(choices.matches.map((m) => m.url), [V1, V2]);
  assert.equal(choices.matches[1].label, 'Cardmarket');
});

test('a malformed answer is no choices, so the button falls back to the redirect', () => {
  for (const data of [null, undefined, {}, { matches: 'nope' }, []]) {
    const choices = cardmarketChoices(data);
    assert.equal(choices.primary, '');
    assert.equal(needsCardmarketChooser(choices), false);
  }
});
