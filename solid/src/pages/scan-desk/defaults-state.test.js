import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptSuggestion,
  batchFlag,
  displaySlots,
  draftValue,
  gearState,
  isLocationOff,
  LOCATION_OFF_PATCH,
  locationFieldState,
  locationSuggestion,
  MAX_TRACKED_BATCHES,
  parseBatchFlags,
  pendingDraft,
  serializeBatchFlags,
  setBatchFlag,
  sizeCommit,
  STACK_OFF_PATCH,
  STACK_SETUP_OFF_ENABLED,
  stackSplitPatch,
} from './defaults-state.js';

// The Location seed and the "Off" switches. `locationSuggestion` is the whole
// gate: the seed answers a box, and this decides whether the desk may even show
// it. The answers themselves come from `fetchSellerBoxSlots`. The stack-off
// tests run with the gate forced on, passed as a parameter: the shipped build
// keeps STACK_SETUP_OFF_ENABLED false and never offers the choice.

test('a seed answer never wins against a field the seller is typing in', () => {
  // The 700 ms pause: the batch default is still empty while "mega" is typed.
  assert.equal(
    draftValue({ focused: true, draft: 'mega', serverValue: '712' }),
    'mega',
    'the typed text stays in the field',
  );
  // Once the field is left go the desk adopts the batch default again.
  assert.equal(draftValue({ focused: false, draft: 'mega', serverValue: 'A1' }), 'A1');
  // The seed is only ever a suggestion while the box is unknown.
  assert.equal(locationSuggestion({ boxes: ['712'], location: '', touched: false }), '712');
  assert.equal(locationSuggestion({ boxes: ['712'], location: 'mega', touched: true }), '');
});

test('a cleared location is never seeded again for that batch', () => {
  // Clearing is a choice: the seed stays silent across reloads through the flag.
  const stored = serializeBatchFlags(setBatchFlag({}, 'batch-1', 'locationTouched', true));
  assert.equal(batchFlag(parseBatchFlags(stored), 'batch-1', 'locationTouched'), true);
  assert.equal(locationSuggestion({ boxes: ['712'], location: '', touched: true }), '');
  assert.equal(acceptSuggestion({ suggestion: '712', location: '', touched: true }), null);
  // Another batch of the same seller is still a fresh start.
  assert.equal(batchFlag(parseBatchFlags(stored), 'batch-2', 'locationTouched'), false);
});

test('a scan accepts the box the seller was shown, and nothing else does', () => {
  assert.deepEqual(acceptSuggestion({ suggestion: '712', location: '', touched: false }), { location: '712' });
  // Already a box: the scan must not move the batch to the newest listing.
  assert.equal(acceptSuggestion({ suggestion: '712', location: 'A1', touched: false }), null);
  assert.equal(acceptSuggestion({ suggestion: '', location: '', touched: false }), null);
});

test('emptying cards per stack and leaving it means Off, not the old number', () => {
  // Off state: the gate is forced on, passed as a parameter.
  assert.deepEqual(sizeCommit('', true), { kind: 'off' });
  assert.deepEqual(sizeCommit('  ', true), { kind: 'off' });
  assert.deepEqual(sizeCommit('40', true), { kind: 'size', size: 40 });
  // Junk never applies (and never silently keeps the old number either).
  assert.deepEqual(sizeCommit('abc'), { kind: 'invalid' });
  assert.deepEqual(sizeCommit('0'), { kind: 'invalid' });
});

test('the shipped build never offers the stack-off choice', () => {
  assert.equal(STACK_SETUP_OFF_ENABLED, false, 'the gate ships closed');
  // An emptied "Cards per stack" is a keep: the bar restores the number.
  assert.deepEqual(sizeCommit(''), { kind: 'keep' });
  assert.deepEqual(sizeCommit('  '), { kind: 'keep' });
  // The gear never greys from stack-off…
  const gear = gearState({ off: true, size: 80, stack: 4, startPosition: 3, locationOff: false });
  assert.equal(gear.greyed, false, 'no stack-off greyed state without the server value');
  assert.equal(gear.showSize, true, 'the gear keeps its number');
  // …and rows keep the suffix the listing will really have.
  const slots = new Map([['row-1', { stack: 4, start: 2, end: 2, stackSize: 80 }]]);
  assert.equal(displaySlots(slots, { off: true }), slots);
});

test('stack setup Off greys the gear, hides its number and freezes the cursor', () => {
  const off = gearState({ off: true, offEnabled: true, size: 80, stack: 4, startPosition: 3, locationOff: false });
  assert.equal(off.greyed, true);
  assert.equal(off.showSize, false, 'the gear shows no number');
  assert.match(off.title, /Off/);
  assert.match(off.title, /Choose cards per stack to switch it on/, 'the title says how to switch it on');

  const on = gearState({ off: false, size: 80, stack: 4, startPosition: 3, locationOff: false });
  assert.equal(on.greyed, false);
  assert.equal(on.showSize, true);
  assert.match(on.title, /80 cards per stack, stack 4, next position 3/);

  // With no box there is nothing to stack in: the gear is greyed and says so.
  const noBox = gearState({ off: false, size: 80, stack: 4, startPosition: 3, locationOff: true });
  assert.equal(noBox.greyed, true);
  assert.match(noBox.title, /type a box/i);
});

test('location off greys the field and keeps the suggestion as a placeholder', () => {
  assert.equal(isLocationOff({ location: '' }), true);
  assert.equal(isLocationOff({ location: '  ' }), true);
  assert.equal(isLocationOff({ location: '712' }), false);

  const suggested = locationFieldState({ location: '', suggestion: '712' });
  assert.equal(suggested.off, true);
  assert.equal(suggested.placeholder, '712', 'placeholder style, not a value');
  assert.match(suggested.title, /Box of your newest listing: 712/);

  const cleared = locationFieldState({ location: '', suggestion: '' });
  assert.equal(cleared.placeholder, '');
  assert.match(cleared.title, /new rows get no location/);

  const set = locationFieldState({ location: '712', suggestion: '' });
  assert.equal(set.off, false);
  assert.equal(set.placeholder, '');
});

test('off rows keep the plain box name with no stack or position suffix', () => {
  // slotText of scan-model renders the suffix out of a slot; the desk hands it
  // nothing at all while the stack setup is Off, so the box name stands alone.
  // The gate is forced on, passed as a parameter.
  const slots = new Map([['row-1', { stack: 4, start: 2, end: 2, stackSize: 80 }]]);
  assert.equal(slots.get('row-1').stack, 4, 'on: the slot is there to suffix');
  assert.equal(displaySlots(slots, { off: true, offEnabled: true }).has('row-1'), false, 'off: no slot, no suffix');
  assert.equal(displaySlots(slots, { off: false }), slots);
  assert.equal(displaySlots(undefined, { off: false }) instanceof Map, true);
});

test('off is sent as the closest value today server accepts', () => {
  // normalize_defaults clamps 0 back to 1, so an off stack setup travels as
  // "one card per stack" and the desk keeps the Off state itself.
  assert.deepEqual(STACK_OFF_PATCH, { stackSize: 1 });
  assert.deepEqual(LOCATION_OFF_PATCH, { location: '' });
});

test('a pending draft is flushed before a row is created with the old box', () => {
  assert.equal(pendingDraft({ draft: 'mega', applied: '712' }), 'mega');
  // An emptied field is a pending change too: clearing means no location.
  assert.equal(pendingDraft({ draft: '', applied: '712' }), '');
  assert.equal(pendingDraft({ draft: '712', applied: '712' }), null);
  assert.equal(pendingDraft({ draft: undefined, applied: '' }), null);
});

test('the stored batch flags survive junk and prune themselves', () => {
  assert.deepEqual(parseBatchFlags(''), {});
  assert.deepEqual(parseBatchFlags('not json'), {});
  assert.deepEqual(parseBatchFlags('[]'), {});
  assert.deepEqual(parseBatchFlags('{"b1":{"stackOff":true,"extra":1}}'), { b1: { stackOff: true } });
  const flags = setBatchFlag(setBatchFlag({}, 'b1', 'stackOff', true), 'b1', 'locationTouched', true);
  assert.deepEqual(flags, { b1: { stackOff: true, locationTouched: true } });
  // Turning both off leaves no entry behind, so the store cannot grow forever.
  const cleared = setBatchFlag(setBatchFlag(flags, 'b1', 'stackOff', false), 'b1', 'locationTouched', false);
  assert.deepEqual(cleared, {});
  assert.equal(setBatchFlag(flags, '', 'stackOff', true), flags, 'no batch id, no write');
});

test('a batch worked on again is never the one dropped from the store', () => {
  let flags = {};
  for (let i = 0; i < MAX_TRACKED_BATCHES; i += 1) flags = setBatchFlag(flags, `old-${i}`, 'stackOff', true);
  flags = setBatchFlag(flags, 'current', 'stackOff', true);
  assert.deepEqual(Object.keys(flags).slice(0, 2), ['old-1', 'old-2'], 'the oldest batch went');
  assert.equal(batchFlag(flags, 'current', 'stackOff'), true);
  // Working on an old one again moves it to the end instead of evicting it.
  flags = setBatchFlag(flags, 'old-100', 'locationTouched', true);
  assert.equal(Object.keys(flags).at(-1), 'old-100');
  flags = setBatchFlag(flags, 'current', 'locationTouched', true);
  assert.equal(batchFlag(flags, 'current', 'stackOff'), true);
  assert.equal(Object.keys(flags).length, MAX_TRACKED_BATCHES);
});

// The split answer of the "New box …?" question (CARD-07): the box and the stack
// the seller named leave together in one defaults patch, or the desk answers the
// stack from the new box's stock and the number they wrote is lost.

test('the split answer always carries the stack the seller named', () => {
  // The failing case: the wanted stack already equals the current one, so a
  // stack edit would stay silent — here it must not.
  assert.deepEqual(stackSplitPatch({ wanted: 6, size: 1, current: 6 }), { stack: 6, startPosition: 1 });
  assert.equal(stackSplitPatch({ wanted: 6, size: 1, current: 6 }).stack, 6);
  assert.deepEqual(stackSplitPatch({ wanted: 3, size: 1, current: 6 }), { stack: 3, startPosition: 1 });
  // With a divider the position of a box nobody has entered yet is the desk's
  // to answer; the stack still goes out, which is what stops its own rule.
  assert.deepEqual(stackSplitPatch({ wanted: 6, size: 8, current: 6 }), { stack: 6 });
  assert.deepEqual(stackSplitPatch({ wanted: 12, size: 8, current: 4 }), { stack: 12 });
  // Junk never reaches a patch as 0 or as a huge number.
  assert.deepEqual(stackSplitPatch({ wanted: 'x', size: 1 }), { stack: 1, startPosition: 1 });
  assert.equal(stackSplitPatch({ wanted: 99999, size: 8 }).stack, 9999);
});
