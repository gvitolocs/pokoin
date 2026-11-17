import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Where the next card of a box goes is one model function — `nextFreeStackPosition`
// (market/src/scan-model.js): the first stack at or after the cursor with a free
// position, so a card never lands on position 1 of a stack that already holds
// cards. The answers themselves are tested in market/src/scan-model.test.js and
// market/src/inventory-listings.test.js; these asserts keep every desk cursor
// path wired to it.

const here = path.dirname(fileURLToPath(import.meta.url));
const desk = fs.readFileSync(path.join(here, '..', 'ScanDesk.jsx'), 'utf8');
const bars = fs.readFileSync(path.join(here, 'bars.jsx'), 'utf8');

test('typing a stack takes the stack and position the desk answers with', () => {
  assert.match(bars, /props\.cursorForStack\(n\)/);
  assert.match(desk, /cursorForStack=\{cursorForStack\}/);
  // commitStack used to roll a full stack over to position 1 of the next one.
  assert.doesNotMatch(bars, /n \+ 1, startPosition: 1/);
});

test('every cursor path asks what the stack holds before settling', () => {
  // One helper (stock in the box + this batch) behind the typed stack, the
  // location change and the reload.
  assert.match(desk, /return nextFreeStackPosition\(/);
  assert.equal((desk.match(/cursorForBox\(/g) || []).length, 4, 'definition + typed stack + location + reload');
});

test('the automatic advance reads the occupied stacks and names the divider', () => {
  assert.match(desk, /const occupancy = createMemo\(\(\) => occupancyForScanBoxes\(list\(\), boxStockRows\(\)\)\)/);
  assert.equal((desk.match(/nextBoxPositions\(rowsNow, \{ occupiedAbs: occupied, occupancy: boxesOccupancy \}\)/g) || []).length, 2);
  // The toast names the divider that filled, not the stack the card started in.
  assert.match(desk, /Stack \$\{slotFilledStackNumber\(slot\)\} full — next divider/);
});
