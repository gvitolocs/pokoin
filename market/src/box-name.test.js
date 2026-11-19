import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ambiguousBoxName,
  BOX_NAME_CHOICE_KEY,
  boxNameAskTitle,
  boxNameChoiceLabels,
  isLocationStyleUnconfirmed,
  locationAskFromRefusal,
  locationParseToSend,
  locationReadingLabels,
  needsLocationConfirmation,
  readBoxNameChoices,
  rememberBoxNameChoice,
  shouldAskBoxName,
} from './box-name.js';

const AMBIGUOUS = [
  ['Focobomba 006', 'Focobomba 006', 'Focobomba', 6],
  ['Focobomba_007', 'Focobomba_007', 'Focobomba', 7],
  ['Box 12', 'Box 12', 'Box', 12],
];

test('a trailing number with no separator marking is read both ways', () => {
  for (const [raw, asBox, box, stack] of AMBIGUOUS) {
    const reading = ambiguousBoxName(raw);
    assert.ok(reading, `${raw} is ambiguous`);
    assert.equal(reading.raw, raw);
    assert.equal(reading.asBox, asBox);
    assert.equal(reading.asStack.box, box);
    assert.equal(reading.asStack.stack, stack);
  }
  assert.equal(ambiguousBoxName('  Focobomba 006  ').asBox, 'Focobomba 006', 'the name is trimmed');
  assert.equal(ambiguousBoxName('Plasma Crew 2012').asStack.box, 'Plasma Crew');
});

test('a number the seller already structured or spelled out is not ambiguous', () => {
  for (const raw of [
    'FUOCOBOMBA 006 - 16', 'box·2', 'box•2·5', 'Bin #3', 'A1', 'Loose', '12', 'Box-12', '',
  ]) {
    assert.equal(ambiguousBoxName(raw), null, `${raw} is not ambiguous`);
  }
});

test('the stack number is an integer, clamped to what a box can hold', () => {
  assert.equal(ambiguousBoxName('Box 006').asStack.stack, 6);
  assert.equal(ambiguousBoxName('Box 0').asStack.stack, 1);
  assert.equal(ambiguousBoxName('Box 99999').asStack.stack, 9999);
  assert.equal(ambiguousBoxName('12'), null, 'a name of only digits has no head');
});

test('both readings are said the same way everywhere', () => {
  const reading = ambiguousBoxName('Focobomba 006');
  assert.deepEqual(locationReadingLabels(reading), { asBox: 'box Focobomba 006', asStack: 'box Focobomba, stack 6' });
  assert.deepEqual(boxNameChoiceLabels(reading), { asBox: 'Box "Focobomba 006"', asStack: 'Box "Focobomba", stack 6' });
  assert.equal(boxNameAskTitle(reading), 'New box "Focobomba 006"?');
});

test('the analyze answer that carries the new fields decides on its own', () => {
  const answer = {
    locationParse: 'trailing_stack',
    locationExamples: ['Focobomba 006', 'Focobomba 007'],
    ambiguousCount: 14,
    confirmationNeeded: true,
    ambiguousExamples: [{ raw: 'Focobomba 006', asBox: 'Focobomba 006', asStack: { box: 'Focobomba', stack: 6 } }],
  };
  const ask = needsLocationConfirmation(answer);
  assert.equal(ask.needed, true);
  assert.equal(ask.count, 14);
  assert.deepEqual(ask.examples.map((row) => row.raw), ['Focobomba 006']);

  assert.equal(needsLocationConfirmation({ ...answer, confirmationNeeded: false }).needed, false, 'the server says the reading is not at risk');
});

test('an API older than the site is read with the same rule', () => {
  const ask = needsLocationConfirmation({ locationParse: 'trailing_stack', locationExamples: ['Focobomba 006', 'Bin·3', 'Loose'] });
  assert.equal(ask.needed, true);
  assert.equal(ask.count, 1);
  assert.deepEqual(ask.examples[0], { raw: 'Focobomba 006', asBox: 'Focobomba 006', asStack: { box: 'Focobomba', stack: 6 } });

  for (const preview of [{ locationExamples: ['Bin·3', 'Loose'] }, {}, null, undefined]) {
    assert.equal(needsLocationConfirmation(preview).needed, false, `${JSON.stringify(preview)} asks nothing`);
  }
});

test('the examples shown are at most three', () => {
  const ask = needsLocationConfirmation({
    locationExamples: ['Box 1', 'Box 2', 'Box 3', 'Box 4', 'Box 5'],
  });
  assert.equal(ask.examples.length, 3);
  assert.deepEqual(ask.examples.map((row) => row.asStack.stack), [1, 2, 3]);
});

test('the refusal of an unconfirmed import is recognised, anything else is not', () => {
  assert.equal(isLocationStyleUnconfirmed({ status: 409, body: { error: 'location_style_unconfirmed' } }), true);
  assert.equal(isLocationStyleUnconfirmed({ status: 409, body: { error: 'quota' } }), false);
  assert.equal(isLocationStyleUnconfirmed({ status: 500, body: { error: 'location_style_unconfirmed' } }), false);
  assert.equal(isLocationStyleUnconfirmed(new Error('boom')), false);
  assert.equal(isLocationStyleUnconfirmed(null), false);
});

test('the pop-up asks for an ambiguous new name and never for a known one', () => {
  const boxes = ['Focobomba', 'Vetra 2', 'BINDER 12'];
  assert.equal(shouldAskBoxName({ name: 'Focobomba 006', boxes, answered: {} }), true);
  assert.equal(shouldAskBoxName({ name: 'Loose', boxes, answered: {} }), false, 'nothing to ask');
  assert.equal(shouldAskBoxName({ name: 'Vetra 2', boxes, answered: {} }), false, 'the seller already has that box');
  assert.equal(shouldAskBoxName({ name: 'binder 12', boxes, answered: {} }), false, 'a box is matched without its casing');
  assert.equal(shouldAskBoxName({ name: 'Focobomba 006', boxes: [{ box: 'Focobomba 006' }], answered: {} }), false, 'a { box } list works');
  assert.equal(shouldAskBoxName({ name: 'Focobomba 006', boxes, answered: { 'Focobomba 006': 'stack' } }), false, 'answered before');
  assert.equal(shouldAskBoxName({ name: 'Focobomba 006', boxes, answered: ['Focobomba 006'] }), false, 'a list of names works');
  assert.equal(shouldAskBoxName({ name: 'Focobomba 006', boxes, answered: new Set(['Focobomba 006']) }), false, 'a Set works');
  assert.equal(shouldAskBoxName({ name: 'Focobomba 006', boxes, answered: null }), true, 'no storage is no answer');
});

test('the answer is kept per exact name and the page works without storage', () => {
  const saved = globalThis.localStorage;
  const written = {};
  globalThis.localStorage = {
    getItem: (key) => (key === BOX_NAME_CHOICE_KEY ? written[key] ?? null : null),
    setItem: (key, value) => { written[key] = value; },
  };
  try {
    assert.deepEqual(readBoxNameChoices(), {}, 'nothing stored yet');
    assert.equal(rememberBoxNameChoice('Focobomba 006', 'stack'), true);
    assert.deepEqual(readBoxNameChoices(), { 'Focobomba 006': 'stack' });
    assert.equal(shouldAskBoxName({ name: 'Focobomba 006', boxes: [], answered: readBoxNameChoices() }), false);
    assert.equal(shouldAskBoxName({ name: 'Focobomba 006 ', boxes: [], answered: readBoxNameChoices() }), false, 'the same name with its spaces');
    assert.equal(rememberBoxNameChoice('Focobomba 006', 'nonsense'), false, 'only the two answers');
    assert.equal(rememberBoxNameChoice('', 'box'), false, 'an empty name stores nothing');
    written[BOX_NAME_CHOICE_KEY] = '{ not json';
    assert.deepEqual(readBoxNameChoices(), {}, 'a broken entry is no answer');
  } finally {
    if (saved === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = saved;
  }
});

test('a browser with no storage neither reads nor throws', () => {
  const saved = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    assert.deepEqual(readBoxNameChoices(), {});
    assert.equal(rememberBoxNameChoice('Focobomba 006', 'box'), false);
  } finally {
    if (saved !== undefined) globalThis.localStorage = saved;
  }
});

test('the mode sent is the one the seller chose, never an unchosen auto', () => {
  assert.equal(locationParseToSend({ chosen: 'structured', detected: 'trailing_stack', needed: true }), 'structured');
  assert.equal(locationParseToSend({ chosen: 'as_is', detected: 'trailing_stack', needed: false }), 'as_is', 'a choice beats the detected mode');
  assert.equal(locationParseToSend({ chosen: 'auto', detected: 'trailing_stack', needed: false }), 'trailing_stack', 'auto borrows the detected mode when nothing is ambiguous');
  assert.equal(locationParseToSend({ chosen: 'auto', detected: '', needed: false }), 'as_is', 'with nothing detected the locations stay as written');
  assert.equal(locationParseToSend({ chosen: 'auto', detected: 'trailing_stack', needed: true }), null, 'an ambiguous book with no choice sends nothing');
  assert.equal(locationParseToSend({ chosen: '', detected: 'trailing_stack', needed: true }), null);
});

test('the refusal asks the question again even when it carries no examples', () => {
  const body = { error: 'location_style_unconfirmed', locationExamples: ['Focobomba 006'] };
  const ask = locationAskFromRefusal({ status: 409, body });
  assert.equal(ask.needed, true);
  assert.deepEqual(ask.examples.map((reading) => reading.raw), ['Focobomba 006'], 'the answer is the seller’s own example');
  assert.equal(locationAskFromRefusal({ status: 409, body: { error: 'other' } }).needed, true, 'the question is asked regardless of the examples it brings');
  assert.equal(locationAskFromRefusal({ status: 409, body: {} }).needed, true, 'no examples still means the style was never chosen');
});

// The three cases the coordinator asked to see side by side: an ordinary box name, a
// real numbered box, and a name that ends in a year. Each is one rule, not three.

test('Focobomba 006 is ambiguous, and the desk asks for it as a new name', () => {
  const reading = ambiguousBoxName('Focobomba 006');
  assert.deepEqual(reading, {
    raw: 'Focobomba 006',
    asBox: 'Focobomba 006',
    asStack: { box: 'Focobomba', stack: 6 },
  });
  assert.deepEqual(locationReadingLabels(reading), {
    asBox: 'box Focobomba 006',
    asStack: 'box Focobomba, stack 6',
  });
  assert.deepEqual(boxNameChoiceLabels(reading), {
    asBox: 'Box "Focobomba 006"',
    asStack: 'Box "Focobomba", stack 6',
  });
  assert.equal(shouldAskBoxName({ name: 'Focobomba 006', boxes: ['Vetra 2'], answered: {} }), true);
  assert.equal(shouldAskBoxName({ name: 'Focobomba 006', boxes: ['Focobomba 006'], answered: {} }), false, 'already a box of theirs');
});

test('Box 6, a real numbered box, is ambiguous the same way and defaults to the whole name', () => {
  const reading = ambiguousBoxName('Box 6');
  assert.equal(reading.asBox, 'Box 6', 'no answer means the name as written');
  assert.deepEqual(reading.asStack, { box: 'Box', stack: 6 });
  assert.equal(boxNameAskTitle(reading), 'New box "Box 6"?');
  assert.equal(shouldAskBoxName({ name: 'Box 6', boxes: ['A1', 'Vetra 2'], answered: {} }), true);
  // Answered once, the whole name stays the default and nothing is asked again.
  assert.equal(shouldAskBoxName({ name: 'Box 6', boxes: [], answered: { 'Box 6': 'box' } }), false);
});

test('Promo 2023 ends in a year and is still ambiguous, and a past 9999 clamps', () => {
  const reading = ambiguousBoxName('Promo 2023');
  assert.equal(reading.asBox, 'Promo 2023', 'the default stays the whole name');
  assert.deepEqual(reading.asStack, { box: 'Promo', stack: 2023 }, 'the year is inside what a stack can hold');
  assert.deepEqual(locationReadingLabels(reading), { asBox: 'box Promo 2023', asStack: 'box Promo, stack 2023' });
  assert.equal(shouldAskBoxName({ name: 'Promo 2023', boxes: [], answered: {} }), true);
  const clamped = ambiguousBoxName('Promo 20231');
  assert.deepEqual(clamped, {
    raw: 'Promo 20231',
    asBox: 'Promo 20231',
    asStack: { box: 'Promo', stack: 9999 },
  }, 'the rule still reports what the server would do with the row');
  assert.equal(locationReadingLabels(clamped).asStack, 'box Promo, stack 9999');
  // …and the pop-up never offers that number: a stack past 9999 is not one the
  // seller wrote, so the name is kept whole and nothing is asked (finding E).
  assert.equal(shouldAskBoxName({ name: 'Promo 20231', boxes: [], answered: {} }), false);
});

// A stack number the seller cannot have meant is never offered (finding E), an older
// API's empty sample no longer proves nothing is owed (finding B), and a damaged
// stored answer is read as no answer at all (finding F).

test('a trailing number outside a stack is kept whole and never asked', () => {
  assert.equal(ambiguousBoxName('Box 0').asStack.stack, 1, 'the import still shows what the server would do');
  assert.equal(shouldAskBoxName({ name: 'Box 0', boxes: [], answered: {} }), false, '0 is not a stack anyone wrote');
  assert.equal(shouldAskBoxName({ name: 'Box 99999', boxes: [], answered: {} }), false, 'nor is 99999');
  assert.equal(shouldAskBoxName({ name: 'Box 9999', boxes: [], answered: {} }), true, 'the last stack that exists is asked about');
  assert.equal(shouldAskBoxName({ name: 'Box 1', boxes: [], answered: {} }), true);
  assert.equal(shouldAskBoxName({ name: 'Promo 2023', boxes: [], answered: {} }), true, 'a year is inside the range');
});

test('an older API with no ambiguous example still owes the question when it detected a split', () => {
  const empty = needsLocationConfirmation({ locationExamples: [], locationParse: 'trailing_stack' });
  assert.equal(empty.needed, true, 'an empty sample is not proof that nothing is ambiguous');
  assert.deepEqual(empty.examples, [], 'the question comes without example rows');
  const ordinary = needsLocationConfirmation({ locationExamples: ['A1', 'box·2', 'Loose'], locationParse: 'trailing_stack' });
  assert.equal(ordinary.needed, true, 'ambiguous rows may sit outside the sample');
  assert.deepEqual(ordinary.examples, []);
  const split = needsLocationConfirmation({ locationExamples: ['Focobomba 006'], locationParse: 'as_is' });
  assert.equal(split.needed, true);
  assert.deepEqual(split.examples.map((reading) => reading.raw), ['Focobomba 006']);
  // A detected mode that never splits a trailing number needs no confirmation.
  assert.equal(needsLocationConfirmation({ locationExamples: ['A1'], locationParse: 'structured' }).needed, false);
  assert.equal(needsLocationConfirmation({ locationExamples: [], locationParse: '' }).needed, false);
  // When the server answers, its answer decides, as before.
  assert.equal(needsLocationConfirmation({ confirmationNeeded: false, locationExamples: [], locationParse: 'trailing_stack' }).needed, false);
});

test('a damaged stored answer is no answer and a write replaces it', () => {
  const saved = globalThis.localStorage;
  let stored = '{}';
  globalThis.localStorage = {
    getItem: (key) => (key === BOX_NAME_CHOICE_KEY ? stored : null),
    setItem: (key, value) => { stored = value; },
  };
  try {
    for (const damaged of ['[]', 'null', '"x"', '{"Box 6": false}', '{"Box 6": "boxx"}']) {
      stored = damaged;
      assert.deepEqual(readBoxNameChoices(), {}, `${damaged} is read as no answer`);
      assert.equal(shouldAskBoxName({ name: 'Box 6', boxes: [], answered: readBoxNameChoices() }), true, `${damaged} does not suppress the question`);
      assert.equal(rememberBoxNameChoice('Box 6', 'box'), true);
      assert.deepEqual(JSON.parse(stored), { 'Box 6': 'box' }, `${damaged} is replaced by a clean object`);
      assert.equal(shouldAskBoxName({ name: 'Box 6', boxes: [], answered: readBoxNameChoices() }), false);
    }
    stored = '{"A1": "stack", "Box 6": false}';
    assert.deepEqual(readBoxNameChoices(), { A1: 'stack' }, 'only the two values count');
  } finally {
    if (saved === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = saved;
  }
});
