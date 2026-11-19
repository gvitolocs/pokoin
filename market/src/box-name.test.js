import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ambiguousBoxName,
  BOX_NAME_CHOICE_KEY,
  boxNameAskTitle,
  boxNameChoiceLabels,
  isLocationStyleUnconfirmed,
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
