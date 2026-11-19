import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const form = readFileSync(new URL('./ListingForm.jsx', import.meta.url), 'utf8');

/** Source between two unique markers (end exclusive). */
function between(source, startMarker, endMarker, from = 0) {
  const start = source.indexOf(startMarker, from);
  assert.ok(start >= 0, `${startMarker} exists`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} exists after ${startMarker}`);
  return source.slice(start, end);
}

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

// Finding D, pinned: the sell form has no place to type a box. The only free-text
// writer left would let the pop-up fire for a name the seller typed, and the review
// asked whether that path exists. It does not — the box arrives from a select or
// from the listing that is being edited, and both of those paths are asserted here.

test('a box name cannot be typed in the sell form, so the ask only ever meets a listed or carried name', () => {
  // Both controls are native selects over boxOptions(); one of them is in the drawer.
  assert.equal(form.match(/<select\n\s*value=\{box\(\)\}\n\s*onChange=\{\(event\) => chooseBox\(event\.currentTarget\.value\)\}\n\s*>/g).length, 2, 'two box selects, no third control');
  assert.equal(form.match(/<For each=\{boxOptions\(\)\}>/g).length, 2, 'every select lists the same options');
  // Options are the seller's own boxes, plus the one the listing being edited already
  // carries when that box is not in their stock. Nothing else can ever be an option.
  const options = between(form, 'const boxOptions = () => {', 'const keptLocation');
  assert.match(options, /stockBoxes\(\)\.map\(\(entry\) => String\(entry\?\.box \|\| ''\)\)\.filter\(Boolean\)/);
  assert.match(options, /if \(current && !names\.some\(\(name\) => name\.toLowerCase\(\) === current\.toLowerCase\(\)\)\) return \[current, \.\.\.names\];/);
  // Which is the complete set of writers of the box signal, and none of them is text:
  // the one effect that follows the listing being edited, the select, the split answer.
  assert.equal(form.match(/setBox\(/g).length, 4, 'the follow effect (both branches), chooseBox, the split answer');
  const follow = between(form, 'createEffect(\n    () => [editingId(), stockBoxes(), ownLocation()', 'const boxOptions');
  assert.match(follow, /setBox\(listingBox\(location \|\| ''\)\);/, 'a carried box is read off the listing');
  assert.match(follow, /const first = String\(boxes\[0\]\?\.box \|\| ''\);/, 'a seeded box is the first of the seller’s own stock');
  // The label that would have been the free-text field is a label for the select.
  assert.match(form, /<label class="sell-field location-pick">\n\s*<span class="sell-drawer-label">Location · private<\/span>\n\s*<select/);
  assert.doesNotMatch(form, /onInput=\{\(event\) => (setBox|chooseBox)/, 'no typing writes a box');
});
