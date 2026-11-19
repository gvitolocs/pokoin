import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { boxNameAskTitle, boxNameChoiceLabels } from '../../../../market/src/box-name.js';

// CARD-07 on the scan desk: a typed location that ends in a number is applied exactly
// as written, and the desk only ever splits it after the seller answers. The rule is
// unit-tested in market/src/box-name.test.js; these asserts pin the wiring in bars.jsx
// and the shared pop-up, because the behaviour lives in the component's own signals.

const bars = fs.readFileSync(new URL('./bars.jsx', import.meta.url), 'utf8');
const ask = fs.readFileSync(new URL('../../components/BoxNameAsk.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../../../market/src/styles.css', import.meta.url), 'utf8');

/** Source between two unique markers (end exclusive). */
function between(source, startMarker, endMarker, from = 0) {
  const start = source.indexOf(startMarker, from);
  assert.ok(start >= 0, `${startMarker} exists`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} exists after ${startMarker}`);
  return source.slice(start, end);
}

const READING = { raw: 'Focobomba 006', asBox: 'Focobomba 006', asStack: { box: 'Focobomba', stack: 6 } };

test('the desk asks only for a name that is ambiguous, unowned and unanswered', () => {
  const gate = between(bars, 'const askBoxName = (value) => {', 'const answerBoxName');
  assert.match(gate, /if \(boxAsk\(\)\) return false;/, 'one question at a time');
  assert.match(gate, /if \(!name \|\| name === askedBoxName\) return false;/, 'the same name is never asked twice');
  assert.match(gate, /ambiguousBoxName\(name\)/);
  assert.match(gate, /shouldAskBoxName\(\{ name, boxes: props\.boxes \|\| \[\], answered: readBoxNameChoices\(\) \}\)/);
  assert.match(gate, /askedBoxName = name;\s*setBoxAsk\(reading\);/);
  assert.match(bars, /<Show when=\{boxAsk\(\)\} keyed>/);
});

test('what was typed is applied before the question opens', () => {
  const commit = between(bars, 'const commitLocation = () => {', 'const askBoxName');
  const apply = between(commit, 'const next = pendingDraft(', 'askBoxName(locationDraft())');
  assert.match(apply, /applyLocation\(next\)/, 'the typed name goes through the same write as any edit');
  assert.match(apply, /const applied = next === null \? undefined : applyLocation\(next\)/);
  assert.match(commit, /askBoxName\(locationDraft\(\)\);\s*return applied;/, 'the ask comes after the write, never instead of it');
  assert.match(bars, /props\.api\?\.\(\{ commitLocation \}\)/, 'a scan commits through the same path');
});

test('the split answer moves the box and the stack field, the keep answer moves nothing', () => {
  const answer = between(bars, 'const answerBoxName = (choice) => {', 'const leaveLocation');
  assert.match(answer, /rememberBoxNameChoice\(reading\.raw, choice\)/, 'the second time the desk does not ask');
  assert.match(answer, /if \(choice !== 'stack'\) return undefined;/, 'the name stays as typed');
  assert.match(answer, /setBoxAsk\(null\)/);
  assert.match(answer, /applyLocation\(reading\.asStack\.box\);\s*setStackDraft\(String\(reading\.asStack\.stack\)\);\s*return commitStack\(\);/);
  // The box write and the stack write are the seller's own paths, not a third one.
  const apply = between(bars, 'const applyLocation = (next) => {', 'const suggestions');
  assert.match(apply, /props\.onChange\(locationPatch\(value\)\)/);
  const commitStack = between(bars, 'const commitStack = () => {', 'const commitPos');
  assert.match(commitStack, /props\.onChange\(\{ stack: n, startPosition: 1 \}\)/);
});

test('a name picked from the suggestions is never a new box, so it is never asked', () => {
  const pick = between(bars, 'const pickBox = (name) => {', 'const commitLocation');
  assert.doesNotMatch(pick, /askBoxName/, 'the menu holds the seller’s own boxes');
  assert.match(pick, /applyLocation\(name\)/);
});

test('the pop-up is a modal whose first answer is what was already applied', () => {
  assert.match(ask, /role="dialog"/);
  assert.match(ask, /aria-modal="true"/);
  assert.match(ask, /aria-labelledby="box-name-ask-title"/);
  assert.match(ask, /useDialogFocus\(\(\) => box, \{\s*onClose: \(\) => props\.onAnswer\?\.\('box'\),\s*first: \(\) => box\?\.querySelector\('\.box-name-ask-keep'\),/s);
  assert.match(ask, /if \(event\.target === box\) props\.onAnswer\?\.\('box'\);/, 'a click outside keeps the typed name');
  assert.match(ask, /<Portal mount=\{document\.body\}>/);
  assert.match(ask, /class="box-name-ask-keep"/);
  assert.match(ask, /props\.onAnswer\?\.\('stack'\)/);
  // The words the seller sees, from the shared rule.
  assert.equal(boxNameAskTitle(READING), 'New box "Focobomba 006"?');
  assert.deepEqual(boxNameChoiceLabels(READING), {
    asBox: 'Box "Focobomba 006"',
    asStack: 'Box "Focobomba", stack 6',
  });
  assert.match(ask, /Nothing is split unless you say so\./);
  assert.match(css, /\.box-name-ask\s*\{[^}]*position: fixed/, 'the pop-up covers the desk');
});

test('the filled button is keep the name as typed, never the split', () => {
  // One dialog primary style for the whole app, and this pop-up shares it.
  assert.match(css, /\.lang-redirect-go,\n\.box-name-ask-keep \{[^}]*background: #f5c518/s, 'keep is the app dialog primary');
  assert.doesNotMatch(css, /\.box-name-ask-split[^{]*\{[^}]*background:/s, 'the split gets no fill of its own');
  // So the split is the outlined secondary the actions row already defines.
  assert.match(css, /\.box-name-ask-actions button \{[^}]*background: transparent/s);
  assert.equal(ask.indexOf('class="box-name-ask-keep"') < ask.indexOf('class="box-name-ask-split"'), true, 'the order is unchanged');
  assert.match(ask, /first: \(\) => box\?\.querySelector\('\.box-name-ask-keep'\)/, 'and focus still starts on the filled one');
});
