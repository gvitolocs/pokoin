import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const form = readFileSync(new URL('./ListingForm.jsx', import.meta.url), 'utf8');

test('the form never lists in a hidden PKN state after a reset', () => {
  assert.match(form, /const listIn = untrack\(currencyManual \? currency : sellerCurrency\);/);
  assert.match(form, /LIST_CURRENCIES\.filter\(\(code\) => code !== 'PKN'\)/);
});

test('the form sells in the languages of the game the card belongs to', () => {
  assert.match(form, /const gameId = currentGame\(\)\.id;/);
  assert.match(form, /return deskLanguageChips\(\{\n\s*game: gameId,/);
  assert.match(form, /listLangs\(\), \{\n\s*game: gameId,\n\s*nationality: card\(\)\.nationality,/);
});

// CARD-07 in the sell form: the trailing number of a box name is never read as a
// stack unless the seller says so. The rule is unit-tested in
// market/src/box-name.test.js; these asserts pin that the form asks, waits, and
// writes the chosen reading through the same location read the save already used.

test('a box the seller picks is theirs, and the ask comes after the pick', () => {
  assert.match(form, /function chooseBox\(name\) \{\n\s*boxTouched = true;\n\s*setBoxSlot\(NO_BOX_SLOT\);\n\s*setBox\(name\);\n\s*askBoxName\(name\);/);
  assert.match(form, /if \(!shouldAskBoxName\(\{ name, boxes: stockBoxes\(\), answered: readBoxNameChoices\(\) \}\)\) return false;/);
  assert.equal(form.match(/onChange=\{\(event\) => chooseBox\(event\.currentTarget\.value\)\}/g).length, 2, 'both box selects answer through chooseBox');
  assert.doesNotMatch(form, /onChange=\{\(event\) => setBox\(event\.currentTarget\.value\)\}/, 'no select writes the box behind the question');
});

test('as typed keeps the name, and only the chosen split writes box·stack', () => {
  assert.match(form, /if \(choice !== 'stack'\) \{\n\s*setBoxSlot\(NO_BOX_SLOT\);\n\s*return;\n\s*\}/);
  assert.match(form, /rememberBoxNameChoice\(reading\.raw, choice\);/);
  assert.match(form, /setBoxSlot\(\{ box: reading\.asStack\.box, suffix: `·\$\{reading\.asStack\.stack\}` \}\);/);
  assert.match(form, /setBox\(reading\.asStack\.box\);/, 'the split moves the box to the head of the name');
  // The slot only ever decorates the box it was written for.
  assert.match(form, /if \(slot\.suffix && slot\.box\.toLowerCase\(\) === current\.toLowerCase\(\)\) return `\$\{current\}\$\{slot\.suffix\}`;/);
  assert.match(form, /return sameBox \? keptLocation\(\) : nextBoxLocation\(stockBoxes\(\), current\);/, 'untouched, the location is what it was before');
  // Both writes read the location through the one signal the question can move.
  assert.equal(form.match(/location: locationValue\(\)/g).length, 2);
});

test('the save waits while the question is open', () => {
  assert.match(form, /disabled=\{saving\(\) \|\| Boolean\(boxAsk\(\)\) \|\| \(!props\.preview && !ready\(\)\)\}/);
  assert.match(form, /disabled=\{saving\(\) \|\| Boolean\(boxAsk\(\)\) \|\| \(!props\.preview && \(!ready\(\) \|\| !signedIn\(\)\)\)\}/);
  assert.match(form, /disabled=\{!ready\(\) \|\| \(!signedIn\(\) && ready\(\)\) \|\| Boolean\(boxAsk\(\)\)\}/);
  assert.match(form, /<Show when=\{boxAsk\(\)\} keyed>[\s\S]{0,40}BoxNameAsk reading=\{reading\} onAnswer=\{answerBoxName\}/);
  assert.match(form, /import BoxNameAsk from '\.\.\/BoxNameAsk\.jsx';/, 'the desk and the sell form ask with one dialog');
});
