import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The defaults write, the Location seed and the Off switches are behaviour of
// the desk's own signals and effects, so these asserts keep the wiring in place
// over the pure rules in defaults-state.js / defaults-write.js. The answers
// themselves are tested there.

const desk = fs.readFileSync(new URL('../ScanDesk.jsx', import.meta.url), 'utf8');
const bars = fs.readFileSync(new URL('./bars.jsx', import.meta.url), 'utf8');
const write = fs.readFileSync(new URL('./defaults-write.js', import.meta.url), 'utf8');
const state = fs.readFileSync(new URL('./defaults-state.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../../../market/src/scan-desk.css', import.meta.url), 'utf8');

/** Source between two unique markers (end exclusive). */
function between(source, startMarker, endMarker, from = 0) {
  const start = source.indexOf(startMarker, from);
  assert.ok(start >= 0, `${startMarker} exists`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} exists after ${startMarker}`);
  return source.slice(start, end);
}

/** The whole defaults write: the entry point and its serialised half. */
function defaultsWrite() {
  return between(desk, 'async function setDefaults(', 'async function undo()');
}

test('a defaults response only overwrites the keys it set', () => {
  const body = defaultsWrite();
  const after = between(body, 'const data = await scanApi.defaults(', 'if (data?.items?.length)');
  assert.match(after, /setBatch\(\(prev\) => applyDefaultsResponse\(prev, \{ patch: nextPatch, view: data\?\.batch \}\)/);
  // The blind whole-batch spread is what repainted a just-chosen default.
  assert.doesNotMatch(after, /\.\.\.data\.batch/);
  assert.match(state, /export function locationSuggestion/);
  // The guard lives in the pure rule, and the desk is the only caller.
  assert.match(write, /version < applied\) return prev/);
  assert.match(write, /defaultsVersion/);
});

test('two defaults writes cannot answer out of order and a failed one rolls back', () => {
  const body = defaultsWrite();
  // One chain per batch, like the row patches already use.
  assert.match(body, /await patchChain\(`defaults:\$\{current\.id\}`, \(\) => saveDefaults\(patch, before\)\)/);
  // The optimistic paint happens before the chain, so the control answers at once.
  assert.ok(
    body.indexOf('defaults: { ...prev.defaults, ...patch }') < body.indexOf('await patchChain('),
    'the choice paints before the write is queued',
  );
  const failure = between(body, '} catch (err) {', '} finally {');
  assert.match(failure, /setBatch\(\(prev\) => rollbackDefaults\(prev, before, nextPatch\)\)/);
  assert.match(failure, /defaultsFailureMessage\(nextPatch\)/);
  // `before` is the defaults as they were before this write painted.
  assert.match(body, /const before = \{ \.\.\.\(current\.defaults \|\| \{\}\) \};/);
});

test('the location stock hint cannot be written out of order', () => {
  const body = defaultsWrite();
  const hint = between(body, 'await fetchSellerBoxSlots(', 'boxStock = {');
  assert.match(hint, /boxStock\.key === key/);
  assert.match(hint, /listingBox\(String\(untrack\(defaults\)\.location \|\| ''\)\.trim\(\)\) === box/);
  assert.match(hint, /untrack\(batch\)\?\.id === current\.id/);
  // The sibling effect keeps its own guards.
  assert.match(desk, /if \(boxStock\.key === key\) return undefined;/);
  assert.match(desk, /if \(cancelled\) return;/);
});

test('the seed only ever suggests a box, it never writes one', () => {
  const seed = between(desk, '// An empty location suggests', '// The switches the batch row has no column for');
  assert.doesNotMatch(seed, /setDefaults\(/, 'no defaults write in the seed watcher');
  assert.match(seed, /const boxSuggestion = createMemo\(\(\) => locationSuggestion\(\{/);
  assert.match(desk, /suggestion=\{boxSuggestion\(\)\}/);
  // The suggestion answer fills the box menu of every batch, once per batch.
  assert.match(seed, /if \(boxesAsked === batchId\) return undefined;/);
  // Clearing or typing switches the seed off for the batch, across reloads.
  assert.match(desk, /rememberBatchFlag\('locationTouched', true\)/);
  assert.match(bars, /props\.onTouched\?\.\(\)/);
  assert.match(state, /if \(touched\) return ''/);
});

test('a typed location is applied before a scan or a search add uses the old one', () => {
  // The flush sits in the stream event loop for scans…
  const added = between(desk, "if (event.type === 'added') {", "if (event.type === 'added' && item)");
  assert.match(added, /void flushLocationDraft\(\)/);
  // …and is awaited before the row is created from the search draft.
  const commit = between(desk, 'async function commitDraft(', 'function applyAttribute(');
  assert.ok(commit.indexOf('await flushLocationDraft()') < commit.indexOf('scanApi.add('));
  assert.match(commit, /location: String\(untrack\(defaults\)\.location \|\| ''\)/);
  // Blur, Enter and the pause still commit as before, through the same rule.
  assert.match(bars, /setEditingField\(''\);\s*\n\s*setBoxMenuOpen\(false\);\s*\n\s*commitLocation\(\)/);
  assert.match(bars, /const t = setTimeout\(\(\) => applyLocation\(draft\), 700\)/);
  assert.match(bars, /props\.api\?\.\(\{ commitLocation \}\)/);
  assert.match(desk, /api=\{\(api\) => \{ defaultsBar = api; \}\}/);
});

test('the seller keeps a field they are typing and a draft never applies twice', () => {
  assert.match(bars, /draftValue\(\{ focused: editingField\(\) === 'location', draft: current, serverValue: location \}\)/);
  assert.match(bars, /if \(draft === location \|\| draft === locationSent\) return undefined;/);
  // The old unguarded write of the draft, and the copy over the typed text.
  assert.doesNotMatch(bars, /props\.onChange\(\{ location: draft \}\)/);
  assert.doesNotMatch(bars, /setLocationDraft\(location\)/);
});

test('defaults can be switched off and an off control is greyed but stays reachable', () => {
  assert.match(bars, /chooseStackOff/);
  assert.match(bars, /props\.onChange\(STACK_OFF_PATCH, \{ stackOff: true \}\)/);
  assert.match(bars, /props\.onChange\(\{ stackSize: nextSize \}, \{ stackOff: false \}\)/);
  // Emptying "Cards per stack" is the Off choice, not "keep the old number".
  assert.match(bars, /const decision = sizeCommit\(sizeDraft\(\)\)/);
  assert.match(bars, /if \(decision\.kind === 'off'\) return chooseStackOff\(\)/);
  // Rows keep the plain box name: the desk hands the Loc column no slot at all.
  assert.match(desk, /const rowSlots = createMemo\(\(\) => displaySlots\(slots\(\), \{ off: stackOff\(\) \}\)\)/);
  assert.match(desk, /slot=\{rowSlots\(\)\.get\(row\(\)\.id\)\}/);
  // Greyed: the gear loses its number, the stack fields lose their text.
  assert.match(bars, /<Show when=\{gear\(\)\.showSize\}><b class="sd-gear-size"/);
  assert.match(bars, /readOnly=\{gear\(\)\.greyed\}/);
  assert.match(bars, /aria-disabled=\{String\(gear\(\)\.greyed\)\}/);
  assert.doesNotMatch(bars, /disabled=\{gear\(\)\.greyed\}/, 'a disabled field cannot be focused');
  // …and the CSS greys them without hiding anything.
  assert.match(css, /\.sd-location\.is-off/);
  assert.match(css, /\.sd-gear\.is-off/);
  assert.match(css, /\.sd-stack-menu input\[aria-disabled="true"\]/);
});

test('the stack setup switch is remembered per batch and read back on load', () => {
  assert.match(desk, /function rememberStackOff\(next\)/);
  assert.match(desk, /rememberBatchFlag\('stackOff', Boolean\(next\)\)/);
  assert.match(desk, /setStackOff\(batchFlag\(batchFlags, batchId \|\| '', 'stackOff'\)\)/);
  assert.match(state, /export const BATCH_FLAGS_KEY = 'scan:batch-defaults'/);
});
