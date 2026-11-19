import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { LOCATION_ASK_QUESTION, locationReadingLabels } from '../../../../market/src/box-name.js';

// CARD-07 in the CardTrader Power Tools import dialog: a CSV location that ends in a
// number has two honest readings, so the dialog asks and the import waits. The rule
// itself lives in market/src/box-name.js and is unit-tested there; these asserts pin
// the wiring — that the dialog actually asks, and never sends a reading nobody chose.

const modal = fs.readFileSync(new URL('./CardTraderPowerToolsModal.jsx', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('./CardTraderConnectPanel.jsx', import.meta.url), 'utf8');

/** Source between two unique markers (end exclusive). */
function between(source, startMarker, endMarker, from = 0) {
  const start = source.indexOf(startMarker, from);
  assert.ok(start >= 0, `${startMarker} exists`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} exists after ${startMarker}`);
  return source.slice(start, end);
}

test('the detected mode is not preselected while the reading is ambiguous', () => {
  const adopt = between(modal, "createEffect(\n    () => (step() === 'preview'", 'const suggested = Number(preview.suggestedStackSize)');
  assert.match(adopt, /if \(!locationTouched\(\) && !needsLocationConfirmation\(preview\)\.needed && preview\.locationParse\)/);
  assert.doesNotMatch(adopt, /if \(!locationTouched\(\) && preview\.locationParse\)/, 'the old unconditional adopt is gone');
  // An unambiguous CSV still adopts the detected mode exactly as before.
  assert.match(adopt, /setLocationParse\(preview\.locationParse\)/);
  assert.match(modal, /const \[locationParse, setLocationParse\] = createSignal\('auto'\)/);
});

test('the dialog asks the question and shows both readings of the locations in the file', () => {
  const ask = between(modal, "<Show when={confirmation().needed}>", '<fieldset class="ct-pt-fieldset"');
  assert.match(ask, /\{LOCATION_ASK_QUESTION\}/, 'the question is the shared sentence, word for word');
  assert.match(ask, /<code>\{reading\.raw\}<\/code>/, 'the seller sees the location they wrote');
  assert.match(ask, /\{labels\(\)\.asBox\}/);
  assert.match(ask, /\{labels\(\)\.asStack\}/);
  assert.match(ask, /const labels = \(\) => locationReadingLabels\(reading\)/);
  assert.match(ask, /confirmation\(\)\.count > confirmation\(\)\.examples\.length/, 'a long list says how much it left out');
  // The three choices are tied to the question for a screen reader.
  assert.match(modal, /aria-describedby=\{confirmation\(\)\.needed \? 'ct-pt-ask-title' : undefined\}/);
  // Wording is the module's, and both outcomes name the same box.
  const reading = { raw: 'Focobomba 006', asBox: 'Focobomba 006', asStack: { box: 'Focobomba', stack: 6 } };
  assert.deepEqual(locationReadingLabels(reading), { asBox: 'box Focobomba 006', asStack: 'box Focobomba, stack 6' });
  assert.equal(
    LOCATION_ASK_QUESTION,
    'Some locations end in a number. Is that number part of the box name?',
  );
});

test('no import starts while the reading is unchosen, and the button says why', () => {
  assert.match(modal, /const awaitingChoice = createMemo\(\(\) => confirmation\(\)\.needed && !modeChosen\(\)\)/);
  assert.match(
    modal,
    /disabled=\{busyAll\(\) \|\| !canImport\(\) \|\| awaitingChoice\(\)\}\s*title=\{awaitingChoice\(\) \? LOCATION_ASK_PENDING : undefined\}\s*onClick=\{confirmFull\}/s,
    'the gate is on the import button itself',
  );
  assert.match(modal, /<p class="ct-pt-ask-note">\{LOCATION_ASK_PENDING\}<\/p>/);
});

test('the request carries the chosen mode and never an auto the server would guess', () => {
  const confirm = between(modal, 'async function confirmFull()', 'const close = ');
  assert.match(confirm, /const parse = locationParseToSend\(\{\s*chosen: modeChosen\(\) \? locationParse\(\) : 'auto',\s*detected: props\.preview\?\.locationParse,\s*needed: confirmation\(\)\.needed,\s*\}\)/);
  assert.match(confirm, /if \(!parse\) return false;/, 'nothing is sent until a reading exists');
  assert.match(confirm, /locationParse: parse/, 'the payload gets the resolved mode, not the signal');
  assert.doesNotMatch(confirm, /locationParse: locationParse\(\)/);
  assert.doesNotMatch(confirm, /\|\| 'auto'/, 'auto never reaches the server');
  // Picking a choice is also what dismisses the question.
  const radio = between(modal, 'name="ct-pt-location-parse"', '</fieldset>');
  assert.match(radio, /setLocationTouched\(true\);\s*setLocationParse\(mode\.id\);\s*setModeChosen\(true\);\s*setAsk\(null\)/);
});

test('a 409 refusal reopens the same question with the examples it carries', () => {
  const confirm = between(modal, 'async function confirmFull()', 'const close = ');
  const catchBlock = between(confirm, '} catch (err) {', 'return true;');
  assert.match(catchBlock, /if \(!isLocationStyleUnconfirmed\(err\)\) throw err;/, 'any other failure still surfaces as an error');
  assert.match(catchBlock, /setLocationParse\('auto'\)/, 'the unchosen state returns, so nothing half-applied is kept');
  assert.match(catchBlock, /setAsk\(locationAskFromRefusal\(err\)\)/);
  assert.match(catchBlock, /setLocationTouched\(false\)/);
  // The answer wins over the preview until the seller chooses or the state resets.
  assert.match(modal, /const confirmation = createMemo\(\(\) => \{\s*if \(ask\(\)\) return ask\(\);/);
  assert.match(modal, /return needsLocationConfirmation\(props\.preview\);/);
  for (const reset of [between(modal, 'function invalidateUploadState()', 'createEffect(() => Boolean(props.open)'),
    between(modal, 'setModeChosen(false);\n    setAsk(null);', 'setAnalyzeToken(0)')]) {
    assert.match(reset, /setAsk\(null\)/, 'a reset forgets a refusal nobody answered');
  }
});

test('the panel keeps the dialog open for its own refusal instead of closing it', () => {
  const run = between(panel, 'async function runSync(', 'function onSyncNow()');
  assert.match(run, /\{ holdModalOpen = false \} = \{\}/);
  assert.match(run, /if \(!holdModalOpen\) setPtModalOpen\(false\);/);
  assert.match(run, /if \(holdModalOpen && isLocationStyleUnconfirmed\(err\)\) throw err;/);
  assert.match(run, /setError\(err\.message \|\| 'Could not sync CardTrader inventory\.'\)/, 'any other failure is still an error line');
  assert.match(panel, /onConfirmWithCsv=\{\(opts\) => runSync\(opts, '', \{ holdModalOpen: true \}\)\}/);
});

// Finding A: a reading belongs to the file it was read from. Every event that
// changes what is about to be imported clears the mode and its touched flag, and
// only a click after the current analyze answer counts as the seller's choice.

test('a mode read from one file is never carried over to the next', () => {
  const invalidate = between(modal, 'function invalidateUploadState()', 'createEffect(() => Boolean(props.open)');
  assert.match(invalidate, /setLocationParse\('auto'\)/);
  assert.match(invalidate, /setLocationTouched\(false\)/);
  assert.match(invalidate, /setModeChosen\(false\)/);
  assert.match(invalidate, /setAsk\(null\)/);
  // The three events that change what will be imported all go through it.
  const mode = between(modal, 'function setMode(next) {', 'function onFile(');
  assert.match(mode, /invalidateUploadState\(\)/);
  const file = between(modal, 'function onFile\(gameId, file\) \{', 'const uploadedIds');
  assert.equal(file.match(/invalidateUploadState\(\)/g).length, 2, 'a replaced file and a removed one');
  assert.match(modal, /onClick=\{invalidateUploadState\}>\s*Change CSV/s, 'Change CSV is one of those events too');
  // Reopening the dialog starts from nothing.
  const reopen = between(modal, 'createEffect(() => Boolean(props.open)', 'function setMode');
  assert.match(reopen, /setModeChosen\(false\)/);
});

test('only a click is a choice, and a mode the dialog adopted is not one', () => {
  const adopt = between(modal, "createEffect(\n    () => (step() === 'preview'", 'const suggested = Number(preview.suggestedStackSize)');
  assert.doesNotMatch(adopt, /setModeChosen\(true\)/, 'adopting the detected mode marks nothing');
  assert.match(adopt, /setLocationParse\(preview\.locationParse\)/);
  const radio = between(modal, 'name="ct-pt-location-parse"', '</fieldset>');
  assert.match(radio, /setModeChosen\(true\)/);
  assert.match(modal, /const awaitingChoice = createMemo\(\(\) => confirmation\(\)\.needed && !modeChosen\(\)\)/);
  const confirm = between(modal, 'async function confirmFull()', 'const close = ');
  assert.match(confirm, /chosen: modeChosen\(\) \? locationParse\(\) : 'auto'/, 'an adopted mode is not sent as consent');
  assert.match(between(confirm, '} catch (err) {', 'return true;'), /setModeChosen\(false\)/, 'a refusal takes the choice back');
});
