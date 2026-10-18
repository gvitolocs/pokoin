import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The next box slot is the server's (pokoin-rust commerce domain/box_slots.rs):
// it counts every game and active, paused and inactive rows. The desks used to
// rebuild it from /api/marketplace-listings, which is scoped to the host's
// game, capped at 1,000 rows by price, and then filtered to active/paused.
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const form = read('./components/desk/ListingForm.jsx');
const scan = read('./pages/ScanDesk.jsx');

test('the listing form takes its box and slot from the server box slots', () => {
  assert.match(form, /fetchSellerBoxSlots\(owner, token, \{ stackSize: 80/);
  assert.match(form, /nextBoxLocation\(stockBoxes\(\), current\)/);
  assert.doesNotMatch(form, /fetchSellerListings|liveInventoryListings/);
  // After a save the boxes reload, so the next card does not reuse the slot.
  assert.match(form, /setStockVersion\(\(n\) => n \+ 1\)/);
  assert.match(form, /\$\{stockVersion\(\)\}/);
});

test('an edit keeps the stored location unless the server said where the listing is', () => {
  // Desk offers are public rows without a location; the form asks by id.
  assert.match(form, /fetchSellerBoxSlots\(owner, token, \{ stackSize: 80, \.\.\.\(id \? \{ id \} : \{\}\) \}\)/);
  assert.match(form, /!editing \|\| \(stockReady\(\) && ownLocation\(\) !== null\) \? \{ location: locationValue\(\) \} : \{\}/);
});

test('the scan desk cursor and box stock come from the server box slots', () => {
  assert.equal((scan.match(/fetchSellerBoxSlots\(/g) || []).length, 3);
  assert.doesNotMatch(scan, /fetchSellerListings|liveInventoryListings|continueBoxCursor/);
  assert.match(scan, /const next = data\?\.next;/);
});
